import type { AgentId, PlannedTask, ProcessingPlan, SchedulerPolicy } from '../agents/types';
import type { AgentExecutionStatus, Checkpoint, QAIssue } from '../../types/domain';
import { AGENT_MAP, AGENT_REGISTRY } from '../agents/registry';

export const DEFAULT_8GB_POLICY: SchedulerPolicy = {
  maxConcurrentHeavyModels: 1,
  maxConcurrentLightweightTasks: 2,
  availableRamGb: 8,
  allowTwoHeavyOnlyAboveGb: 12,
};

export interface PlanProgressSummary {
  total: number;
  completed: number;
  completedWithWarnings: number;
  needsReview: number;
  waitingForModel: number;
  notIntegrated: number;
  failed: number;
  running: number;
  waiting: number;
  percentCompleted: number;
}

/**
 * Deterministic Kahn's topological sort verifying the 25-agent DAG has zero cycles
 * and producing an explicit dependency-safe execution order.
 */
export function computeTopologicalOrder(): AgentId[] {
  const inDegree = new Map<AgentId, number>();
  const adjacency = new Map<AgentId, AgentId[]>();

  for (const agent of AGENT_REGISTRY) {
    inDegree.set(agent.id, 0);
    adjacency.set(agent.id, []);
  }

  for (const agent of AGENT_REGISTRY) {
    for (const dep of agent.dependsOn) {
      adjacency.get(dep)?.push(agent.id);
      inDegree.set(agent.id, (inDegree.get(agent.id) ?? 0) + 1);
    }
  }

  const queue: AgentId[] = AGENT_REGISTRY.filter((a) => (inDegree.get(a.id) ?? 0) === 0)
    .sort((a, b) => a.number - b.number)
    .map((a) => a.id);

  const ordered: AgentId[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    ordered.push(current);
    const nextNodes = adjacency.get(current) ?? [];
    for (const nextId of nextNodes) {
      const remaining = (inDegree.get(nextId) ?? 1) - 1;
      inDegree.set(nextId, remaining);
      if (remaining === 0) {
        queue.push(nextId);
        queue.sort((a, b) => AGENT_MAP[a].number - AGENT_MAP[b].number);
      }
    }
  }

  if (ordered.length !== AGENT_REGISTRY.length) {
    throw new Error(
      `Invalid 25-agent dependency graph: resolved ${ordered.length} of ${AGENT_REGISTRY.length} agents (cycle detected).`
    );
  }

  return ordered;
}

/**
 * Resolves effective heavy-model concurrency limit respecting 8 GB RAM safety discipline.
 * Only permits 2 heavy models if user requested 2 AND device RAM meets or exceeds threshold.
 */
export function resolveEffectiveHeavyConcurrency(policy: SchedulerPolicy): 1 | 2 {
  if (policy.maxConcurrentHeavyModels <= 1) return 1;
  if (policy.availableRamGb !== null && policy.availableRamGb >= policy.allowTwoHeavyOnlyAboveGb) {
    return 2;
  }
  return 1;
}

/**
 * Classifies whether an execution error is transient/recoverable (eligible for bounded retry
 * with exponential backoff) vs permanent (e.g. missing model, invalid media, quota/permission).
 */
export function classifyErrorRecoverability(errorMessage: string): {
  recoverable: boolean;
  category:
    | 'transient_network'
    | 'transient_runtime'
    | 'permanent_missing_model'
    | 'permanent_invalid_input'
    | 'permanent_quota'
    | 'cancelled';
} {
  const msg = (errorMessage || '').toLowerCase();
  if (/abort|cancel/.test(msg)) {
    return { recoverable: false, category: 'cancelled' };
  }
  if (/quotaexceeded|out of storage|disk full/.test(msg)) {
    return { recoverable: false, category: 'permanent_quota' };
  }
  if (/not installed|download.*first|waiting_for_model|cache.*missing|evicted/.test(msg)) {
    return { recoverable: false, category: 'permanent_missing_model' };
  }
  if (/unsupported|corrupt|invalid.*wav|empty.*text|could not extract pcm|no imported media/.test(msg)) {
    return { recoverable: false, category: 'permanent_invalid_input' };
  }
  if (/429|500|502|503|504|timeout|timed out|network|fetch failed|rate limit|temporarily|overloaded|econnreset/.test(msg)) {
    return { recoverable: true, category: 'transient_network' };
  }
  if (/wasm|memory|transaction|indexeddb|busy|lock/.test(msg)) {
    return { recoverable: true, category: 'transient_runtime' };
  }
  return { recoverable: false, category: 'permanent_invalid_input' };
}

/**
 * Computes bounded exponential backoff delay in milliseconds for transient retries.
 */
export function computeRetryBackoffMs(retryAttempt: number, baseMs: number = 450): number {
  const safeAttempt = Math.max(0, Math.min(5, retryAttempt));
  return Math.min(8000, Math.round(baseMs * Math.pow(2, safeAttempt)));
}

/**
 * Builds an explicit dependency-aware ProcessingPlan, optionally resuming from either
 * a valid Checkpoint object or a verified list of completed Agent IDs.
 */
export function createProcessingPlan(
  projectId: string,
  checkpointOrCompletedIds: Checkpoint | AgentId[] | null = null,
  explicitCheckpointId: string | null = null
): ProcessingPlan {
  const topologicalOrder = computeTopologicalOrder();
  let completedList: AgentId[] = [];
  let resumedFromCheckpointId: string | null = explicitCheckpointId;

  if (Array.isArray(checkpointOrCompletedIds)) {
    completedList = checkpointOrCompletedIds;
  } else if (checkpointOrCompletedIds && checkpointOrCompletedIds.valid) {
    completedList = checkpointOrCompletedIds.completedAgentIds as AgentId[];
    resumedFromCheckpointId = checkpointOrCompletedIds.id;
  }

  const completedSet = new Set<AgentId>(completedList);
  const tasks = {} as Record<AgentId, PlannedTask>;

  for (const agentId of topologicalOrder) {
    const def = AGENT_MAP[agentId];
    const alreadyDone = completedSet.has(agentId);
    const depsSatisfied = def.dependsOn.every((dep) => completedSet.has(dep));

    let status: AgentExecutionStatus = 'waiting';
    if (alreadyDone) {
      status = 'completed';
    } else if (depsSatisfied) {
      status = 'ready';
    }

    tasks[agentId] = {
      agentId,
      status,
      dependsOn: [...def.dependsOn],
      memoryTier: def.memoryTier,
      retryCount: 0,
      maxRetries: def.memoryTier === 'heavy_ai_model' ? 2 : 1,
      lastRetryReason: null,
      executionEngine: null,
      startedAt: null,
      completedAt: alreadyDone ? new Date().toISOString() : null,
      outputSummary: alreadyDone ? 'Restored from verified local checkpoint.' : '',
      errorMessage: null,
    };
  }

  return {
    planId: `plan_${projectId}_${Date.now()}`,
    projectId,
    createdAt: new Date().toISOString(),
    topologicalOrder,
    tasks,
    resumedFromCheckpointId,
  };
}

const DEPENDENCY_SATISFIED_STATES: ReadonlySet<AgentExecutionStatus> = new Set([
  'completed',
  'completed_with_warnings',
  'needs_review',
]);

/**
 * Returns the next batch of tasks that can run immediately without violating DAG dependencies
 * or heavy-model RAM concurrency caps. Safe independent lightweight tasks may run in parallel.
 */
export function selectNextExecutableTasks(
  plan: ProcessingPlan,
  policy: SchedulerPolicy
): AgentId[] {
  const maxHeavy = resolveEffectiveHeavyConcurrency(policy);
  const maxLight = Math.max(1, policy.maxConcurrentLightweightTasks);

  let runningHeavy = 0;
  let runningLight = 0;

  for (const id of plan.topologicalOrder) {
    const task = plan.tasks[id];
    if (task.status === 'running') {
      if (task.memoryTier === 'heavy_ai_model') runningHeavy += 1;
      else runningLight += 1;
    }
  }

  const batch: AgentId[] = [];
  for (const id of plan.topologicalOrder) {
    const task = plan.tasks[id];
    if (task.status !== 'waiting' && task.status !== 'ready') continue;

    const allDepsMet = task.dependsOn.every((depId) =>
      DEPENDENCY_SATISFIED_STATES.has(plan.tasks[depId].status)
    );
    if (!allDepsMet) continue;

    if (task.memoryTier === 'heavy_ai_model') {
      if (runningHeavy < maxHeavy) {
        batch.push(id);
        runningHeavy += 1;
      }
    } else if (runningLight < maxLight) {
      batch.push(id);
      runningLight += 1;
    }
  }

  return batch;
}

/** Compatibility alias used by orchestrator and tests. */
export const selectNextEligibleTasks = selectNextExecutableTasks;

/**
 * Invalidates all transitive downstream dependent tasks when an upstream agent re-runs
 * or is scheduled for QA correction, preventing stale downstream outputs.
 */
export function invalidateDownstreamTasks(
  plan: ProcessingPlan,
  changedAgentId: AgentId
): AgentId[] {
  const invalidated = new Set<AgentId>();
  const queue: AgentId[] = [changedAgentId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const candidateId of plan.topologicalOrder) {
      if (invalidated.has(candidateId)) continue;
      if (plan.tasks[candidateId].dependsOn.includes(current)) {
        invalidated.add(candidateId);
        queue.push(candidateId);
      }
    }
  }

  for (const targetId of invalidated) {
    const t = plan.tasks[targetId];
    t.status = 'waiting';
    t.completedAt = null;
    t.outputSummary = `Invalidated after upstream update (${changedAgentId}).`;
    t.errorMessage = null;
  }

  for (const id of plan.topologicalOrder) {
    const t = plan.tasks[id];
    if (t.status === 'waiting') {
      const depsMet = t.dependsOn.every((d) => DEPENDENCY_SATISFIED_STATES.has(plan.tasks[d].status));
      if (depsMet) t.status = 'ready';
    }
  }

  return Array.from(invalidated);
}

/**
 * Validates that a checkpoint's completedAgentIds are self-consistent with real prerequisite
 * artifacts present in storage; prunes any completed stage whose upstream dependency or
 * required artifact is missing so resume starts cleanly from the earliest missing prerequisite.
 */
export function validateCheckpointPrerequisites(
  completedAgentIds: AgentId[],
  missingArtifactAgents: Set<AgentId>
): {
  valid: boolean;
  prunedCompletedIds: AgentId[];
  earliestInvalidatedAgent: AgentId | null;
} {
  const order = computeTopologicalOrder();
  const completedSet = new Set<AgentId>(completedAgentIds);
  const pruned: AgentId[] = [];
  const validSet = new Set<AgentId>();
  let earliestInvalidatedAgent: AgentId | null = null;

  for (const agentId of order) {
    if (!completedSet.has(agentId)) continue;
    const def = AGENT_MAP[agentId];
    const missingArtifact = missingArtifactAgents.has(agentId);
    const depsValid = def.dependsOn.every((dep) => validSet.has(dep));

    if (missingArtifact || !depsValid) {
      if (!earliestInvalidatedAgent) earliestInvalidatedAgent = agentId;
      continue;
    }
    validSet.add(agentId);
    pruned.push(agentId);
  }

  return {
    valid: earliestInvalidatedAgent === null,
    prunedCompletedIds: pruned,
    earliestInvalidatedAgent,
  };
}

/**
 * Maps recoverable QA issues to the ordered set of responsible Agents that should run in
 * a bounded QA -> Correction -> Re-QA cycle.
 */
export function determineQACorrectionTargets(issues: QAIssue[]): AgentId[] {
  const targets = new Set<AgentId>();

  for (const issue of issues) {
    if (issue.resolved) continue;
    if (issue.resolutionState === 'manual_review_required') continue;

    switch (issue.category) {
      case 'pronunciation':
        targets.add('pronunciation');
        targets.add('translation');
        break;
      case 'voice':
        targets.add('voice_assignment');
        break;
      case 'timing':
        if (issue.responsibleAgent === 'synchronization' || /timing|shift|duration|adjust/i.test(issue.message)) {
          targets.add('synchronization');
        }
        break;
      case 'audio_quality':
        if (/clipping|mix|loudness/i.test(issue.message)) {
          targets.add('audio_mixing');
        }
        break;
      default:
        break;
    }
  }

  const order = computeTopologicalOrder();
  return order.filter((id) => targets.has(id));
}

export function markTaskOutcome(
  plan: ProcessingPlan,
  agentId: AgentId,
  status: AgentExecutionStatus,
  outputSummary: string,
  errorMessage: string | null = null,
  executionEngine?: string | null
): ProcessingPlan {
  const now = new Date().toISOString();
  const updatedTasks: Record<AgentId, PlannedTask> = { ...plan.tasks };
  updatedTasks[agentId] = {
    ...updatedTasks[agentId],
    status,
    completedAt: now,
    outputSummary,
    errorMessage,
    executionEngine: executionEngine ?? updatedTasks[agentId].executionEngine ?? null,
  };

  for (const id of plan.topologicalOrder) {
    if (updatedTasks[id].status === 'waiting') {
      const depsMet = updatedTasks[id].dependsOn.every((depId) =>
        DEPENDENCY_SATISFIED_STATES.has(updatedTasks[depId].status)
      );
      if (depsMet) {
        updatedTasks[id] = { ...updatedTasks[id], status: 'ready' };
      }
    }
  }

  return {
    ...plan,
    tasks: updatedTasks,
  };
}

/**
 * Summarizes plan progress honestly. Never counts 'not_integrated' or 'waiting_for_model'
 * agents as completed.
 */
export function summarizePlanProgress(plan: ProcessingPlan): PlanProgressSummary {
  const total = plan.topologicalOrder.length;
  let completed = 0;
  let completedWithWarnings = 0;
  let needsReview = 0;
  let waitingForModel = 0;
  let notIntegrated = 0;
  let failed = 0;
  let running = 0;
  let waiting = 0;

  for (const id of plan.topologicalOrder) {
    const st = plan.tasks[id].status;
    if (st === 'completed') completed += 1;
    else if (st === 'completed_with_warnings') completedWithWarnings += 1;
    else if (st === 'needs_review') needsReview += 1;
    else if (st === 'waiting_for_model') waitingForModel += 1;
    else if (st === 'not_integrated') notIntegrated += 1;
    else if (st === 'failed') failed += 1;
    else if (st === 'running') running += 1;
    else waiting += 1;
  }

  const finishedUseful = completed + completedWithWarnings + needsReview;
  const percentCompleted = total > 0 ? Math.round((finishedUseful / total) * 100) : 0;

  return {
    total,
    completed,
    completedWithWarnings,
    needsReview,
    waitingForModel,
    notIntegrated,
    failed,
    running,
    waiting,
    percentCompleted,
  };
}

export function getPlanProgressPercent(plan: ProcessingPlan): number {
  return summarizePlanProgress(plan).percentCompleted;
}

export function serializeCheckpointCompletedIds(plan: ProcessingPlan): AgentId[] {
  return plan.topologicalOrder.filter((id) => {
    const st = plan.tasks[id].status;
    return st === 'completed' || st === 'completed_with_warnings' || st === 'needs_review';
  });
}
