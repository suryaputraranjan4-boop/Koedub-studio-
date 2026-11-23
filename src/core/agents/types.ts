import type { AgentExecutionStatus } from '../../types/domain';

export type AgentId =
  | 'master_orchestrator'
  | 'media_analyzer'
  | 'scene_detection'
  | 'frame_extraction'
  | 'face_detection'
  | 'character_tracking'
  | 'speaker_diarization'
  | 'voice_analysis'
  | 'face_voice_matching'
  | 'character_memory'
  | 'relationship_intelligence'
  | 'japanese_asr'
  | 'translation'
  | 'context_intelligence'
  | 'pronunciation'
  | 'emotion_detection'
  | 'voice_assignment'
  | 'hindi_tts'
  | 'voice_acting'
  | 'synchronization'
  | 'sound_classification'
  | 'audio_separation'
  | 'audio_mixing'
  | 'quality_assurance'
  | 'recovery_resource_manager';

export type PipelineStageGroup =
  | 'Orchestration & Resilience'
  | 'Media Ingestion & Structure'
  | 'Visual & Speaker Intelligence'
  | 'Identity & Memory'
  | 'Language, Context & Emotion'
  | 'Voice & Timing Synthesis'
  | 'Audio Preservation, Mixing & QA';

export type AgentMemoryTier = 'lightweight' | 'heavy_ai_model' | 'dsp_chunked';

export type IntegrationMilestone =
  | 'Prompt 1 (Foundation Operational)'
  | 'Prompt 2 (AI Intelligence Integrated)'
  | 'Prompt 3 (Audio Production Operational)'
  | 'Prompt 3 (Audio Production Pending)';

export interface AgentContext {
  projectId: string;
  jobId: string;
  signal: AbortSignal;
  upstreamOutputs: Partial<Record<AgentId, AgentExecutionPayload>>;
  reportProgress: (percent: number, detail: string) => void;
}

export interface AgentExecutionPayload {
  agentId: AgentId;
  status:
    | 'completed'
    | 'completed_with_warnings'
    | 'not_integrated'
    | 'failed'
    | 'cancelled'
    | 'needs_review'
    | 'waiting_for_model';
  summary: string;
  data?: Record<string, unknown>;
  errorMessage?: string;
  checkpointEligible: boolean;
}

export interface AgentDefinition {
  number: number; // 1 through 25
  id: AgentId;
  name: string;
  stageGroup: PipelineStageGroup;
  responsibility: string;
  inputContract: string;
  outputContract: string;
  dependsOn: AgentId[];
  memoryTier: AgentMemoryTier;
  estimatedPeakRamMb: number;
  integrationMilestone: IntegrationMilestone;
  isIntegratedInPrompt1: boolean;
  isIntegrated: boolean;
  requiredModelId?: string;
  cancellationStrategy: string;
  recoveryStrategy: string;
}

export interface PlannedTask {
  agentId: AgentId;
  status: AgentExecutionStatus;
  dependsOn: AgentId[];
  memoryTier: AgentMemoryTier;
  retryCount: number;
  maxRetries: number;
  startedAt: string | null;
  completedAt: string | null;
  outputSummary: string;
  errorMessage: string | null;
}

export interface ProcessingPlan {
  planId: string;
  projectId: string;
  createdAt: string;
  topologicalOrder: AgentId[];
  tasks: Record<AgentId, PlannedTask>;
  resumedFromCheckpointId: string | null;
}

export interface SchedulerPolicy {
  maxConcurrentHeavyModels: 1 | 2;
  maxConcurrentLightweightTasks: number;
  availableRamGb: number | null;
  allowTwoHeavyOnlyAboveGb: number;
}
