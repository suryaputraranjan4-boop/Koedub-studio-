import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_REGISTRY } from '../agents/registry';
import {
  computeTopologicalOrder,
  createProcessingPlan,
  DEFAULT_8GB_POLICY,
  resolveEffectiveHeavyConcurrency,
  selectNextEligibleTasks,
  summarizePlanProgress,
} from './scheduler';

test('agent registry defines exactly 25 unique logical agents numbered 1..25', () => {
  assert.equal(AGENT_REGISTRY.length, 25);
  const numbers = AGENT_REGISTRY.map((a) => a.number).sort((a, b) => a - b);
  assert.deepEqual(
    numbers,
    Array.from({ length: 25 }, (_, i) => i + 1)
  );
  const uniqueIds = new Set(AGENT_REGISTRY.map((a) => a.id));
  assert.equal(uniqueIds.size, 25);
});

test('topological sort orders all 25 agents without cycles and respects dependencies', () => {
  const order = computeTopologicalOrder();
  assert.equal(order.length, 25);
  const position = new Map(order.map((id, idx) => [id, idx]));

  for (const agent of AGENT_REGISTRY) {
    for (const dep of agent.dependsOn) {
      assert.ok(
        (position.get(dep) ?? 999) < (position.get(agent.id) ?? -1),
        `Expected dependency ${dep} before ${agent.id}`
      );
    }
  }
});

test('8 GB RAM policy defaults to max 1 heavy model concurrently', () => {
  assert.equal(resolveEffectiveHeavyConcurrency(DEFAULT_8GB_POLICY), 1);

  // Even if user toggles 2 heavy models, an 8 GB device stays constrained to 1
  assert.equal(
    resolveEffectiveHeavyConcurrency({
      ...DEFAULT_8GB_POLICY,
      maxConcurrentHeavyModels: 2,
      availableRamGb: 8,
    }),
    1
  );

  // Only allows 2 when device RAM meets or exceeds threshold (12 GB)
  assert.equal(
    resolveEffectiveHeavyConcurrency({
      ...DEFAULT_8GB_POLICY,
      maxConcurrentHeavyModels: 2,
      availableRamGb: 16,
    }),
    2
  );
});

test('scheduler resumes from valid checkpoint without re-running completed agents', () => {
  const plan = createProcessingPlan('proj_test', {
    id: 'ckpt_1',
    projectId: 'proj_test',
    jobId: 'job_1',
    stageAgentId: 'media_analyzer',
    completedAgentIds: [
      'master_orchestrator',
      'recovery_resource_manager',
      'media_analyzer',
    ],
    savedAt: '2026-11-22T00:00:00.000Z',
    valid: true,
    notes: 'Test checkpoint',
  });

  assert.equal(plan.tasks.master_orchestrator.status, 'completed');
  assert.equal(plan.tasks.media_analyzer.status, 'completed');
  assert.equal(plan.tasks.scene_detection.status, 'ready');
  assert.equal(plan.tasks.speaker_diarization.status, 'ready');
  assert.equal(plan.tasks.sound_classification.status, 'ready');

  const next = selectNextEligibleTasks(plan, DEFAULT_8GB_POLICY);
  // Must NOT include already-completed agents
  assert.ok(!next.includes('master_orchestrator'));
  assert.ok(!next.includes('media_analyzer'));

  // Under 8 GB policy, at most 1 heavy_ai_model agent may be scheduled at once
  const heavyCount = next.filter(
    (id) => plan.tasks[id].memoryTier === 'heavy_ai_model'
  ).length;
  assert.equal(heavyCount, 1);
});

test('progress summary never counts not_integrated agents as completed', () => {
  const plan = createProcessingPlan('proj_test', null);
  plan.tasks.master_orchestrator.status = 'completed';
  plan.tasks.japanese_asr.status = 'not_integrated';
  plan.tasks.hindi_tts.status = 'not_integrated';

  const summary = summarizePlanProgress(plan);
  assert.equal(summary.completed, 1);
  assert.equal(summary.notIntegrated, 2);
  assert.equal(summary.percentCompleted, 4);
});
