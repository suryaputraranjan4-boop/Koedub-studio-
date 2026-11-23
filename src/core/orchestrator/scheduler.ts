import { AGENT_MAP, AGENT_REGISTRY } from '../agents/registry';
import type {
  AgentId,
  PlannedTask,
  ProcessingPlan,
  SchedulerPolicy,
} from '../agents/types';
import type { Checkpoint } from '../../types/domain';

export const DEFAULT_8GB_POLICY: SchedulerPolicy = {
  maxConcurrentHeavyModels: 1,
  maxConcurrentLightweightTasks: 3,
  availableRamGb: 8,
  allowTwoHeavyOnlyAboveGb: 12,
};

/**
 * Computes a deterministic topological order of all 25 agents.
 * Throws if any cycle or missing dependency exists in the DAG.
 */
export function computeTopologicalOrder(): AgentId[] {
  const inDegree = new Map<AgentId, number>();
  const adjacency = new Map<AgentId, AgentId[]>();

  for (const agent of AGENT_REGISTRY) {
    inDegree.set(agent.id, agent.dependsOn.length);
    adjacency.set(agent.id, []);
  }

  for (const agent of AGENT_REGISTRY) {
    for (const dep of agent.dependsOn) {
      if (!AGENT_MAP[dep]) {
        throw new Error(`Unknown dependency '${dep}' on agent '${agent.id}'`);
      }
      adjacency.get(dep)!.push(agent.id);
    }
  }

  const queue: AgentId[] = [];
  for (const agent of AGENT_REGISTRY) {
    if (inDegree.get(agent.id) === 0) {
      queue.push(agent.id);
    }
  }

  const order: AgentId[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);

    for (const neighbor of adjacency.get(current) ?? []) {
      const nextDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, nextDegree);
      if (nextDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (order.length !== AGENT_REGISTRY.length) {
    throw new Error(
      `Dependency cycle detected in agent graph: ordered ${order.length} of ${AGENT_REGISTRY.length}`
    );
  }

  return order;
}

/**
 * Resolves effective max heavy AI model concurrency based on device RAM measurements.
 * Defaults to 1 on 8 GB Android devices; allows 2 only when policy explicitly permits
 * AND measured RAM justifies it.
 */
export function resolveEffectiveHeavyConcurrency(policy: SchedulerPolicy): 1 | 2 {
  if (policy.maxConcurrentHeavyModels === 1) {
    return 1;
  }
  if (
    policy.availableRamGb !== null &&
    policy.availableRamGb >= policy.allowTwoHeavyOnlyAboveGb
  ) {
    return 2;
  }
  return 1;
}

/**
 * Creates a fresh or checkpoint-resumed ProcessingPlan for a project.
 */
export function createProcessingPlan(
  projectId: string,
  checkpoint: Checkpoint | null = null
): ProcessingPlan {
  const topologicalOrder = computeTopologicalOrder();
  const completedSet = new Set<string>(
    checkpoint && checkpoint.valid ? checkpoint.completedAgentIds : []
  );

  const tasks = {} as Record<AgentId, PlannedTask>;

  for (const agentId of topologicalOrder) {
    const def = AGENT_MAP[agentId];
    const alreadyCompleted = completedSet.has(agentId);

    tasks[agentId] = {
      agentId,
      status: alreadyCompleted ? 'completed' : 'waiting',
      dependsOn: [...def.dependsOn],
      memoryTier: def.memoryTier,
      retryCount: 0,
      maxRetries: def.memoryTier === 'heavy_ai_model' ? 2 : 1,
      startedAt: null,
      completedAt: alreadyCompleted ? checkpoint?.savedAt ?? null : null,
      outputSummary: alreadyCompleted
        ? `Restored from checkpoint ${checkpoint?.id ?? ''}`
        : '',
      errorMessage: null,
    };
  }

  // Mark tasks whose dependencies are already satisfied as 'ready'
  for (const agentId of topologicalOrder) {
    if (tasks[agentId].status === 'waiting') {
      const depsSatisfied = tasks[agentId].dependsOn.every(
        (depId) => tasks[depId].status === 'completed'
      );
      if (depsSatisfied) {
        tasks[agentId].status = 'ready';
      }
    }
  }

  return {
    planId: `plan_${projectId}_${Date.now()}`,
    projectId,
    createdAt: new Date().toISOString(),
    topologicalOrder,
    tasks,
    resumedFromCheckpointId: checkpoint && checkpoint.valid ? checkpoint.id : null,
  };
}

const DEPENDENCY_SATISFIED_STATUSES = new Set<string>([
  'completed',
  'completed_with_warnings',
  'needs_review',
]);

/**
 * Selects the next eligible tasks respecting:
 * 1. Dependency satisfaction (all dependsOn must be 'completed', 'completed_with_warnings', or 'needs_review')
 * 2. Duplicate-execution prevention (never re-select 'running' or already settled tasks)
 * 3. 8 GB RAM concurrency constraints (max 1 heavy model by default; lightweight can run concurrently)
 */
export function selectNextEligibleTasks(
  plan: ProcessingPlan,
  policy: SchedulerPolicy
): AgentId[] {
  const maxHeavy = resolveEffectiveHeavyConcurrency(policy);

  let activeHeavy = 0;
  let activeLightweight = 0;

  for (const agentId of plan.topologicalOrder) {
    const task = plan.tasks[agentId];
    if (task.status === 'running') {
      if (task.memoryTier === 'heavy_ai_model') {
        activeHeavy += 1;
      } else {
        activeLightweight += 1;
      }
    }
  }

  const selected: AgentId[] = [];

  for (const agentId of plan.topologicalOrder) {
    const task = plan.tasks[agentId];
    if (task.status !== 'waiting' && task.status !== 'ready') {
      continue;
    }

    const allDepsDone = task.dependsOn.every((depId) =>
      DEPENDENCY_SATISFIED_STATUSES.has(plan.tasks[depId].status)
    );
    if (!allDepsDone) {
      continue;
    }

    if (task.memoryTier === 'heavy_ai_model') {
      if (activeHeavy >= maxHeavy) {
        continue;
      }
      activeHeavy += 1;
      selected.push(agentId);
    } else {
      if (activeLightweight >= policy.maxConcurrentLightweightTasks) {
        continue;
      }
      activeLightweight += 1;
      selected.push(agentId);
    }
  }

  return selected;
}

/**
 * Computes plan summary statistics truthfully.
 * Never counts 'not_integrated', 'waiting_for_model', or 'failed' tasks as 'completed'.
 */
export function summarizePlanProgress(plan: ProcessingPlan) {
  const values = Object.values(plan.tasks);
  const total = values.length;
  const completed = values.filter((t) => t.status === 'completed').length;
  const completedWithWarnings = values.filter(
    (t) => t.status === 'completed_with_warnings'
  ).length;
  const needsReview = values.filter((t) => t.status === 'needs_review').length;
  const waitingForModel = values.filter(
    (t) => t.status === 'waiting_for_model'
  ).length;
  const running = values.filter((t) => t.status === 'running').length;
  const failed = values.filter((t) => t.status === 'failed').length;
  const notIntegrated = values.filter((t) => t.status === 'not_integrated').length;
  const pending = values.filter(
    (t) => t.status === 'waiting' || t.status === 'ready'
  ).length;

  const progressedCount = completed + completedWithWarnings + needsReview;
  const percentCompleted =
    total > 0 ? Math.round((progressedCount / total) * 100) : 0;

  return {
    total,
    completed,
    completedWithWarnings,
    needsReview,
    waitingForModel,
    running,
    failed,
    notIntegrated,
    pending,
    percentCompleted,
  };
}
