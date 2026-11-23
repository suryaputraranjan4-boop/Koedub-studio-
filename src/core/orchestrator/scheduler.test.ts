import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_REGISTRY } from '../agents/registry';
import {
  classifyErrorRecoverability,
  computeRetryBackoffMs,
  computeTopologicalOrder,
  createProcessingPlan,
  DEFAULT_8GB_POLICY,
  determineQACorrectionTargets,
  invalidateDownstreamTasks,
  resolveEffectiveHeavyConcurrency,
  selectNextEligibleTasks,
  summarizePlanProgress,
  validateCheckpointPrerequisites,
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

test('classifyErrorRecoverability distinguishes transient failures from permanent errors and bounds backoff', () => {
  assert.equal(classifyErrorRecoverability('HTTP 429 rate limit exceeded').recoverable, true);
  assert.equal(classifyErrorRecoverability('Request timeout after 15000ms').recoverable, true);
  assert.equal(classifyErrorRecoverability('QuotaExceededError: IndexedDB full').recoverable, false);
  assert.equal(classifyErrorRecoverability('Corrupt WAV header / invalid format').recoverable, false);

  const b1 = computeRetryBackoffMs(1, 500);
  const b2 = computeRetryBackoffMs(2, 500);
  const b5 = computeRetryBackoffMs(5, 500);
  assert.ok(b2 > b1);
  assert.ok(b5 <= 8000);
});

test('invalidateDownstreamTasks resets dependents and validateCheckpointPrerequisites catches missing artifacts', () => {
  const plan = createProcessingPlan('proj_test', {
    id: 'ckpt_2',
    projectId: 'proj_test',
    jobId: 'job_2',
    stageAgentId: 'translation',
    completedAgentIds: [
      'master_orchestrator',
      'recovery_resource_manager',
      'media_analyzer',
      'speaker_diarization',
      'japanese_asr',
      'context_intelligence',
      'translation',
      'hindi_tts',
    ],
    savedAt: '2026-11-23T00:00:00.000Z',
    valid: true,
    notes: '',
  });

  // Invalidate translation -> downstream hindi_tts must reset from completed to ready/waiting
  const invalidated = invalidateDownstreamTasks(plan, 'translation');
  assert.ok(invalidated.includes('hindi_tts'));
  assert.notEqual(plan.tasks.hindi_tts.status, 'completed');
  assert.equal(plan.tasks.japanese_asr.status, 'completed');

  // Checkpoint prerequisite validation detects missing persisted segments/audio
  const missingCheck = validateCheckpointPrerequisites(
    ['master_orchestrator', 'recovery_resource_manager', 'media_analyzer', 'speaker_diarization', 'japanese_asr', 'hindi_tts'],
    new Set(['japanese_asr'])
  );
  assert.equal(missingCheck.valid, false);
  assert.equal(missingCheck.earliestInvalidatedAgent, 'japanese_asr');
  assert.ok(!missingCheck.prunedCompletedIds.includes('japanese_asr'));

  // QA auto-correction maps acoustic & timing defects to responsible downstream agents
  const targets = determineQACorrectionTargets([
    {
      id: 'qa_1',
      severity: 'warning',
      category: 'timing',
      segmentId: 'SEG-1',
      message: 'Timing shift exceeded preferred 300ms window',
      responsibleAgent: 'synchronization',
      resolutionState: 'open',
      resolved: false,
    },
    {
      id: 'qa_2',
      severity: 'error',
      category: 'audio_quality',
      segmentId: null,
      message: 'Master mix audio clipping detected above 0 dBFS',
      responsibleAgent: 'audio_mixing',
      resolutionState: 'open',
      resolved: false,
    },
  ]);
  assert.ok(targets.includes('synchronization'));
  assert.ok(targets.includes('audio_mixing'));
});
