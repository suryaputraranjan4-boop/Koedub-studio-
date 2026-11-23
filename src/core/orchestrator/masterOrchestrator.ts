import { AGENT_MAP } from '../agents/registry';
import type { AgentId, ProcessingPlan } from '../agents/types';
import {
  classifyErrorRecoverability,
  computeRetryBackoffMs,
  createProcessingPlan,
  determineQACorrectionTargets,
  invalidateDownstreamTasks,
  selectNextEligibleTasks,
  summarizePlanProgress,
  validateCheckpointPrerequisites,
} from './scheduler';
import {
  getAllRecords,
  getByIndex,
  getRecord,
  putManyRecords,
  putRecord,
  STORES,
  type VaultEntry,
} from '../storage/database';
import {
  buildChunkPlan,
  createMediaMetadataRecord,
  probeMediaFile,
} from '../storage/mediaInspector';
import { resourceManager } from '../resources/resourceManager';
import { localModelRuntime } from '../ai/modelRuntime';
import {
  analyzeVoiceAcoustics,
  clusterSpeakerIntervals,
  decodeMediaBlobToStereo,
  decodePcmWavBuffer,
  detectVoiceActivityChunked,
  encodeFloat32ToWavBlob,
  encodeStereoToWavBlob,
  extractMono16kChunkFromStereo,
  type DecodedAudioStereo,
  type SpeakerClusterSegment,
  type SpeechInterval,
} from '../ai/audioDsp';
import {
  computeMultimodalFaceVoiceMatches,
  detectVideoScenesFromBlob,
  extractKeyframesForScenes,
  reconstructFrameCanvasesFromBlobs,
  runMediaPipeFaceDetectionOnFrames,
  trackVisualCharacters,
  type FaceDetectionBox,
  type VisualTrackCluster,
} from '../ai/visualIntelligence';
import {
  analyzeCharacterRelationshipsFromDialogue,
  buildProjectContextSnapshot,
  deduplicateAsrChunks,
  detectEmotionHybrid,
  refineHindiWithContextAndPronunciation,
  type AsrRawChunk,
} from '../ai/languageIntelligence';
import {
  applyRealSyncToGeneratedWavBlob,
  applyVoiceActingToWavBlob,
  buildVoiceActingDirective,
  resolvePersistentCloudVoiceName,
  selectBestVoiceForCharacter,
  synthesizeHindiWavWithModel,
} from '../ai/speechSynthesis';
import {
  buildAudioStemRecord,
  classifyAudioSoundEventsChunked,
  computeRealWaveformPeaks,
  computeWaveformPeaksFromBlob,
  decodeStoredWavBlobToStereo,
  measureAcousticQAMetrics,
  measureStereoAcousticQAMetrics,
  mixFinalDubAudio,
  separateAudioStemsConservative,
  type MixDialogueClipInput,
} from '../ai/audioProduction';
import {
  executeCollaborativeIntelligence,
  runSemanticQAReviewOnSegment,
  synthesizeHindiWavViaGeminiCloud,
} from '../ai/intelligenceRouter';
import { evaluateTimingAdjustment, findOverlappingClips } from '../timeline/timelineEngine';
import type {
  AcousticQAMetrics,
  AgentExecutionRecord,
  AgentExecutionStatus,
  AppSettings,
  AudioClip,
  AudioStemRecord,
  CharacterProfile,
  CharacterSpeakerAssociation,
  Checkpoint,
  DialogueSegment,
  ExtractedFrame,
  ImportedMedia,
  MediaMetadata,
  PipelineArtifactRecord,
  ProcessingJob,
  ProcessingLog,
  Project,
  ProjectVersion,
  PronunciationEntry,
  QACheckSummaryItem,
  QAIssue,
  QAReport,
  Scene,
  SemanticQAResult,
  SoundEventRecord,
  Speaker,
  TimelineTrack,
  TranslationRecord,
  VoiceAssignment,
  VoiceCharacteristics,
  VoiceProfile,
} from '../../types/domain';

export interface OrchestratorRunCallbacks {
  onPlanUpdated?: (plan: ProcessingPlan, job: ProcessingJob) => void;
  onLogAppended?: (log: ProcessingLog) => void;
}

interface PipelineScratchContext {
  media: ImportedMedia | null;
  mediaBlob: Blob | null;
  mediaMetadata: MediaMetadata | null;
  decodedStereo: DecodedAudioStereo | null;
  scenes: Scene[];
  extractedFrames: ExtractedFrame[];
  frameCanvases: Map<string, HTMLCanvasElement>;
  faceDetections: FaceDetectionBox[];
  visualTracks: VisualTrackCluster[];
  speakerTurns: SpeakerClusterSegment[];
  speakers: Speaker[];
  speakerVoiceCharacteristics: Map<string, VoiceCharacteristics>;
  associations: CharacterSpeakerAssociation[];
  soundEvents: SoundEventRecord[];
  backgroundLeft: Float32Array | null;
  backgroundRight: Float32Array | null;
  backgroundSampleRate: number;
  usedModels: Set<string>;
  retryHistory: Array<{ agentId: AgentId; attempt: number; reason: string; timestamp: string }>;
  qaCorrectionHistory: Array<{ cycle: number; targets: AgentId[]; unresolvedBefore: number; timestamp: string }>;
  lastQAReport: QAReport | null;
}

interface SingleAgentOutcome {
  status: Extract<
    AgentExecutionStatus,
    | 'completed'
    | 'completed_with_warnings'
    | 'needs_review'
    | 'waiting_for_model'
    | 'failed'
    | 'not_integrated'
    | 'cancelled'
  >;
  outputSummary: string;
  errorMessage: string | null;
  executionEngine?: string | null;
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

class MasterOrchestratorRuntime {
  private activeControllers = new Map<string, AbortController>();

  isProjectRunning(projectId: string): boolean {
    return this.activeControllers.has(projectId);
  }

  cancelProjectJob(projectId: string): void {
    const controller = this.activeControllers.get(projectId);
    if (controller) {
      controller.abort();
    }
  }

  private async appendLog(
    projectId: string,
    jobId: string,
    agentId: AgentId | null,
    level: ProcessingLog['level'],
    message: string,
    callbacks?: OrchestratorRunCallbacks
  ): Promise<ProcessingLog> {
    const log: ProcessingLog = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      projectId,
      jobId,
      agentId,
      level,
      message,
      timestamp: new Date().toISOString(),
    };
    await putRecord(STORES.processing_logs, log);
    callbacks?.onLogAppended?.(log);
    return log;
  }

  private async saveArtifact(
    projectId: string,
    artifactType: PipelineArtifactRecord['artifactType'],
    payload: unknown
  ): Promise<void> {
    const record: PipelineArtifactRecord = {
      id: `art_${projectId}_${artifactType}`,
      projectId,
      artifactType,
      payload,
      updatedAt: new Date().toISOString(),
    };
    await putRecord(STORES.pipeline_artifacts, record);
  }

  private async loadArtifact<T>(
    projectId: string,
    artifactType: PipelineArtifactRecord['artifactType']
  ): Promise<T | null> {
    const rec = await getRecord<PipelineArtifactRecord>(
      STORES.pipeline_artifacts,
      `art_${projectId}_${artifactType}`
    );
    return rec ? (rec.payload as T) : null;
  }

  private async saveCheckpoint(
    projectId: string,
    jobId: string,
    stageAgentId: AgentId,
    plan: ProcessingPlan,
    scratch: PipelineScratchContext,
    notes: string
  ): Promise<Checkpoint> {
    const completedAgentIds = plan.topologicalOrder.filter((id) => {
      const st = plan.tasks[id].status;
      return st === 'completed' || st === 'completed_with_warnings' || st === 'needs_review';
    });
    const checkpoint: Checkpoint = {
      id: `ckpt_${projectId}_${Date.now()}`,
      projectId,
      jobId,
      stageAgentId,
      completedAgentIds,
      sourceMediaVaultKey: scratch.media?.vaultKey ?? null,
      requiredModelIds: Array.from(scratch.usedModels),
      savedAt: new Date().toISOString(),
      valid: true,
      notes,
    };
    await putRecord(STORES.checkpoints, checkpoint);
    return checkpoint;
  }

  /**
   * Decodes source media to stereo 44.1/48 kHz PCM once into scratch memory.
   * Heavy ML stages slice 16 kHz mono chunks via extractMono16kChunkFromStereo without
   * duplicating full-episode mono arrays in RAM.
   */
  private async ensureDecodedStereo(
    scratch: PipelineScratchContext
  ): Promise<DecodedAudioStereo | null> {
    if (scratch.decodedStereo) return scratch.decodedStereo;
    if (!scratch.mediaBlob) return null;
    scratch.decodedStereo = await decodeMediaBlobToStereo(
      scratch.mediaBlob,
      scratch.media?.fileExtension
    );
    return scratch.decodedStereo;
  }

  /**
   * Restores persisted intermediate artifacts and validates checkpoint prerequisites
   * (source media blob presence, model cache integrity, saved visual/audio artifacts).
   */
  private async restoreAndValidateCheckpoint(
    projectId: string,
    checkpoint: Checkpoint,
    scratch: PipelineScratchContext
  ): Promise<{
    verifiedCompletedIds: AgentId[];
    invalidationNote: string | null;
  }> {
    const missingArtifactAgents = new Set<AgentId>();
    const notes: string[] = [];

    // 1. Verify original source media still exists in file_vault
    if (checkpoint.sourceMediaVaultKey) {
      const vaultEntry = await getRecord<VaultEntry>(
        STORES.file_vault,
        checkpoint.sourceMediaVaultKey
      );
      if (!vaultEntry) {
        missingArtifactAgents.add('media_analyzer');
        notes.push('Source media blob missing from local file_vault.');
      }
    }

    // 2. Verify any models relied upon by this checkpoint are still cached in browser Cache API
    if (checkpoint.requiredModelIds && checkpoint.requiredModelIds.length > 0) {
      for (const modelId of checkpoint.requiredModelIds) {
        const integrity = await localModelRuntime.verifyModelCacheIntegrity(modelId);
        if (!integrity.cachePresent) {
          notes.push(`Model cache evicted for ${modelId}.`);
          if (modelId === 'model_mediapipe_blazeface') missingArtifactAgents.add('face_detection');
          if (modelId === 'model_pyannote_segmentation') missingArtifactAgents.add('speaker_diarization');
          if (modelId === 'model_whisper_small_onnx') missingArtifactAgents.add('japanese_asr');
          if (modelId === 'model_nllb_200_600m') missingArtifactAgents.add('translation');
          if (modelId === 'model_mms_tts_hin') missingArtifactAgents.add('hindi_tts');
        }
      }
    }

    // 3. Restore persisted tables & intermediate artifacts
    const [scenes, frames, speakers, assocs, soundEvents] = await Promise.all([
      getByIndex<Scene>(STORES.scenes, 'projectId', projectId),
      getByIndex<ExtractedFrame>(STORES.extracted_frames, 'projectId', projectId),
      getByIndex<Speaker>(STORES.speakers, 'projectId', projectId),
      getByIndex<CharacterSpeakerAssociation>(STORES.character_speaker_associations, 'projectId', projectId),
      getByIndex<SoundEventRecord>(STORES.sound_events, 'projectId', projectId),
    ]);

    scratch.scenes = scenes;
    scratch.extractedFrames = frames;
    scratch.speakers = speakers;
    scratch.associations = assocs;
    scratch.soundEvents = soundEvents;

    const savedFaces = await this.loadArtifact<FaceDetectionBox[]>(projectId, 'face_detections');
    const savedTracks = await this.loadArtifact<VisualTrackCluster[]>(projectId, 'visual_tracks');
    const savedTurns = await this.loadArtifact<SpeakerClusterSegment[]>(projectId, 'speaker_turns');
    const savedRetries = await this.loadArtifact<PipelineScratchContext['retryHistory']>(
      projectId,
      'retry_history'
    );
    const savedQaCycles = await this.loadArtifact<PipelineScratchContext['qaCorrectionHistory']>(
      projectId,
      'qa_correction_history'
    );

    if (savedFaces) scratch.faceDetections = savedFaces;
    if (savedTracks) scratch.visualTracks = savedTracks;
    if (savedTurns) scratch.speakerTurns = savedTurns;
    if (savedRetries) scratch.retryHistory = savedRetries;
    if (savedQaCycles) scratch.qaCorrectionHistory = savedQaCycles;

    const completedSet = new Set(checkpoint.completedAgentIds as AgentId[]);

    // Reconstruct frameCanvases from JPEG blobs if frames were extracted but downstream visual stages still pending
    if (
      frames.length > 0 &&
      completedSet.has('frame_extraction') &&
      (!completedSet.has('face_detection') || !completedSet.has('character_tracking'))
    ) {
      scratch.frameCanvases = await reconstructFrameCanvasesFromBlobs(frames, async (vaultKey) => {
        const entry = await getRecord<VaultEntry>(STORES.file_vault, vaultKey);
        return entry?.blob ?? null;
      });
      if (scratch.frameCanvases.size === 0) {
        missingArtifactAgents.add('frame_extraction');
        notes.push('Temporary JPEG keyframe blobs were purged; re-extracting keyframes.');
      }
    }

    // Check required artifacts for completed stages
    if (completedSet.has('speaker_diarization') && scratch.speakerTurns.length === 0 && scratch.speakers.length > 0) {
      missingArtifactAgents.add('speaker_diarization');
      notes.push('Diarized speaker turn artifact missing; re-running speaker diarization.');
    }
    if (completedSet.has('face_detection') && frames.length > 0 && !savedFaces) {
      missingArtifactAgents.add('face_detection');
      notes.push('Face detection artifact missing; re-running face detection.');
    }

    const validation = validateCheckpointPrerequisites(
      checkpoint.completedAgentIds as AgentId[],
      missingArtifactAgents
    );

    if (!validation.valid) {
      await putRecord<Checkpoint>(STORES.checkpoints, {
        ...checkpoint,
        valid: false,
        notes: `${checkpoint.notes} · Pruned on resume from ${validation.earliestInvalidatedAgent}: ${notes.join(' ')}`,
      });
    }

    return {
      verifiedCompletedIds: validation.prunedCompletedIds,
      invalidationNote: validation.valid
        ? null
        : `Checkpoint pruned at ${validation.earliestInvalidatedAgent}: ${notes.join(' ')}`,
    };
  }

  /**
   * Executes a single agent with bounded retries + exponential backoff for recoverable errors only.
   */
  private async executeAgentWithRetries(
    agentId: AgentId,
    projectId: string,
    job: ProcessingJob,
    plan: ProcessingPlan,
    settings: AppSettings,
    signal: AbortSignal,
    scratch: PipelineScratchContext,
    callbacks?: OrchestratorRunCallbacks
  ): Promise<SingleAgentOutcome> {
    const def = AGENT_MAP[agentId];
    const task = plan.tasks[agentId];
    const maxRetries = Math.max(0, task.maxRetries);

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (signal.aborted) {
        return {
          status: 'cancelled',
          outputSummary: 'Aborted before execution.',
          errorMessage: null,
        };
      }

      try {
        const outcome = await this.executeSingleAgent(
          agentId,
          projectId,
          job.jobId,
          settings,
          signal,
          scratch
        );

        // If an agent explicitly returned 'failed' with a recoverable transient error, consider retry
        if (outcome.status === 'failed' && outcome.errorMessage && attempt < maxRetries) {
          const classification = classifyErrorRecoverability(outcome.errorMessage);
          if (classification.recoverable) {
            const backoffMs = computeRetryBackoffMs(attempt);
            task.retryCount += 1;
            task.lastRetryReason = `${classification.category}: ${outcome.errorMessage}`;
            job.retryCount += 1;
            scratch.retryHistory.push({
              agentId,
              attempt: task.retryCount,
              reason: task.lastRetryReason,
              timestamp: new Date().toISOString(),
            });
            await this.saveArtifact(projectId, 'retry_history', scratch.retryHistory);
            await this.appendLog(
              projectId,
              job.jobId,
              agentId,
              'warning',
              `${def.name} transient failure (attempt ${attempt + 1}/${maxRetries + 1}): ${outcome.errorMessage} — retrying in ${backoffMs} ms.`,
              callbacks
            );
            await abortableSleep(backoffMs, signal);
            continue;
          }
        }

        return outcome;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unexpected agent execution error.';
        const classification = classifyErrorRecoverability(msg);

        if (classification.category === 'cancelled' || signal.aborted) {
          return {
            status: 'cancelled',
            outputSummary: `${def.name} cancelled cleanly at safe boundary.`,
            errorMessage: null,
          };
        }

        if (classification.recoverable && attempt < maxRetries) {
          const backoffMs = computeRetryBackoffMs(attempt);
          task.retryCount += 1;
          task.lastRetryReason = `${classification.category}: ${msg}`;
          job.retryCount += 1;
          scratch.retryHistory.push({
            agentId,
            attempt: task.retryCount,
            reason: task.lastRetryReason,
            timestamp: new Date().toISOString(),
          });
          await this.saveArtifact(projectId, 'retry_history', scratch.retryHistory);
          await this.appendLog(
            projectId,
            job.jobId,
            agentId,
            'warning',
            `${def.name} threw recoverable error (${classification.category}, attempt ${attempt + 1}/${maxRetries + 1}): ${msg} — backing off ${backoffMs} ms.`,
            callbacks
          );
          await abortableSleep(backoffMs, signal);
          continue;
        }

        return {
          status: 'failed',
          outputSummary: `${def.name} failed (${classification.category}): ${msg}`,
          errorMessage: msg,
        };
      } finally {
        if (def.memoryTier === 'heavy_ai_model') {
          await localModelRuntime.unloadActiveModel();
        }
      }
    }

    return {
      status: 'failed',
      outputSummary: `${def.name} exhausted retry budget.`,
      errorMessage: task.lastRetryReason ?? 'Retry limit exhausted.',
    };
  }

  /**
   * Runs one batch of scheduled tasks respecting heavy-model concurrency and parallelizing
   * safe independent lightweight tasks.
   */
  private async runScheduledBatch(
    eligible: AgentId[],
    projectId: string,
    job: ProcessingJob,
    plan: ProcessingPlan,
    settings: AppSettings,
    signal: AbortSignal,
    scratch: PipelineScratchContext,
    callbacks?: OrchestratorRunCallbacks
  ): Promise<void> {
    const runOne = async (agentId: AgentId) => {
      if (signal.aborted) return;
      const def = AGENT_MAP[agentId];
      const task = plan.tasks[agentId];
      const startedAt = new Date().toISOString();
      task.status = 'running';
      task.startedAt = startedAt;
      job.currentStage = def.name;
      job.updatedAt = startedAt;
      callbacks?.onPlanUpdated?.(plan, job);

      const execResult = await this.executeAgentWithRetries(
        agentId,
        projectId,
        job,
        plan,
        settings,
        signal,
        scratch,
        callbacks
      );

      const completedAt = new Date().toISOString();
      const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
      const finishedSuccessfully =
        execResult.status === 'completed' ||
        execResult.status === 'completed_with_warnings' ||
        execResult.status === 'needs_review';

      task.status = execResult.status;
      task.completedAt = finishedSuccessfully ? completedAt : null;
      task.outputSummary = execResult.outputSummary;
      task.errorMessage = execResult.errorMessage;
      task.executionEngine = execResult.executionEngine ?? task.executionEngine ?? null;

      const record: AgentExecutionRecord = {
        id: `exec_${job.jobId}_${agentId}`,
        jobId: job.jobId,
        projectId,
        agentId,
        status: execResult.status,
        startedAt,
        completedAt: finishedSuccessfully ? completedAt : null,
        durationMs,
        inputSummary: def.inputContract,
        outputSummary: execResult.outputSummary,
        errorMessage: execResult.errorMessage,
        retryCount: task.retryCount,
        lastRetryReason: task.lastRetryReason ?? null,
        executionEngine: execResult.executionEngine ?? null,
        checkpointSaved: finishedSuccessfully,
      };
      await putRecord(STORES.agent_executions, record);

      await this.appendLog(
        projectId,
        job.jobId,
        agentId,
        execResult.status === 'failed'
          ? 'error'
          : execResult.status === 'waiting_for_model' ||
            execResult.status === 'completed_with_warnings' ||
            execResult.status === 'needs_review' ||
            execResult.status === 'not_integrated'
          ? 'warning'
          : 'info',
        `${def.name}${execResult.executionEngine ? ` [${execResult.executionEngine}]` : ''}: ${execResult.outputSummary}`,
        callbacks
      );

      if (finishedSuccessfully) {
        const ckpt = await this.saveCheckpoint(
          projectId,
          job.jobId,
          agentId,
          plan,
          scratch,
          `Stage ${def.name} (${execResult.status})`
        );
        job.checkpointId = ckpt.id;
      }

      const progress = summarizePlanProgress(plan);
      job.progressPercent = progress.percentCompleted;
      job.updatedAt = completedAt;
      await putRecord(STORES.processing_jobs, job);
      callbacks?.onPlanUpdated?.(plan, job);
    };

    const heavyTasks = eligible.filter((id) => AGENT_MAP[id].memoryTier === 'heavy_ai_model');
    const lightTasks = eligible.filter((id) => AGENT_MAP[id].memoryTier !== 'heavy_ai_model');

    // Run independent lightweight tasks concurrently when safe
    if (lightTasks.length > 1) {
      await Promise.all(lightTasks.map((id) => runOne(id)));
    } else if (lightTasks.length === 1) {
      await runOne(lightTasks[0]);
    }

    // Run heavy model tasks strictly respecting 8 GB RAM isolation
    for (const id of heavyTasks) {
      if (signal.aborted) break;
      await runOne(id);
    }
  }

  /**
   * Executes the complete dependency-aware 25-agent pipeline for a project:
   * - Validates and restores checkpoints cleanly (reconstructing frames, tracks, turns).
   * - Enforces 8 GB RAM heavy-model isolation while parallelizing safe lightweight agents.
   * - Retries recoverable transient failures with bounded exponential backoff.
   * - Runs up to 2 bounded QA -> Responsible Agent Correction -> Re-QA cycles before flagging manual review.
   */
  async runProjectPipeline(
    projectId: string,
    settings: AppSettings,
    options: { resumeFromLatestCheckpoint?: boolean } = {},
    callbacks?: OrchestratorRunCallbacks
  ): Promise<{ job: ProcessingJob; plan: ProcessingPlan }> {
    if (this.activeControllers.has(projectId)) {
      throw new Error('A processing job is already running for this project.');
    }

    const project = await getRecord<Project>(STORES.projects, projectId);
    if (!project) {
      throw new Error(`Project '${projectId}' not found in local database.`);
    }

    const controller = new AbortController();
    this.activeControllers.set(projectId, controller);

    const scratch: PipelineScratchContext = {
      media: null,
      mediaBlob: null,
      mediaMetadata: null,
      decodedStereo: null,
      scenes: [],
      extractedFrames: [],
      frameCanvases: new Map(),
      faceDetections: [],
      visualTracks: [],
      speakerTurns: [],
      speakers: [],
      speakerVoiceCharacteristics: new Map(),
      associations: [],
      soundEvents: [],
      backgroundLeft: null,
      backgroundRight: null,
      backgroundSampleRate: 48000,
      usedModels: new Set(),
      retryHistory: [],
      qaCorrectionHistory: [],
      lastQAReport: null,
    };

    // Preload media references
    const mediaRecords = await getByIndex<ImportedMedia>(
      STORES.imported_media,
      'projectId',
      projectId
    );
    if (mediaRecords[0]) {
      scratch.media = mediaRecords[0];
      if (mediaRecords[0].vaultKey) {
        const entry = await getRecord<VaultEntry>(STORES.file_vault, mediaRecords[0].vaultKey);
        scratch.mediaBlob = entry?.blob ?? null;
      }
      const metaList = await getByIndex<MediaMetadata>(
        STORES.media_metadata,
        'projectId',
        projectId
      );
      scratch.mediaMetadata = metaList[0] ?? null;
    }

    const existingCheckpoints = await getByIndex<Checkpoint>(
      STORES.checkpoints,
      'projectId',
      projectId
    );
    const latestValidCheckpoint = options.resumeFromLatestCheckpoint
      ? existingCheckpoints
          .filter((c) => c.valid)
          .sort((a, b) => b.savedAt.localeCompare(a.savedAt))[0] ?? null
      : null;

    let plan: ProcessingPlan;
    let resumeNote: string | null = null;
    if (latestValidCheckpoint) {
      const restored = await this.restoreAndValidateCheckpoint(
        projectId,
        latestValidCheckpoint,
        scratch
      );
      plan = createProcessingPlan(
        projectId,
        restored.verifiedCompletedIds,
        latestValidCheckpoint.id
      );
      resumeNote = restored.invalidationNote;
    } else {
      plan = createProcessingPlan(projectId, null);
    }

    const now = new Date().toISOString();
    const job: ProcessingJob = {
      jobId: `job_${projectId}_${Date.now()}`,
      projectId,
      operationType: latestValidCheckpoint
        ? 'Resume AI Dubbing Pipeline'
        : 'AI Intelligence & Dubbing Pipeline',
      status: 'Running',
      progressPercent: summarizePlanProgress(plan).percentCompleted,
      currentStage: 'Master Orchestrator',
      startedAt: now,
      updatedAt: now,
      errorMessage: null,
      retryCount: 0,
      checkpointId: latestValidCheckpoint?.id ?? null,
      cancelled: false,
    };

    await putRecord(STORES.processing_jobs, job);
    await putRecord<Project>(STORES.projects, {
      ...project,
      status: 'processing',
      lastStageLabel: 'Master Orchestrator',
      updatedAt: now,
    });

    await this.appendLog(
      projectId,
      job.jobId,
      'master_orchestrator',
      resumeNote ? 'warning' : 'info',
      latestValidCheckpoint
        ? `Resuming 25-agent pipeline from checkpoint ${latestValidCheckpoint.id} (${
            plan.topologicalOrder.filter((id) => plan.tasks[id].status === 'completed').length
          } verified stages restored). ${resumeNote ?? ''}`.trim()
        : `Initialized complete 25-agent dependency-aware pipeline with bounded retries, stereo mastering, and 18-check QA auto-correction.`,
      callbacks
    );

    callbacks?.onPlanUpdated?.(plan, job);

    try {
      const snapshot = await resourceManager.captureSnapshot(settings);
      const policy = {
        maxConcurrentHeavyModels: settings.maxConcurrentHeavyModels,
        maxConcurrentLightweightTasks: 2,
        availableRamGb: snapshot.deviceMemoryGb,
        allowTwoHeavyOnlyAboveGb: 12,
      };

      if (snapshot.schedulerStatus === 'paused_low_resources') {
        job.status = 'Paused';
        job.errorMessage =
          'Paused safely by Recovery & Resource Manager due to low battery or low local storage.';
        job.updatedAt = new Date().toISOString();
        await putRecord(STORES.processing_jobs, job);
        await putRecord<Project>(STORES.projects, {
          ...project,
          status: 'paused',
          lastStageLabel: 'Paused (Resource Guard)',
          updatedAt: job.updatedAt,
        });
        await this.appendLog(
          projectId,
          job.jobId,
          'recovery_resource_manager',
          'warning',
          job.errorMessage,
          callbacks
        );
        callbacks?.onPlanUpdated?.(plan, job);
        return { job, plan };
      }

      // 1. Primary DAG Execution Loop
      let safetyIterations = 0;
      while (safetyIterations < 45) {
        safetyIterations += 1;
        if (controller.signal.aborted) {
          job.status = 'Cancelled';
          job.cancelled = true;
          job.updatedAt = new Date().toISOString();
          await this.appendLog(
            projectId,
            job.jobId,
            'master_orchestrator',
            'warning',
            'Processing cancelled by user. Latest valid checkpoint preserved.',
            callbacks
          );
          break;
        }

        const eligible = selectNextEligibleTasks(plan, policy);
        if (eligible.length === 0) break;

        await this.runScheduledBatch(
          eligible,
          projectId,
          job,
          plan,
          settings,
          controller.signal,
          scratch,
          callbacks
        );
      }

      // 2. Bounded QA -> Responsible Agent Correction -> Re-QA Loop (Max 2 Cycles)
      const MAX_QA_CORRECTION_CYCLES = 2;
      if (!controller.signal.aborted && scratch.lastQAReport) {
        for (let cycle = 1; cycle <= MAX_QA_CORRECTION_CYCLES; cycle += 1) {
          const targets = determineQACorrectionTargets(scratch.lastQAReport.issues);
          if (targets.length === 0) break;

          await this.appendLog(
            projectId,
            job.jobId,
            'quality_assurance',
            'warning',
            `QA Auto-Correction Cycle ${cycle}/${MAX_QA_CORRECTION_CYCLES}: routing recoverable issue(s) to [${targets.join(', ')}] and re-running dependent stages.`,
            callbacks
          );

          scratch.qaCorrectionHistory.push({
            cycle,
            targets,
            unresolvedBefore: scratch.lastQAReport.issues.filter((i) => !i.resolved).length,
            timestamp: new Date().toISOString(),
          });
          await this.saveArtifact(projectId, 'qa_correction_history', scratch.qaCorrectionHistory);

          // Invalidate target agents and all downstream dependents so stale artifacts cannot persist
          for (const targetId of targets) {
            plan.tasks[targetId].status = 'ready';
            plan.tasks[targetId].completedAt = null;
            invalidateDownstreamTasks(plan, targetId);
          }

          let corrSafety = 0;
          while (corrSafety < 25 && !controller.signal.aborted) {
            corrSafety += 1;
            const nextBatch = selectNextEligibleTasks(plan, policy);
            if (nextBatch.length === 0) break;
            await this.runScheduledBatch(
              nextBatch,
              projectId,
              job,
              plan,
              settings,
              controller.signal,
              scratch,
              callbacks
            );
          }

          if (!scratch.lastQAReport) break;
          // Persist correction cycle count on latest QA report
          scratch.lastQAReport = {
            ...scratch.lastQAReport,
            correctionCyclesRun: cycle,
          };
          await putRecord(STORES.qa_reports, scratch.lastQAReport);
        }

        // After bounded correction cycles, explicitly mark any still-unresolved issues for manual review
        if (scratch.lastQAReport && scratch.qaCorrectionHistory.length > 0) {
          const finalizedIssues: QAIssue[] = scratch.lastQAReport.issues.map((issue) =>
            issue.resolved
              ? { ...issue, resolutionState: 'auto_corrected', finalReviewStatus: 'approved' }
              : {
                  ...issue,
                  resolutionState: 'manual_review_required',
                  retryCount: scratch.qaCorrectionHistory.length,
                  finalReviewStatus: 'needs_review',
                }
          );
          scratch.lastQAReport = {
            ...scratch.lastQAReport,
            correctionCyclesRun: scratch.qaCorrectionHistory.length,
            issues: finalizedIssues,
          };
          await putRecord(STORES.qa_reports, scratch.lastQAReport);
        }
      }

      // 3. Settle remaining blocked stages truthfully
      for (const agentId of plan.topologicalOrder) {
        const task = plan.tasks[agentId];
        const def = AGENT_MAP[agentId];
        if (task.status !== 'waiting' && task.status !== 'ready') continue;

        if (!def.isIntegrated) {
          task.status = 'not_integrated';
          task.outputSummary = `${def.integrationMilestone}: not yet integrated.`;
        } else {
          const blockingDep = task.dependsOn.find(
            (depId) =>
              plan.tasks[depId].status === 'waiting_for_model' ||
              plan.tasks[depId].status === 'failed'
          );
          if (blockingDep && plan.tasks[blockingDep].status === 'waiting_for_model') {
            task.status = 'waiting_for_model';
            task.outputSummary = `Waiting on upstream stage (${AGENT_MAP[blockingDep].name}) — download required local model in Model Manager.`;
          } else {
            task.status = 'cancelled';
            task.outputSummary = blockingDep
              ? `Blocked by upstream stage failure (${AGENT_MAP[blockingDep].name}).`
              : 'Not reached in this run.';
          }
        }

        const record: AgentExecutionRecord = {
          id: `exec_${job.jobId}_${agentId}`,
          jobId: job.jobId,
          projectId,
          agentId,
          status: task.status,
          startedAt: null,
          completedAt: null,
          durationMs: null,
          inputSummary: def.inputContract,
          outputSummary: task.outputSummary,
          errorMessage: null,
          retryCount: task.retryCount,
          lastRetryReason: task.lastRetryReason ?? null,
          executionEngine: task.executionEngine ?? null,
          checkpointSaved: false,
        };
        await putRecord(STORES.agent_executions, record);
      }

      const finalStats = summarizePlanProgress(plan);
      if (job.cancelled) {
        job.status = 'Cancelled';
      } else if (finalStats.failed > 0) {
        job.status = 'Failed';
        job.errorMessage =
          'One or more AI pipeline stages failed. Inspect logs and retry from latest checkpoint.';
      } else if (finalStats.waitingForModel > 0) {
        job.status = 'Waiting for Model';
        job.currentStage = `Awaiting Offline Model Download (${finalStats.waitingForModel} stages waiting)`;
        job.errorMessage = null;
      } else if (finalStats.needsReview > 0) {
        job.status = 'Needs Review';
        job.currentStage = '25-Agent Pipeline Completed · Review Flagged Items';
        job.errorMessage = null;
      } else if (finalStats.completedWithWarnings > 0 || finalStats.notIntegrated > 0) {
        job.status = 'Completed with Warnings';
        job.currentStage = '25-Agent Pipeline Completed with Warnings';
        job.errorMessage = null;
      } else {
        job.status = 'Completed';
        job.currentStage = 'Complete Dubbing, Stereo Mixing & 18-Check QA Finished';
      }

      job.progressPercent = finalStats.percentCompleted;
      job.updatedAt = new Date().toISOString();
      await putRecord(STORES.processing_jobs, job);

      const latestProject = (await getRecord<Project>(STORES.projects, projectId)) ?? project;
      await putRecord<Project>(STORES.projects, {
        ...latestProject,
        status:
          job.status === 'Failed'
            ? 'failed'
            : job.status === 'Cancelled'
            ? 'interrupted'
            : job.status === 'Waiting for Model' || job.status === 'Needs Review'
            ? 'needs_review'
            : 'completed',
        lastCheckpointId: job.checkpointId,
        lastStageLabel: job.currentStage,
        updatedAt: job.updatedAt,
      });

      await this.appendLog(
        projectId,
        job.jobId,
        'master_orchestrator',
        'info',
        `Pipeline settled: ${finalStats.completed} completed, ${finalStats.completedWithWarnings} warnings, ${finalStats.needsReview} review, ${finalStats.waitingForModel} waiting for model, ${finalStats.failed} failed, ${job.retryCount} transient retries, ${scratch.qaCorrectionHistory.length} QA correction cycle(s).`,
        callbacks
      );

      callbacks?.onPlanUpdated?.(plan, job);
      return { job, plan };
    } finally {
      await localModelRuntime.unloadActiveModel();
      resourceManager.unloadAllModels();
      scratch.frameCanvases.clear();
      this.activeControllers.delete(projectId);
    }
  }

  private async executeSingleAgent(
    agentId: AgentId,
    projectId: string,
    jobId: string,
    settings: AppSettings,
    signal: AbortSignal,
    scratch: PipelineScratchContext
  ): Promise<SingleAgentOutcome> {
    if (signal.aborted) {
      return {
        status: 'cancelled',
        outputSummary: 'Aborted before start.',
        errorMessage: null,
      };
    }

    const def = AGENT_MAP[agentId];
    if (!def.isIntegrated) {
      return {
        status: 'not_integrated',
        outputSummary: `${def.integrationMilestone} — contract registered.`,
        errorMessage: null,
      };
    }

    switch (agentId) {
      case 'master_orchestrator':
        return {
          status: 'completed',
          outputSummary: `Validated 25-agent DAG dependencies and initialized job ${jobId}.`,
          errorMessage: null,
          executionEngine: 'Deterministic Kahn DAG Orchestrator',
        };

      case 'recovery_resource_manager': {
        const snap = await resourceManager.captureSnapshot(settings);
        const memText =
          snap.deviceMemoryGb !== null
            ? `${snap.deviceMemoryGb} GB reported`
            : 'browser RAM API unavailable';
        const persistText = snap.storagePersisted ? 'persistent storage granted' : 'storage best-effort';
        return {
          status: 'completed',
          outputSummary: `Resource check passed (${memText}, max heavy concurrency: ${snap.maxHeavyConcurrency}, ${persistText}, scheduler: ${snap.schedulerStatus}).`,
          errorMessage: null,
          executionEngine: 'Local Browser Storage & Memory Telemetry',
        };
      }

      case 'media_analyzer': {
        const mediaRecords = await getByIndex<ImportedMedia>(
          STORES.imported_media,
          'projectId',
          projectId
        );
        const media = mediaRecords[0];
        if (!media) {
          return {
            status: 'failed',
            outputSummary: 'No imported media file found for this project.',
            errorMessage: 'Import a supported audio or video file before running Media Analyzer.',
          };
        }
        scratch.media = media;

        if (media.vaultKey) {
          const vaultEntry = await getRecord<VaultEntry>(STORES.file_vault, media.vaultKey);
          scratch.mediaBlob = vaultEntry?.blob ?? null;
        }

        let existingMeta = (
          await getByIndex<MediaMetadata>(STORES.media_metadata, 'projectId', projectId)
        )[0];

        if (!existingMeta && scratch.mediaBlob) {
          const probe = await probeMediaFile(
            scratch.mediaBlob,
            media.mediaKind,
            media.fileExtension.toUpperCase()
          );
          existingMeta = createMediaMetadataRecord(
            projectId,
            media.id,
            media.fileExtension.toUpperCase(),
            probe
          );
          await putRecord(STORES.media_metadata, existingMeta);

          const chunkPlan = buildChunkPlan(
            probe.durationMs,
            settings.chunkDurationSec * 1000,
            settings.chunkOverlapSec * 1000
          );
          const updatedMedia: ImportedMedia = {
            ...media,
            chunkPlan,
            chunkDurationMs: settings.chunkDurationSec * 1000,
            chunkOverlapMs: settings.chunkOverlapSec * 1000,
          };
          await putRecord(STORES.imported_media, updatedMedia);
          scratch.media = updatedMedia;
        }

        scratch.mediaMetadata = existingMeta ?? null;

        if (scratch.mediaBlob) {
          const origClips = await getByIndex<AudioClip>(
            STORES.audio_clips,
            'projectId',
            projectId
          );
          const origClip = origClips.find((c) => c.sourceNamespace === 'original_media');
          if (origClip && !origClip.waveformPeaks) {
            const peaks = await computeWaveformPeaksFromBlob(scratch.mediaBlob, 140);
            if (peaks && peaks.length > 0) {
              await putRecord<AudioClip>(STORES.audio_clips, {
                ...origClip,
                waveformPeaks: peaks,
              });
            }
          }
        }

        const durationLabel = existingMeta?.durationMs
          ? `${(existingMeta.durationMs / 1000).toFixed(1)}s`
          : 'duration unreadable by browser decoder';
        const chLabel = existingMeta?.channels
          ? `${existingMeta.channels === 2 ? 'Stereo' : `${existingMeta.channels}ch`} ${existingMeta.sampleRateHz ?? ''} Hz`
          : 'channels probed on decode';
        return {
          status: existingMeta?.decoderNotes?.includes('MKV') ? 'completed_with_warnings' : 'completed',
          outputSummary: `Analyzed "${media.fileName}" (${durationLabel}, ${chLabel}, ${scratch.media.chunkPlan.length} chunk(s), ${Math.round(
            scratch.media.chunkOverlapMs / 1000
          )}s overlap).`,
          errorMessage: null,
          executionEngine: 'Browser Media Prober + Stereo PCM Inspector',
        };
      }

      case 'scene_detection': {
        if (!scratch.media || scratch.media.mediaKind === 'audio') {
          scratch.scenes = [];
          return {
            status: 'completed',
            outputSummary: 'Audio-only media imported; visual scene detection skipped cleanly.',
            errorMessage: null,
            executionEngine: 'Skipped (Audio-Only Media)',
          };
        }
        if (!scratch.mediaBlob || !scratch.mediaMetadata?.durationMs) {
          return {
            status: 'completed_with_warnings',
            outputSummary: 'Video blob or duration unavailable for adaptive scene cut scan.',
            errorMessage: null,
            executionEngine: 'Adaptive Histogram Scene Scanner',
          };
        }
        const scenes = await detectVideoScenesFromBlob(
          projectId,
          scratch.mediaBlob,
          scratch.mediaMetadata.durationMs
        );
        scratch.scenes = scenes;
        if (scenes.length > 0) {
          await putManyRecords(STORES.scenes, scenes);
        }
        return {
          status: scenes.length > 0 ? 'completed' : 'completed_with_warnings',
          outputSummary:
            scenes.length > 0
              ? `Detected ${scenes.length} visual scene(s) across full episode via adaptive histogram analysis.`
              : 'Video stream produced 0 decodable frames in browser decoder; continuing audio-first.',
          errorMessage: null,
          executionEngine: 'Adaptive Full-Episode Histogram Scene Scanner',
        };
      }

      case 'frame_extraction': {
        if (!scratch.media || scratch.media.mediaKind === 'audio' || scratch.scenes.length === 0) {
          scratch.extractedFrames = [];
          return {
            status: 'completed',
            outputSummary: 'No video scenes require keyframe extraction (audio-only or 0 scenes).',
            errorMessage: null,
            executionEngine: 'Skipped (No Video Scenes)',
          };
        }
        if (!scratch.mediaBlob) {
          return {
            status: 'completed_with_warnings',
            outputSummary: 'Source video blob unavailable for frame extraction.',
            errorMessage: null,
          };
        }

        // Prioritize dialogue timestamps if segments or turns already exist
        const existingSegments = await getByIndex<DialogueSegment>(
          STORES.dialogue_segments,
          'projectId',
          projectId
        );
        const dialogueTimestamps =
          existingSegments.length > 0
            ? existingSegments.map((s) => Math.round((s.originalStartMs + s.originalEndMs) / 2))
            : scratch.speakerTurns.map((t) => Math.round((t.startMs + t.endMs) / 2));

        const { frames, imageElements } = await extractKeyframesForScenes(
          projectId,
          scratch.mediaBlob,
          scratch.scenes,
          async (vaultKey, blob) => {
            const entry: VaultEntry = {
              vaultKey,
              projectId,
              namespace: 'temp_processing',
              fileName: vaultKey.split('/').pop() ?? 'frame.jpg',
              mimeType: 'image/jpeg',
              sizeBytes: blob.size,
              blob,
              storedAt: new Date().toISOString(),
            };
            await putRecord(STORES.file_vault, entry);
          },
          dialogueTimestamps
        );
        scratch.extractedFrames = frames;
        scratch.frameCanvases = imageElements;
        if (frames.length > 0) {
          await putManyRecords(STORES.extracted_frames, frames);
        }
        return {
          status: 'completed',
          outputSummary: `Extracted ${frames.length} adaptive, dialogue-aware deduplicated JPEG keyframes into temp_processing storage.`,
          errorMessage: null,
          executionEngine: 'Adaptive Dialogue-Aware Frame Extractor',
        };
      }

      case 'face_detection': {
        if (scratch.extractedFrames.length === 0) {
          scratch.faceDetections = [];
          return {
            status: 'completed',
            outputSummary: 'No keyframes to inspect (audio-only media); visual face detection skipped.',
            errorMessage: null,
            executionEngine: 'Skipped (No Keyframes)',
          };
        }
        const installed = await localModelRuntime.isModelInstalled('model_mediapipe_blazeface');
        if (!installed) {
          return {
            status: 'completed_with_warnings',
            outputSummary:
              'MediaPipe BlazeFace is not installed (or cache evicted) — visual face detection skipped. Download in Model Manager to enable visual character cues.',
            errorMessage: null,
            executionEngine: 'Unavailable (BlazeFace Not Installed)',
          };
        }
        scratch.usedModels.add('model_mediapipe_blazeface');
        const detector = await localModelRuntime.loadInstalledModel<{
          detect: (canvas: HTMLCanvasElement) => {
            detections?: Array<{
              boundingBox?: { originX: number; originY: number; width: number; height: number };
              categories?: Array<{ score?: number }>;
            }>;
          };
        }>('model_mediapipe_blazeface');
        const { detections, updatedFrames } = runMediaPipeFaceDetectionOnFrames(
          detector,
          scratch.extractedFrames,
          scratch.frameCanvases
        );
        scratch.faceDetections = detections;
        scratch.extractedFrames = updatedFrames;
        await putManyRecords(STORES.extracted_frames, updatedFrames);
        await this.saveArtifact(projectId, 'face_detections', detections);
        return {
          status: 'completed',
          outputSummary: `MediaPipe BlazeFace detected ${detections.length} face region(s) with 36-dim anime multi-region appearance descriptors (hair/face/clothing) across ${updatedFrames.length} keyframes.`,
          errorMessage: null,
          executionEngine: 'MediaPipe BlazeFace WASM + Anime Appearance Descriptor',
        };
      }

      case 'character_tracking': {
        if (scratch.faceDetections.length === 0) {
          scratch.visualTracks = [];
          return {
            status: 'completed',
            outputSummary: 'No face detections present; character tracking skipped cleanly.',
            errorMessage: null,
            executionEngine: 'Skipped (0 Face Detections)',
          };
        }
        const tracks = trackVisualCharacters(scratch.faceDetections);
        scratch.visualTracks = tracks;
        await this.saveArtifact(projectId, 'visual_tracks', tracks);
        const ambiguousCount = tracks.filter(
          (t) => t.ambiguousSimilarClusterIds.length > 0
        ).length;
        return {
          status: ambiguousCount > 0 ? 'needs_review' : 'completed',
          outputSummary: `Grouped ${scratch.faceDetections.length} detections into ${tracks.length} visual track(s) with per-track same-scene mouth-motion tracking (${ambiguousCount} visually similar track(s) flagged for review).`,
          errorMessage: null,
          executionEngine: 'Multi-Region Anime Visual Tracker + Per-Track Mouth Motion',
        };
      }

      case 'speaker_diarization': {
        const stereo = await this.ensureDecodedStereo(scratch);
        if (!stereo) {
          return {
            status: 'failed',
            outputSummary: 'Unable to decode project audio stream for speaker diarization.',
            errorMessage:
              'Browser decoder could not extract PCM samples from the imported media file.',
          };
        }

        const chunkPlan =
          scratch.media && scratch.media.chunkPlan.length > 0
            ? scratch.media.chunkPlan
            : buildChunkPlan(
                stereo.durationMs,
                settings.chunkDurationSec * 1000,
                settings.chunkOverlapSec * 1000
              );

        const pyannoteInstalled = await localModelRuntime.isModelInstalled(
          'model_pyannote_segmentation'
        );
        let diarizationMethod: 'pyannote_onnx' | 'acoustic_fallback' = 'acoustic_fallback';
        let speechIntervals: SpeechInterval[] = [];
        let overlapCount = 0;

        if (pyannoteInstalled) {
          scratch.usedModels.add('model_pyannote_segmentation');
          try {
            type PyAnnoteBundle = {
              processor: (audio: Float32Array, opts?: Record<string, unknown>) => Promise<Record<string, unknown>>;
              model: (inputs: Record<string, unknown>) => Promise<{ logits?: { data?: Float32Array; dims?: number[] } }>;
            };
            const pyBundle = await localModelRuntime.loadInstalledModel<PyAnnoteBundle>(
              'model_pyannote_segmentation'
            );

            // Real PyAnnote ONNX frame-level speech & multi-speaker overlap inference in 10s chunks
            const pyChunkMs = 10_000;
            for (let startMs = 0; startMs < stereo.durationMs; startMs += pyChunkMs) {
              if (signal.aborted) break;
              const endMs = Math.min(stereo.durationMs, startMs + pyChunkMs);
              if (endMs - startMs < 250) break;
              const monoChunk = extractMono16kChunkFromStereo(stereo, startMs, endMs);
              const inputs = await pyBundle.processor(monoChunk.samples);
              const out = await pyBundle.model(inputs);
              const logits = out?.logits;
              if (logits?.data && logits.dims && logits.dims.length >= 3) {
                const numFrames = logits.dims[1];
                const numClasses = logits.dims[2];
                const frameDurMs = (endMs - startMs) / Math.max(1, numFrames);
                let segStart: number | null = null;
                let segOverlap = false;

                for (let f = 0; f < numFrames; f += 1) {
                  let bestCls = 0;
                  let bestVal = -Infinity;
                  const base = f * numClasses;
                  for (let c = 0; c < numClasses; c += 1) {
                    const val = logits.data[base + c];
                    if (val > bestVal) {
                      bestVal = val;
                      bestCls = c;
                    }
                  }
                  const isSpeech = bestCls > 0;
                  const isOverlapClass = bestCls >= 4;
                  const fStart = Math.round(startMs + f * frameDurMs);
                  if (isSpeech && segStart === null) {
                    segStart = fStart;
                    segOverlap = isOverlapClass;
                  } else if (isSpeech && isOverlapClass) {
                    segOverlap = true;
                  } else if (!isSpeech && segStart !== null) {
                    const fEnd = Math.round(startMs + f * frameDurMs);
                    if (fEnd - segStart >= 220) {
                      if (segOverlap) overlapCount += 1;
                      speechIntervals.push({
                        startMs: segStart,
                        endMs: fEnd,
                        energyDb: -22,
                        overlapping: segOverlap,
                      });
                    }
                    segStart = null;
                    segOverlap = false;
                  }
                }
                if (segStart !== null && endMs - segStart >= 220) {
                  if (segOverlap) overlapCount += 1;
                  speechIntervals.push({
                    startMs: segStart,
                    endMs,
                    energyDb: -22,
                    overlapping: segOverlap,
                  });
                }
              }
            }

            if (speechIntervals.length > 0) {
              diarizationMethod = 'pyannote_onnx';
            }
          } catch {
            // Fall back honestly to chunked acoustic VAD + spectral clustering
            diarizationMethod = 'acoustic_fallback';
            speechIntervals = [];
          } finally {
            await localModelRuntime.unloadActiveModel();
          }
        }

        if (diarizationMethod === 'acoustic_fallback') {
          speechIntervals = detectVoiceActivityChunked(stereo, chunkPlan);
          overlapCount = speechIntervals.filter((iv) => iv.overlapping).length;
        }

        // Update real chunk statuses on ImportedMedia
        if (scratch.media) {
          const updatedPlan = chunkPlan.map((c) => ({ ...c, status: 'processed' as const }));
          scratch.media = { ...scratch.media, chunkPlan: updatedPlan };
          await putRecord(STORES.imported_media, scratch.media);
          await this.saveArtifact(projectId, 'chunk_states', updatedPlan);
        }

        // Cluster turns using 16 kHz mono slices
        const mono16kForCluster = extractMono16kChunkFromStereo(stereo, 0, stereo.durationMs);
        const clustered = clusterSpeakerIntervals(
          mono16kForCluster.samples,
          mono16kForCluster.sampleRate,
          speechIntervals
        );
        scratch.speakerTurns = clustered;
        await this.saveArtifact(projectId, 'speaker_turns', clustered);

        const existingSpeakers = await getByIndex<Speaker>(
          STORES.speakers,
          'projectId',
          projectId
        );
        const existingByLabel = new Map(existingSpeakers.map((s) => [s.speakerLabel, s]));

        const byLabel = new Map<
          string,
          { count: number; totalMs: number; confSum: number; overlaps: number }
        >();
        for (const turn of clustered) {
          const prev = byLabel.get(turn.speakerLabel) ?? {
            count: 0,
            totalMs: 0,
            confSum: 0,
            overlaps: 0,
          };
          prev.count += 1;
          prev.totalMs += Math.max(0, turn.endMs - turn.startMs);
          prev.confSum += turn.confidence;
          if (turn.overlapping) prev.overlaps += 1;
          byLabel.set(turn.speakerLabel, prev);
        }

        const totalAllSpeechMs = Array.from(byLabel.values()).reduce((s, v) => s + v.totalMs, 0);
        const persistedSpeakers: Speaker[] = [];
        for (const [label, stats] of byLabel.entries()) {
          const existing = existingByLabel.get(label);
          const internalSpeakerId = `spk_${projectId}_${label}`;
          const isDominantNoFace =
            scratch.visualTracks.length === 0 &&
            byLabel.size > 1 &&
            totalAllSpeechMs > 0 &&
            stats.totalMs / totalAllSpeechMs > 0.65;
          const spk: Speaker = {
            id: existing?.id ?? internalSpeakerId,
            internalSpeakerId,
            projectId,
            speakerLabel: label,
            roleType: existing?.roleType ?? (isDominantNoFace ? 'narrator' : 'on_screen'),
            totalDurationMs: stats.totalMs,
            segmentCount: stats.count,
            estimatedPitchHz: existing?.estimatedPitchHz ?? null,
            matchedCharacterId: existing?.matchedCharacterId ?? null,
            matchConfidence:
              Math.round((stats.confSum / Math.max(1, stats.count)) * 100) / 100,
            diarizationMethod,
            overlapCount: stats.overlaps,
            isNarratorCandidate: isDominantNoFace,
            reviewStatus: existing?.reviewStatus ?? 'needs_review',
          };
          persistedSpeakers.push(spk);
        }

        if (persistedSpeakers.length > 0) {
          await putManyRecords(STORES.speakers, persistedSpeakers);
        }
        scratch.speakers = persistedSpeakers;

        if (clustered.length === 0) {
          return {
            status: 'completed_with_warnings',
            outputSummary:
              'Audio decoded successfully, but no above-threshold speech activity was detected (silent or very low-level signal).',
            errorMessage: null,
            executionEngine:
              diarizationMethod === 'pyannote_onnx'
                ? 'PyAnnote Segmentation 3.0 ONNX'
                : 'Local Acoustic VAD + Spectral Clustering (Fallback)',
          };
        }

        return {
          status: diarizationMethod === 'pyannote_onnx' ? 'completed' : 'completed_with_warnings',
          outputSummary:
            diarizationMethod === 'pyannote_onnx'
              ? `PyAnnote Segmentation 3.0 ONNX identified ${persistedSpeakers.length} project-scoped speaker(s) across ${clustered.length} turn(s) (${overlapCount} overlap region(s)).`
              : `Acoustic Fallback (VAD + spectral clustering) identified ${persistedSpeakers.length} project-scoped speaker(s) across ${clustered.length} turn(s) (${overlapCount} overlap cue(s)). Download PyAnnote ONNX in Model Manager for neural segmentation.`,
          errorMessage: null,
          executionEngine:
            diarizationMethod === 'pyannote_onnx'
              ? 'PyAnnote Segmentation 3.0 ONNX'
              : 'Local Acoustic VAD + Spectral Clustering (Fallback)',
        };
      }

      case 'voice_analysis': {
        const stereo = await this.ensureDecodedStereo(scratch);
        if (!stereo || scratch.speakerTurns.length === 0) {
          return {
            status: 'completed_with_warnings',
            outputSummary: 'No speech turns available for acoustic Voice Analysis DSP.',
            errorMessage: null,
            executionEngine: 'Local Autocorrelation F0 & Spectral Timbre DSP',
          };
        }

        const turnsByLabel = new Map<string, SpeakerClusterSegment[]>();
        for (const turn of scratch.speakerTurns) {
          const list = turnsByLabel.get(turn.speakerLabel) ?? [];
          list.push(turn);
          turnsByLabel.set(turn.speakerLabel, list);
        }

        for (const [label, turns] of turnsByLabel.entries()) {
          const maxDurationMs = 8000;
          const chunks: Float32Array[] = [];
          let collectedMs = 0;
          for (const t of turns) {
            if (collectedMs >= maxDurationMs) break;
            const takeEnd = Math.min(t.endMs, t.startMs + (maxDurationMs - collectedMs));
            if (takeEnd > t.startMs + 80) {
              const slice = extractMono16kChunkFromStereo(stereo, t.startMs, takeEnd);
              chunks.push(slice.samples);
              collectedMs += takeEnd - t.startMs;
            }
          }
          const totalLen = chunks.reduce((s, c) => s + c.length, 0);
          const combined = new Float32Array(totalLen);
          let offset = 0;
          for (const c of chunks) {
            combined.set(c, offset);
            offset += c.length;
          }
          const acoustics = analyzeVoiceAcoustics(combined, 16000);
          scratch.speakerVoiceCharacteristics.set(label, acoustics);

          const spk = scratch.speakers.find((s) => s.speakerLabel === label);
          if (spk && acoustics.pitchMeanHz) {
            spk.estimatedPitchHz = acoustics.pitchMeanHz;
            await putRecord(STORES.speakers, spk);
          }
        }

        return {
          status: 'completed',
          outputSummary: `Measured real F0 pitch, spectral timbre, texture, and loudness via Web Audio DSP for ${scratch.speakerVoiceCharacteristics.size} speaker(s).`,
          errorMessage: null,
          executionEngine: 'Local Autocorrelation F0 & Spectral Timbre DSP',
        };
      }

      case 'face_voice_matching': {
        const projectRec = await getRecord<Project>(STORES.projects, projectId);
        const seriesScope = projectRec?.seriesTitle || 'Default Series';
        const existingCharacters = await getAllRecords<CharacterProfile>(STORES.characters);
        const turnMap: Record<string, Array<{ startMs: number; endMs: number }>> = {};
        for (const t of scratch.speakerTurns) {
          const list = turnMap[t.speakerLabel] ?? [];
          list.push({ startMs: t.startMs, endMs: t.endMs });
          turnMap[t.speakerLabel] = list;
        }

        const { associations, reviewNotes } = computeMultimodalFaceVoiceMatches({
          projectId,
          seriesScope,
          speakers: scratch.speakers,
          speakerTurnTimestamps: turnMap,
          visualTracks: scratch.visualTracks,
          existingCharacters,
        });
        scratch.associations = associations;
        if (associations.length > 0) {
          await putManyRecords(STORES.character_speaker_associations, associations);
        }

        const flagged = associations.filter((a) => a.status !== 'confirmed').length;
        return {
          status: flagged > 0 ? 'needs_review' : 'completed',
          outputSummary:
            associations.length > 0
              ? `Evaluated ${associations.length} series-scoped speaker-character match(es) (${flagged} flagged for identity review). ${
                  reviewNotes[0] ?? ''
                }`.trim()
              : 'No detected speakers to match in this run.',
          errorMessage: null,
          executionEngine: 'Series-Scoped Multimodal Face-Voice Correlator',
        };
      }

      case 'character_memory': {
        const projectRec = await getRecord<Project>(STORES.projects, projectId);
        const seriesScope = projectRec?.seriesTitle || 'Default Series';
        const allCharacters = await getAllRecords<CharacterProfile>(STORES.characters);
        // STRICT SERIES + PROJECT SCOPING: never collide unrelated projects on bare 'SPK_01'
        const scopedCharacters = allCharacters.filter(
          (c) =>
            c.projectId === projectId ||
            c.seriesScope.trim().toLowerCase() === seriesScope.trim().toLowerCase()
        );
        const now = new Date().toISOString();
        let createdCount = 0;
        let updatedCount = 0;

        for (const assoc of scratch.associations) {
          const measuredVoice = scratch.speakerVoiceCharacteristics.get(assoc.speakerId);
          const internalSpeakerId = assoc.internalSpeakerId || `spk_${projectId}_${assoc.speakerId}`;
          const spkObj = scratch.speakers.find((s) => s.speakerLabel === assoc.speakerId);

          const matchedExisting = scopedCharacters.find(
            (c) =>
              c.characterId === assoc.characterId ||
              c.associatedSpeakerIds.includes(internalSpeakerId) ||
              (c.projectId === projectId && c.associatedSpeakerIds.includes(assoc.speakerId))
          );

          const evidenceEntry = {
            recordedAt: now,
            source:
              assoc.visualEvidenceScore > 0
                ? 'multimodal_face_voice_matching'
                : 'acoustic_speaker_diarization',
            summary:
              assoc.visualEvidenceScore > 0
                ? `Project ${projectId}: Multimodal match (audio ${Math.round(assoc.audioEvidenceScore * 100)}%, visual ${Math.round(assoc.visualEvidenceScore * 100)}%, mouth ${Math.round(assoc.mouthSyncEvidenceScore * 100)}%).`
                : `Project ${projectId}: Audio-only speaker evidence (${Math.round(assoc.audioEvidenceScore * 100)}%).`,
            confidence: assoc.combinedConfidence,
          };

          if (matchedExisting) {
            const nextSpeakers = new Set(matchedExisting.associatedSpeakerIds);
            nextSpeakers.add(internalSpeakerId);
            const nextChar: CharacterProfile = {
              ...matchedExisting,
              associatedSpeakerIds: Array.from(nextSpeakers),
              voiceCharacteristics: measuredVoice
                ? { ...matchedExisting.voiceCharacteristics, ...measuredVoice }
                : matchedExisting.voiceCharacteristics,
              identityEvidenceHistory: [
                evidenceEntry,
                ...(matchedExisting.identityEvidenceHistory ?? []).slice(0, 14),
              ],
              // Strictly preserve user-approved reviewStatus and locked voice
              reviewStatus:
                matchedExisting.reviewStatus === 'approved'
                  ? 'approved'
                  : matchedExisting.reviewStatus,
              updatedAt: now,
            };
            await putRecord(STORES.characters, nextChar);
            updatedCount += 1;
          } else {
            const newCharId = `CHR-${projectId.slice(-4).toUpperCase()}-${assoc.speakerId}`;
            const matchingTrack = scratch.visualTracks.find((vt) =>
              assoc.characterId.includes(vt.trackClusterId)
            );
            const newProfile: CharacterProfile = {
              characterId: newCharId,
              projectId,
              seriesScope,
              displayName: spkObj?.isNarratorCandidate
                ? `Narrator (${assoc.speakerId})`
                : `Speaker ${assoc.speakerId}`,
              visualDescriptors:
                assoc.visualEvidenceScore > 0
                  ? [`Visual face alignment ${Math.round(assoc.visualEvidenceScore * 100)}%`]
                  : ['Audio-only / off-screen speaker'],
              visualEmbeddingVector: matchingTrack?.appearanceDescriptor ?? null,
              associatedSpeakerIds: [internalSpeakerId],
              voiceCharacteristics: measuredVoice ?? {
                pitchRange: 'Unmeasured',
                timbre: 'Unmeasured',
                pacing: 'Unmeasured',
                ageEstimate: 'Uncertain',
                genderPresentation: 'Uncertain',
                acousticMeasurementSource: 'unmeasured',
              },
              assignedHindiVoiceId: null,
              assignedCloudVoiceName: null,
              voiceLocked: false,
              personality: 'Pending user review',
              speakingStyle: measuredVoice?.speechStyle ?? 'Conversational',
              relationships: [],
              dialogueHistoryIds: [],
              firstSeenMs:
                scratch.speakerTurns.find((t) => t.speakerLabel === assoc.speakerId)?.startMs ??
                null,
              lastSeenMs:
                [...scratch.speakerTurns]
                  .reverse()
                  .find((t) => t.speakerLabel === assoc.speakerId)?.endMs ?? null,
              identityConfidence: assoc.combinedConfidence,
              reviewStatus: assoc.status === 'confirmed' ? 'unreviewed' : 'needs_review',
              speakerRole: spkObj?.isNarratorCandidate
                ? 'narrator'
                : assoc.visualEvidenceScore === 0
                ? 'off_screen'
                : 'on_screen',
              ambiguityNote:
                assoc.status === 'ambiguous'
                  ? 'Multiple visual candidates detected; confirm identity in Character Studio.'
                  : assoc.visualEvidenceScore === 0
                  ? 'Detected from audio only (no visible face alignment).'
                  : '',
              voiceAssignmentHistory: [],
              identityEvidenceHistory: [evidenceEntry],
              createdAt: now,
              updatedAt: now,
            };
            await putRecord(STORES.characters, newProfile);
            scopedCharacters.push(newProfile);

            await putRecord<CharacterSpeakerAssociation>(
              STORES.character_speaker_associations,
              { ...assoc, characterId: newCharId, internalSpeakerId }
            );
            if (spkObj) {
              await putRecord<Speaker>(STORES.speakers, {
                ...spkObj,
                matchedCharacterId: newCharId,
              });
            }
            createdCount += 1;
          }
        }

        return {
          status: 'completed',
          outputSummary: `Series-scoped Character Memory ("${seriesScope}") updated: ${createdCount} new profile(s), ${updatedCount} existing profile(s) enriched; zero cross-series collisions.`,
          errorMessage: null,
          executionEngine: 'Series-Scoped Persistent Character Memory Store',
        };
      }

      case 'japanese_asr': {
        const existingSegments = await getByIndex<DialogueSegment>(
          STORES.dialogue_segments,
          'projectId',
          projectId
        );
        const whisperInstalled = await localModelRuntime.isModelInstalled(
          'model_whisper_small_onnx'
        );

        if (!whisperInstalled) {
          const hasManualJapanese = existingSegments.some(
            (s) => s.japaneseText.trim().length > 0
          );
          if (hasManualJapanese) {
            return {
              status: 'completed_with_warnings',
              outputSummary: `Whisper Small ONNX is not installed — proceeding with ${existingSegments.length} existing dialogue segment(s). Download OpenAI Whisper Small ONNX in Model Manager for offline Japanese ASR.`,
              errorMessage: null,
              executionEngine: 'Manual / Existing Segments (Whisper Not Installed)',
            };
          }
          return {
            status: 'waiting_for_model',
            outputSummary:
              'OpenAI Whisper Small (INT8 ONNX) is required for offline Japanese ASR. Download & verify it in Model Manager or add Japanese dialogue segments manually.',
            errorMessage: null,
            executionEngine: 'Waiting for Whisper Small ONNX',
          };
        }

        const stereo = await this.ensureDecodedStereo(scratch);
        if (!stereo) {
          return {
            status: 'failed',
            outputSummary: 'Decoded stereo audio unavailable for Whisper Japanese ASR.',
            errorMessage: 'Unable to decode source audio to 16 kHz mono PCM chunks.',
          };
        }

        scratch.usedModels.add('model_whisper_small_onnx');
        type WhisperPipe = (
          audio: Float32Array,
          opts: Record<string, unknown>
        ) => Promise<{ text?: string; chunks?: AsrRawChunk[] }>;

        const asrPipe = await localModelRuntime.loadInstalledModel<WhisperPipe>(
          'model_whisper_small_onnx'
        );

        // Slice 16 kHz mono only per chunk (5-minute max slice for bounded RAM on long episodes)
        const asrSliceSec = 180;
        const rawChunks: AsrRawChunk[] = [];
        for (let startMs = 0; startMs < stereo.durationMs; startMs += asrSliceSec * 1000) {
          if (signal.aborted) break;
          const endMs = Math.min(stereo.durationMs, startMs + asrSliceSec * 1000 + 2000);
          const mono16k = extractMono16kChunkFromStereo(stereo, startMs, endMs);
          const asrResult = await asrPipe(mono16k.samples, {
            language: 'japanese',
            task: 'transcribe',
            return_timestamps: true,
            chunk_length_s: 30,
            stride_length_s: 5,
          });
          const offsetSec = startMs / 1000;
          if (asrResult.chunks && asrResult.chunks.length > 0) {
            for (const ch of asrResult.chunks) {
              const t0 = (ch.timestamp?.[0] ?? 0) + offsetSec;
              const t1 = (ch.timestamp?.[1] ?? t0 + 1.5) + offsetSec;
              rawChunks.push({ text: ch.text, timestamp: [t0, t1] });
            }
          } else if (asrResult.text?.trim()) {
            rawChunks.push({
              text: asrResult.text.trim(),
              timestamp: [offsetSec, endMs / 1000],
            });
          }
        }

        const normalized = deduplicateAsrChunks(rawChunks, stereo.durationMs);
        if (normalized.length === 0) {
          return {
            status: 'completed_with_warnings',
            outputSummary:
              'Whisper Small ONNX ran locally and returned 0 Japanese speech utterances for this audio.',
            errorMessage: null,
            executionEngine: 'OpenAI Whisper Small ONNX (Local)',
          };
        }

        const projectRec = await getRecord<Project>(STORES.projects, projectId);
        const seriesScope = projectRec?.seriesTitle || 'Default Series';
        const allChars = (await getAllRecords<CharacterProfile>(STORES.characters)).filter(
          (c) =>
            c.projectId === projectId ||
            c.seriesScope.trim().toLowerCase() === seriesScope.trim().toLowerCase()
        );
        const now = new Date().toISOString();
        const createdSegments: DialogueSegment[] = [];
        let unassignedCount = 0;

        for (let idx = 0; idx < normalized.length; idx += 1) {
          const item = normalized[idx];
          const segDur = Math.max(100, item.endMs - item.startMs);
          const minRequiredOverlap = Math.min(150, Math.round(segDur * 0.25));

          // SAFE SPEAKER MATCHING: require genuine temporal overlap (never blind 'SPK_01' fallback!)
          let bestSpeakerLabel: string | null = null;
          let bestOverlap = 0;
          for (const turn of scratch.speakerTurns) {
            const overlap =
              Math.min(item.endMs, turn.endMs) - Math.max(item.startMs, turn.startMs);
            if (overlap > bestOverlap) {
              bestOverlap = overlap;
              bestSpeakerLabel = turn.speakerLabel;
            }
          }

          const hasValidSpeaker = bestSpeakerLabel !== null && bestOverlap >= minRequiredOverlap;
          const resolvedSpeakerLabel = hasValidSpeaker ? bestSpeakerLabel! : 'UNASSIGNED_SPEAKER';
          if (!hasValidSpeaker) unassignedCount += 1;

          const internalSpeakerId = hasValidSpeaker
            ? `spk_${projectId}_${resolvedSpeakerLabel}`
            : null;
          const matchedChar = internalSpeakerId
            ? allChars.find(
                (c) =>
                  c.associatedSpeakerIds.includes(internalSpeakerId) ||
                  (c.projectId === projectId && c.associatedSpeakerIds.includes(resolvedSpeakerLabel))
              ) ?? null
            : null;

          const segId = `SEG-${projectId.slice(-4).toUpperCase()}-${String(idx + 1).padStart(
            3,
            '0'
          )}`;
          const existing = existingSegments.find((e) => e.segmentId === segId);

          const segment: DialogueSegment = {
            segmentId: segId,
            projectId,
            sourceSpeakerId: existing?.sourceSpeakerId ?? resolvedSpeakerLabel,
            characterId: existing?.characterId ?? matchedChar?.characterId ?? null,
            originalStartMs: item.startMs,
            originalEndMs: item.endMs,
            originalDurationMs: segDur,
            japaneseText: item.japaneseText,
            asrConfidence: item.confidence,
            hindiText: existing?.hindiText ?? '',
            emotion: existing?.emotion ?? {
              primaryEmotion: 'Calm',
              intensity: 0.4,
              deliveryNotes: '',
              source: 'acoustic_lexical_hybrid',
            },
            assignedHindiVoiceId:
              existing?.assignedHindiVoiceId ?? matchedChar?.assignedHindiVoiceId ?? null,
            generatedAudioRef: existing?.generatedAudioRef ?? null,
            actualGeneratedDurationMs: existing?.actualGeneratedDurationMs ?? null,
            finalStartMs: existing?.finalStartMs ?? item.startMs,
            finalEndMs: existing?.finalEndMs ?? item.endMs,
            preferredShiftLimitMs: settings.preferredTimingAdjustmentMs,
            overlapGroupId: existing?.overlapGroupId ?? null,
            syncStatus: existing?.syncStatus ?? 'unmeasured',
            qaStatus: 'not_run',
            reviewStatus: existing?.reviewStatus === 'approved'
              ? 'approved'
              : hasValidSpeaker
              ? 'unreviewed'
              : 'needs_review',
            updatedAt: now,
          };
          createdSegments.push(segment);
        }

        await putManyRecords(STORES.dialogue_segments, createdSegments);

        const tracks = await getByIndex<TimelineTrack>(
          STORES.timeline_tracks,
          'projectId',
          projectId
        );
        const dialogueTrack = tracks.find((t) => t.kind === 'dialogue');
        if (dialogueTrack) {
          for (const seg of createdSegments) {
            const existingClip = await getRecord<AudioClip>(
              STORES.audio_clips,
              `clip_${seg.segmentId}`
            );
            await putRecord<AudioClip>(STORES.audio_clips, {
              clipId: `clip_${seg.segmentId}`,
              projectId,
              trackId: existingClip?.trackId ?? dialogueTrack.trackId,
              segmentId: seg.segmentId,
              label: `${seg.sourceSpeakerId}: ${seg.japaneseText}`.slice(0, 48),
              startMs: seg.finalStartMs,
              endMs: seg.finalEndMs,
              durationMs: Math.max(100, seg.finalEndMs - seg.finalStartMs),
              sourceNamespace: existingClip?.sourceNamespace ?? null,
              sourceRef: existingClip?.sourceRef ?? null,
              hasRealAudio: Boolean(existingClip?.sourceRef),
              waveformPeaks: existingClip?.waveformPeaks ?? null,
            });
          }
        }

        return {
          status: unassignedCount > 0 ? 'needs_review' : 'completed',
          outputSummary: `Whisper Small ONNX transcribed ${createdSegments.length} Japanese dialogue segment(s) (${unassignedCount} without confident diarization overlap flagged UNASSIGNED_SPEAKER).`,
          errorMessage: null,
          executionEngine: 'OpenAI Whisper Small ONNX (Local)',
        };
      }

      case 'relationship_intelligence': {
        const projectRec = await getRecord<Project>(STORES.projects, projectId);
        const seriesScope = projectRec?.seriesTitle || 'Default Series';
        const scopedChars = (await getAllRecords<CharacterProfile>(STORES.characters)).filter(
          (c) =>
            c.projectId === projectId ||
            c.seriesScope.trim().toLowerCase() === seriesScope.trim().toLowerCase()
        );
        const segments = (
          await getByIndex<DialogueSegment>(STORES.dialogue_segments, 'projectId', projectId)
        ).sort((a, b) => a.originalStartMs - b.originalStartMs);

        const inferredMap = analyzeCharacterRelationshipsFromDialogue(scopedChars, segments);
        let addedCount = 0;

        for (const [charId, newRels] of inferredMap.entries()) {
          const ch = scopedChars.find((c) => c.characterId === charId);
          if (!ch) continue;
          const merged = [...ch.relationships];
          for (const rel of newRels) {
            if (!merged.some((r) => r.targetCharacterId === rel.targetCharacterId)) {
              merged.push(rel);
              addedCount += 1;
            }
          }
          await putRecord<CharacterProfile>(STORES.characters, {
            ...ch,
            relationships: merged,
            updatedAt: new Date().toISOString(),
          });
        }

        return {
          status: 'completed',
          outputSummary:
            addedCount > 0
              ? `Inferred ${addedCount} politeness-register relationship(s) from multi-turn exchanges.`
              : 'Evaluated dialogue turns (no multi-turn exchanges required new inferred relationships).',
          errorMessage: null,
          executionEngine: 'Japanese Honorific & Politeness Register Analyzer',
        };
      }

      case 'context_intelligence': {
        const scenes = await getByIndex<Scene>(STORES.scenes, 'projectId', projectId);
        const projectRec = await getRecord<Project>(STORES.projects, projectId);
        const seriesScope = projectRec?.seriesTitle || 'Default Series';
        const chars = (await getAllRecords<CharacterProfile>(STORES.characters)).filter(
          (c) =>
            c.projectId === projectId ||
            c.seriesScope.trim().toLowerCase() === seriesScope.trim().toLowerCase()
        );
        const pronunciations = await getAllRecords<PronunciationEntry>(
          STORES.pronunciation_entries
        );
        const snapshot = buildProjectContextSnapshot({
          projectId,
          scenes,
          characters: chars,
          pronunciations,
          windowSize: 5,
        });
        await putRecord(STORES.context_snapshots, snapshot);
        return {
          status: 'completed',
          outputSummary: `Built bounded local context snapshot (${snapshot.sceneCount} scenes, ${snapshot.characterBriefs.length} series character briefs, ${snapshot.terminology.length} dictionary terms).`,
          errorMessage: null,
          executionEngine: 'Bounded Rolling Context Builder',
        };
      }

      case 'pronunciation': {
        const pronunciations = await getAllRecords<PronunciationEntry>(
          STORES.pronunciation_entries
        );
        return {
          status: 'completed',
          outputSummary: `Loaded ${pronunciations.length} persistent pronunciation rule(s) for Japanese/Hindi/English terminology consistency.`,
          errorMessage: null,
          executionEngine: 'Persistent Pronunciation Rule Engine',
        };
      }

      case 'translation': {
        const segments = (
          await getByIndex<DialogueSegment>(STORES.dialogue_segments, 'projectId', projectId)
        ).sort((a, b) => a.originalStartMs - b.originalStartMs);

        if (segments.length === 0) {
          return {
            status: 'completed_with_warnings',
            outputSummary: 'No dialogue segments available to translate.',
            errorMessage: null,
            executionEngine: 'Skipped (0 Segments)',
          };
        }

        const pronunciations = await getAllRecords<PronunciationEntry>(
          STORES.pronunciation_entries
        );
        const chars = await getAllRecords<CharacterProfile>(STORES.characters);
        const charById = new Map(chars.map((c) => [c.characterId, c]));

        const segmentsNeedingTranslation = segments.filter(
          (s) => s.japaneseText.trim().length > 0 && s.hindiText.trim().length === 0
        );

        const nllbInstalled = await localModelRuntime.isModelInstalled('model_nllb_200_600m');
        const cloudAllowed =
          !settings.offlineOnlyMode &&
          settings.cloudIntelligenceEnabled &&
          settings.allowSendDialogueTextToCloud;

        if (segmentsNeedingTranslation.length > 0 && !nllbInstalled && !cloudAllowed) {
          const hasAnyHindi = segments.some((s) => s.hindiText.trim().length > 0);
          if (hasAnyHindi) {
            for (const seg of segments) {
              if (!seg.hindiText.trim()) continue;
              const char = seg.characterId ? charById.get(seg.characterId) : null;
              const register = char?.relationships[0]?.politenessRegister;
              const refined = refineHindiWithContextAndPronunciation(
                seg.hindiText,
                pronunciations,
                register
              );
              if (refined.hindiText !== seg.hindiText) {
                await putRecord<DialogueSegment>(STORES.dialogue_segments, {
                  ...seg,
                  hindiText: refined.hindiText,
                  updatedAt: new Date().toISOString(),
                });
              }
            }
            return {
              status: 'completed_with_warnings',
              outputSummary: `NLLB-200-600M ONNX not installed and Cloud Intelligence disabled — preserved existing Hindi lines and applied ${pronunciations.length} pronunciation rules (${segmentsNeedingTranslation.length} still empty).`,
              errorMessage: null,
              executionEngine: 'Local Pronunciation & Register Pass Only',
            };
          }
          return {
            status: 'waiting_for_model',
            outputSummary:
              'Meta NLLB-200-Distilled-600M (INT8 ONNX) is required for offline Japanese → Hindi translation (or enable Cloud Intelligence in Settings).',
            errorMessage: null,
            executionEngine: 'Waiting for NLLB-200 ONNX / Cloud',
          };
        }

        type TranslationPipe = (
          text: string,
          opts: { src_lang: string; tgt_lang: string }
        ) => Promise<Array<{ translation_text?: string }>>;

        let translator: TranslationPipe | null = null;
        if (nllbInstalled && segmentsNeedingTranslation.length > 0) {
          scratch.usedModels.add('model_nllb_200_600m');
          translator = await localModelRuntime.loadInstalledModel<TranslationPipe>(
            'model_nllb_200_600m'
          );
        }

        let translatedCount = 0;
        let collaborativeCount = 0;
        let disagreementCount = 0;
        const usedEngines = new Set<string>();
        const now = new Date().toISOString();

        for (let idx = 0; idx < segments.length; idx += 1) {
          const seg = segments[idx];
          if (signal.aborted) break;

          let localDraft = seg.hindiText.trim();
          if (!localDraft && translator && seg.japaneseText.trim()) {
            const out = await translator(seg.japaneseText, {
              src_lang: 'jpn_Jpan',
              tgt_lang: 'hin_Deva',
            });
            localDraft = out?.[0]?.translation_text?.trim() ?? '';
            usedEngines.add('NLLB-200-600M ONNX');
          }

          const char = seg.characterId ? charById.get(seg.characterId) : null;
          const register = char?.relationships[0]?.politenessRegister ?? '';
          if (!seg.japaneseText.trim() && !localDraft) continue;

          const collab = await executeCollaborativeIntelligence({
            taskType: 'translate_and_adapt',
            japaneseText: seg.japaneseText,
            localDraftHindi: localDraft,
            characterContext: char
              ? `${char.displayName} (${char.personality}; style: ${char.speakingStyle})`
              : seg.sourceSpeakerId,
            politenessRegister: register,
            targetDurationMs: seg.originalDurationMs,
            previousTurns: segments
              .slice(Math.max(0, idx - 2), idx)
              .map((s) => `${s.sourceSpeakerId}: ${s.japaneseText || s.hindiText}`),
            nextTurns: segments
              .slice(idx + 1, idx + 3)
              .map((s) => `${s.sourceSpeakerId}: ${s.japaneseText || s.hindiText}`),
            pronunciationRules: pronunciations,
            settings,
          });

          const finalHindi = collab.hindiText || localDraft;
          if (!finalHindi) continue;

          if (collab.meta.modelUsed) usedEngines.add(collab.meta.modelUsed);
          if (collab.meta.geminiDraft) collaborativeCount += 1;
          if (collab.meta.disagreementFlag) disagreementCount += 1;

          const refined = refineHindiWithContextAndPronunciation(
            finalHindi,
            pronunciations,
            register
          );

          await putRecord<DialogueSegment>(STORES.dialogue_segments, {
            ...seg,
            hindiText: refined.hindiText,
            collaborativeMeta: collab.meta,
            reviewStatus: collab.meta.disagreementFlag
              ? 'needs_review'
              : seg.reviewStatus === 'approved'
              ? 'approved'
              : 'unreviewed',
            updatedAt: now,
          });

          const trRec: TranslationRecord = {
            id: `tr_${seg.segmentId}`,
            projectId,
            segmentId: seg.segmentId,
            sourceLang: 'ja',
            targetLang: 'hi',
            sourceText: seg.japaneseText,
            translatedText: refined.hindiText,
            contextNotes:
              collab.meta.culturalNote ||
              (register ? `Register: ${register}` : 'Local / Collaborative translation'),
            pronunciationOverrides: refined.appliedOverrides,
            collaborativeMeta: collab.meta,
            status: collab.meta.disagreementFlag ? 'needs_review' : 'draft',
            updatedAt: now,
          };
          await putRecord(STORES.translations, trRec);
          translatedCount += 1;
        }

        if (translatedCount === 0 && segmentsNeedingTranslation.length > 0) {
          return {
            status: 'waiting_for_model',
            outputSummary:
              'Neither offline NLLB-200 ONNX nor live Gemini API returned translations. Install NLLB-200 in Model Manager or configure GEMINI_API_KEY in Secrets.',
            errorMessage: null,
            executionEngine: 'Waiting for Translation Engine',
          };
        }

        return {
          status: disagreementCount > 0 ? 'needs_review' : 'completed',
          outputSummary: `Processed ${translatedCount} Hindi line(s) in mode "${settings.collaborationMode}" (${collaborativeCount} Gemini-collaborated, ${disagreementCount} disagreement(s) flagged, ${pronunciations.length} glossary rules enforced).`,
          errorMessage: null,
          executionEngine: Array.from(usedEngines).join(' + ') || 'Local Rules',
        };
      }

      case 'emotion_detection': {
        const segments = await getByIndex<DialogueSegment>(
          STORES.dialogue_segments,
          'projectId',
          projectId
        );
        if (segments.length === 0) {
          return {
            status: 'completed_with_warnings',
            outputSummary: 'No dialogue segments present for emotion analysis.',
            errorMessage: null,
          };
        }

        const stereo = await this.ensureDecodedStereo(scratch);
        const sentimentInstalled = await localModelRuntime.isModelInstalled(
          'model_multilingual_sentiment'
        );
        type SentimentPipe = (text: string) => Promise<Array<{ label: string; score: number }>>;
        let sentimentPipe: SentimentPipe | null = null;
        if (sentimentInstalled) {
          try {
            sentimentPipe = await localModelRuntime.loadInstalledModel<SentimentPipe>(
              'model_multilingual_sentiment'
            );
          } catch {
            sentimentPipe = null;
          }
        }

        try {
          let analyzedCount = 0;
          const now = new Date().toISOString();
          for (const seg of segments) {
            let energyDb: number | null = null;
            let pitchVariationHz: number | null = null;
            let speakingRateCps: number | null = null;

            if (stereo && seg.originalEndMs > seg.originalStartMs + 60) {
              const slice = extractMono16kChunkFromStereo(
                stereo,
                seg.originalStartMs,
                seg.originalEndMs
              );
              if (slice.samples.length >= 256) {
                const segAcoustics = analyzeVoiceAcoustics(
                  slice.samples,
                  slice.sampleRate,
                  (seg.japaneseText || seg.hindiText).length
                );
                energyDb = segAcoustics.energyDb ?? null;
                pitchVariationHz = segAcoustics.pitchVariationHz ?? null;
                speakingRateCps = segAcoustics.speakingRateCps ?? null;
              }
            }

            let sentimentModelLabel: { label: string; score: number } | null = null;
            if (sentimentPipe && (seg.japaneseText || seg.hindiText).trim()) {
              try {
                const res = await sentimentPipe(
                  (seg.japaneseText || seg.hindiText).slice(0, 240)
                );
                if (res?.[0]) {
                  sentimentModelLabel = { label: res[0].label, score: res[0].score };
                }
              } catch {
                sentimentModelLabel = null;
              }
            }

            const emotion = detectEmotionHybrid({
              japaneseText: seg.japaneseText,
              hindiText: seg.hindiText,
              energyDb,
              pitchVariationHz,
              speakingRateCps,
              sentimentModelLabel,
            });

            await putRecord<DialogueSegment>(STORES.dialogue_segments, {
              ...seg,
              emotion,
              updatedAt: now,
            });
            analyzedCount += 1;
          }

          return {
            status: 'completed',
            outputSummary: sentimentPipe
              ? `Analyzed emotion on ${analyzedCount} segment(s) using acoustic DSP + lexical cues + Multilingual Sentiment ONNX.`
              : `Analyzed emotion on ${analyzedCount} segment(s) using local acoustic DSP + Japanese/Hindi lexical cues.`,
            errorMessage: null,
            executionEngine: sentimentPipe
              ? 'Acoustic DSP + Lexical + Multilingual Sentiment ONNX'
              : 'Acoustic DSP + Japanese/Hindi Lexical Heuristics',
          };
        } finally {
          if (sentimentPipe) {
            await localModelRuntime.unloadActiveModel();
          }
        }
      }

      case 'voice_assignment': {
        const projectRec = await getRecord<Project>(STORES.projects, projectId);
        const seriesScope = projectRec?.seriesTitle || 'Default Series';
        const allChars = await getAllRecords<CharacterProfile>(STORES.characters);
        const scopedChars = allChars.filter(
          (c) =>
            c.projectId === projectId ||
            c.seriesScope.trim().toLowerCase() === seriesScope.trim().toLowerCase()
        );
        const voices = await getAllRecords<VoiceProfile>(STORES.voice_profiles);
        const voiceById = new Map(voices.map((v) => [v.voiceId, v]));
        const segments = await getByIndex<DialogueSegment>(
          STORES.dialogue_segments,
          'projectId',
          projectId
        );

        const preferCloudVoices =
          settings.cloudTtsEnabled &&
          !settings.offlineOnlyMode &&
          settings.cloudIntelligenceEnabled;
        const alreadyAssignedVoiceIds = new Set<string>(
          scopedChars
            .map((c) => c.assignedHindiVoiceId)
            .filter((v): v is string => Boolean(v))
        );

        const now = new Date().toISOString();
        let assignedCount = 0;

        const updatedCharMap = new Map<string, CharacterProfile>();
        for (const ch of scopedChars) {
          if (ch.voiceLocked && ch.assignedHindiVoiceId) {
            updatedCharMap.set(ch.characterId, ch);
            continue;
          }
          if (!ch.assignedHindiVoiceId) {
            const best = selectBestVoiceForCharacter(ch, voices, {
              preferCloudVoices,
              alreadyAssignedVoiceIds,
            });
            if (best) {
              alreadyAssignedVoiceIds.add(best.voiceId);
              const persistentCloudVoice = resolvePersistentCloudVoiceName(
                ch,
                best,
                ch.characterId
              );
              const updated: CharacterProfile = {
                ...ch,
                assignedHindiVoiceId: best.voiceId,
                assignedCloudVoiceName: persistentCloudVoice,
                voiceAssignmentHistory: [
                  {
                    voiceId: best.voiceId,
                    voiceName: best.displayName,
                    assignedAt: now,
                    reason:
                      best.synthesisMode === 'cloud_prebuilt_voice'
                        ? 'Automatic Cloud Prebuilt Multi-Voice assignment (Agent #17)'
                        : 'Automatic Local MMS-TTS voice assignment (Agent #17)',
                    locked: false,
                  },
                  ...ch.voiceAssignmentHistory,
                ],
                updatedAt: now,
              };
              await putRecord(STORES.characters, updated);
              const va: VoiceAssignment = {
                id: `va_${projectId}_${ch.characterId}`,
                projectId,
                characterId: ch.characterId,
                voiceId: best.voiceId,
                locked: false,
                assignedBy: 'agent_prompt2',
                assignedAt: now,
              };
              await putRecord(STORES.voice_assignments, va);
              updatedCharMap.set(ch.characterId, updated);
              assignedCount += 1;
              continue;
            }
          } else if (!ch.assignedCloudVoiceName) {
            const assignedVoice = voiceById.get(ch.assignedHindiVoiceId) ?? null;
            const resolvedCloud = resolvePersistentCloudVoiceName(
              ch,
              assignedVoice,
              ch.characterId
            );
            const updated: CharacterProfile = {
              ...ch,
              assignedCloudVoiceName: resolvedCloud,
              updatedAt: now,
            };
            await putRecord(STORES.characters, updated);
            updatedCharMap.set(ch.characterId, updated);
            continue;
          }
          updatedCharMap.set(ch.characterId, ch);
        }

        for (const seg of segments) {
          const ch = seg.characterId ? updatedCharMap.get(seg.characterId) : null;
          const fallbackVoice =
            voices.find((v) =>
              preferCloudVoices
                ? v.synthesisMode === 'cloud_prebuilt_voice'
                : v.synthesisMode !== 'cloud_prebuilt_voice'
            )?.voiceId ??
            voices[0]?.voiceId ??
            null;
          const targetVoiceId = ch?.assignedHindiVoiceId ?? seg.assignedHindiVoiceId ?? fallbackVoice;
          if (targetVoiceId && targetVoiceId !== seg.assignedHindiVoiceId) {
            await putRecord<DialogueSegment>(STORES.dialogue_segments, {
              ...seg,
              assignedHindiVoiceId: targetVoiceId,
              updatedAt: now,
            });
          }
        }

        return {
          status: 'completed',
          outputSummary: `Assigned persistent ${
            preferCloudVoices ? 'Cloud Prebuilt Multi-Voice' : 'Local MMS-TTS'
          } profiles to ${assignedCount} character(s) with collision avoidance while preserving locked voices.`,
          errorMessage: null,
          executionEngine: preferCloudVoices
            ? 'Cloud Prebuilt Multi-Voice Mapper'
            : 'Local Acoustic Voice Preset Mapper',
        };
      }

      case 'voice_acting': {
        const segments = await getByIndex<DialogueSegment>(
          STORES.dialogue_segments,
          'projectId',
          projectId
        );
        const voices = await getAllRecords<VoiceProfile>(STORES.voice_profiles);
        const voiceById = new Map(voices.map((v) => [v.voiceId, v]));
        const now = new Date().toISOString();

        for (const seg of segments) {
          const voice = seg.assignedHindiVoiceId
            ? voiceById.get(seg.assignedHindiVoiceId) ?? null
            : null;
          const directive = buildVoiceActingDirective(seg.emotion, voice);
          await putRecord<DialogueSegment>(STORES.dialogue_segments, {
            ...seg,
            actingDirective: directive,
            updatedAt: now,
          });
        }

        return {
          status: 'completed',
          outputSummary: `Computed expressive voice acting directives (rate, pitch, gain, pauses) for ${segments.length} segment(s) targeting both local WSOLA/DSP and Gemini Cloud style prompts.`,
          errorMessage: null,
          executionEngine: 'Voice Acting Directive Planner (Cloud + Local DSP)',
        };
      }

      case 'hindi_tts': {
        const segments = (
          await getByIndex<DialogueSegment>(STORES.dialogue_segments, 'projectId', projectId)
        ).sort((a, b) => a.originalStartMs - b.originalStartMs);

        const synthesizable = segments.filter((s) => s.hindiText.trim().length > 0);
        if (synthesizable.length === 0) {
          return {
            status: 'completed_with_warnings',
            outputSummary: 'No Hindi dialogue lines present to synthesize yet.',
            errorMessage: null,
          };
        }

        const useCloudTts =
          settings.cloudTtsEnabled &&
          !settings.offlineOnlyMode &&
          settings.cloudIntelligenceEnabled;
        const ttsInstalled = await localModelRuntime.isModelInstalled('model_mms_tts_hin');

        if (!ttsInstalled && !useCloudTts) {
          return {
            status: 'waiting_for_model',
            outputSummary:
              'Meta MMS-TTS Hindi (VITS ONNX) is not installed locally. Download & verify it in Model Manager (or enable optional Gemini Cloud TTS in Settings).',
            errorMessage: null,
            executionEngine: 'Waiting for MMS-TTS-HIN ONNX / Cloud TTS',
          };
        }

        type TtsPipe = (text: string) => Promise<{ audio: Float32Array; sampling_rate: number }>;
        const ttsPipe =
          ttsInstalled && !useCloudTts
            ? (() => {
                scratch.usedModels.add('model_mms_tts_hin');
                return localModelRuntime.loadInstalledModel<TtsPipe>('model_mms_tts_hin');
              })()
            : null;
        const resolvedTtsPipe = ttsPipe ? await ttsPipe : null;

        const [voices, chars] = await Promise.all([
          getAllRecords<VoiceProfile>(STORES.voice_profiles),
          getAllRecords<CharacterProfile>(STORES.characters),
        ]);
        const voiceById = new Map(voices.map((v) => [v.voiceId, v]));
        const charById = new Map(chars.map((c) => [c.characterId, c]));

        let generatedCount = 0;
        let engineLabel = 'Meta MMS-TTS-HIN (Local Offline)';
        const now = new Date().toISOString();

        for (let idx = 0; idx < synthesizable.length; idx += 1) {
          const seg = synthesizable[idx];
          if (signal.aborted) break;
          const voice = seg.assignedHindiVoiceId
            ? voiceById.get(seg.assignedHindiVoiceId) ?? null
            : null;
          const char = seg.characterId ? charById.get(seg.characterId) ?? null : null;
          const directive =
            seg.actingDirective ?? buildVoiceActingDirective(seg.emotion, voice);

          let wavBlob: Blob;
          let durationMs: number;

          if (useCloudTts) {
            const persistentVoiceName = resolvePersistentCloudVoiceName(
              char,
              voice,
              seg.sourceSpeakerId
            );
            const cloudRes = await synthesizeHindiWavViaGeminiCloud({
              hindiText: seg.hindiText,
              emotionStyle: `${seg.emotion.primaryEmotion} anime Hindi dubbing (${directive.deliveryStyle})`,
              voiceName: persistentVoiceName,
              model: settings.preferredCloudTtsModel || 'gemini-3.8-flash-lite-tts',
            });
            // Apply bounded post-synthesis acting DSP (gain, pause, gentle rate) on cloud WAV too!
            const acted = await applyVoiceActingToWavBlob(cloudRes.wavBlob, directive, true);
            wavBlob = acted.wavBlob;
            durationMs = acted.durationMs;
            engineLabel = `Gemini Cloud TTS (${cloudRes.model}, persistent multi-voice)`;
          } else if (resolvedTtsPipe) {
            const synth = await synthesizeHindiWavWithModel({
              ttsPipeline: resolvedTtsPipe,
              hindiText: seg.hindiText,
              directive,
            });
            wavBlob = synth.wavBlob;
            durationMs = synth.durationMs;
          } else {
            continue;
          }

          const vaultKey = `generated_audio/${projectId}/${seg.segmentId}.wav`;
          await putRecord<VaultEntry>(STORES.file_vault, {
            vaultKey,
            projectId,
            namespace: 'generated_audio',
            fileName: `${seg.segmentId}.wav`,
            mimeType: 'audio/wav',
            sizeBytes: wavBlob.size,
            blob: wavBlob,
            storedAt: now,
          });

          await putRecord<DialogueSegment>(STORES.dialogue_segments, {
            ...seg,
            actingDirective: directive,
            generatedAudioRef: vaultKey,
            actualGeneratedDurationMs: durationMs,
            updatedAt: now,
          });
          generatedCount += 1;
        }

        return {
          status: 'completed',
          outputSummary: `${engineLabel} synthesized ${generatedCount} real Hindi WAV file(s) with acting directives into generated_audio storage.`,
          errorMessage: null,
          executionEngine: engineLabel,
        };
      }

      case 'synchronization': {
        const segments = (
          await getByIndex<DialogueSegment>(STORES.dialogue_segments, 'projectId', projectId)
        ).sort((a, b) => a.originalStartMs - b.originalStartMs);

        if (segments.length === 0) {
          return {
            status: 'completed_with_warnings',
            outputSummary: 'No dialogue segments available for timeline synchronization.',
            errorMessage: null,
          };
        }

        const tracks = await getByIndex<TimelineTrack>(
          STORES.timeline_tracks,
          'projectId',
          projectId
        );
        const dialogueTrack = tracks.find((t) => t.kind === 'dialogue');
        let syncedCount = 0;
        let wsolaAdjustedCount = 0;
        let reviewCount = 0;
        const now = new Date().toISOString();

        for (let i = 0; i < segments.length; i += 1) {
          const seg = segments[i];
          const nextSeg = segments[i + 1] ?? null;

          if (!seg.generatedAudioRef) {
            await putRecord<DialogueSegment>(STORES.dialogue_segments, {
              ...seg,
              timingMatchLabel: 'Unresolved',
              updatedAt: now,
            });
            continue;
          }

          const wavEntry = await getRecord<VaultEntry>(
            STORES.file_vault,
            seg.generatedAudioRef
          );
          if (!wavEntry) {
            await putRecord<DialogueSegment>(STORES.dialogue_segments, {
              ...seg,
              timingMatchLabel: 'Unresolved',
              syncStatus: 'unmeasured',
              updatedAt: now,
            });
            continue;
          }

          // CRITICAL REPAIR: Physically apply pitch-preserving WSOLA time-stretching to WAV PCM
          // and re-measure exact output duration (never silently truncating speech!)
          const realSync = await applyRealSyncToGeneratedWavBlob({
            wavBlob: wavEntry.blob,
            originalStartMs: seg.originalStartMs,
            originalEndMs: seg.originalEndMs,
            preferredShiftLimitMs:
              seg.preferredShiftLimitMs || settings.preferredTimingAdjustmentMs,
            nextSegmentStartMs: nextSeg?.originalStartMs ?? null,
          });

          if (realSync.modifiedPcm) {
            wsolaAdjustedCount += 1;
            await putRecord<VaultEntry>(STORES.file_vault, {
              ...wavEntry,
              blob: realSync.synchronizedWavBlob,
              sizeBytes: realSync.synchronizedWavBlob.size,
              storedAt: now,
            });
          }

          const sync = realSync.outcome;
          const absDelta = Math.abs(sync.syncDeltaMs);
          const timingMatchLabel: DialogueSegment['timingMatchLabel'] =
            sync.syncStatus === 'needs_adjustment'
              ? 'Needs Review'
              : absDelta <= 150
              ? 'Matched'
              : 'Close Match';

          if (sync.reviewStatus === 'needs_review') reviewCount += 1;

          await putRecord<DialogueSegment>(STORES.dialogue_segments, {
            ...seg,
            actualGeneratedDurationMs: sync.actualGeneratedDurationMs,
            finalStartMs: sync.finalStartMs,
            finalEndMs: sync.finalEndMs,
            syncDeltaMs: sync.syncDeltaMs,
            appliedSpeedMultiplier: sync.appliedSpeedMultiplier,
            syncStatus: sync.syncStatus,
            timingMatchLabel,
            reviewStatus:
              seg.reviewStatus === 'approved' ? 'approved' : sync.reviewStatus,
            updatedAt: now,
          });

          const realPeaks = await computeWaveformPeaksFromBlob(
            realSync.synchronizedWavBlob,
            64
          );

          if (dialogueTrack) {
            const existingClip = await getRecord<AudioClip>(
              STORES.audio_clips,
              `clip_${seg.segmentId}`
            );
            await putRecord<AudioClip>(STORES.audio_clips, {
              clipId: `clip_${seg.segmentId}`,
              projectId,
              trackId: existingClip?.trackId ?? dialogueTrack.trackId,
              segmentId: seg.segmentId,
              label: `${seg.sourceSpeakerId}: ${seg.hindiText || seg.japaneseText}`.slice(0, 48),
              startMs: sync.finalStartMs,
              endMs: sync.finalEndMs,
              durationMs: Math.max(100, sync.finalEndMs - sync.finalStartMs),
              sourceNamespace: 'generated_audio',
              sourceRef: seg.generatedAudioRef,
              hasRealAudio: true,
              waveformPeaks: realPeaks,
              volumeDb: existingClip?.volumeDb ?? 0,
              fadeInMs: existingClip?.fadeInMs ?? 15,
              fadeOutMs: existingClip?.fadeOutMs ?? 20,
            });
          }
          syncedCount += 1;
        }

        return {
          status: reviewCount > 0 ? 'needs_review' : 'completed',
          outputSummary: `Synchronized ${syncedCount} Hindi WAV clip(s) (${wsolaAdjustedCount} physically time-stretched with pitch-preserving WSOLA [0.88×–1.15×], ${reviewCount} flagged for phrasing/timing review; zero silent truncation).`,
          errorMessage: null,
          executionEngine: 'Pitch-Preserving WSOLA Synchronizer (Real PCM)',
        };
      }

      case 'sound_classification': {
        const stereo = await this.ensureDecodedStereo(scratch);
        if (!stereo) {
          return {
            status: 'completed_with_warnings',
            outputSummary:
              'Decoded PCM audio unavailable for Sound Classification; preserving source audio untouched.',
            errorMessage: null,
          };
        }

        const segments = await getByIndex<DialogueSegment>(
          STORES.dialogue_segments,
          'projectId',
          projectId
        );
        const speechHints =
          segments.length > 0
            ? segments.map((s) => ({ startMs: s.originalStartMs, endMs: s.originalEndMs }))
            : scratch.speakerTurns.map((t) => ({ startMs: t.startMs, endMs: t.endMs }));

        const soundEvents = classifyAudioSoundEventsChunked(
          projectId,
          stereo,
          scratch.media?.chunkPlan ?? [],
          speechHints
        );
        scratch.soundEvents = soundEvents;

        if (soundEvents.length > 0) {
          await putManyRecords(STORES.sound_events, soundEvents);
        }

        const preservedCount = soundEvents.filter((e) => e.preserveOriginal).length;
        const songCount = soundEvents.filter((e) => e.category === 'song').length;

        return {
          status: 'completed',
          outputSummary: `Heuristic DSP classifier identified ${soundEvents.length} region(s) across 12 sound classes: ${preservedCount} preserved (${songCount} vocal song region(s) shielded from vocal cancellation).`,
          errorMessage: null,
          executionEngine: 'Heuristic Multi-Feature Spectral/Harmonic Classifier (DSP)',
        };
      }

      case 'audio_separation': {
        const stereo = await this.ensureDecodedStereo(scratch);
        if (!stereo) {
          return {
            status: 'completed_with_warnings',
            outputSummary:
              'Decoded stereo PCM unavailable for audio separation; original media remains immutable.',
            errorMessage: null,
          };
        }

        // Check if user supplied a clean dialogue-free M&E stem first!
        const existingStems = await getByIndex<AudioStemRecord>(
          STORES.audio_stems,
          'projectId',
          projectId
        );
        const extMeRecord = existingStems.find((s) => s.stemType === 'external_me_stem') ?? null;
        let externalCleanMe: DecodedAudioStereo | null = null;
        if (extMeRecord) {
          const extEntry = await getRecord<VaultEntry>(STORES.file_vault, extMeRecord.vaultKey);
          if (extEntry) {
            externalCleanMe = await decodeStoredWavBlobToStereo(extEntry.blob);
            if (!externalCleanMe) {
              try {
                externalCleanMe = await decodeMediaBlobToStereo(extEntry.blob);
              } catch {
                externalCleanMe = null;
              }
            }
          }
        }

        const soundEvents =
          scratch.soundEvents.length > 0
            ? scratch.soundEvents
            : await getByIndex<SoundEventRecord>(STORES.sound_events, 'projectId', projectId);

        const segments = await getByIndex<DialogueSegment>(
          STORES.dialogue_segments,
          'projectId',
          projectId
        );
        const dialogueWindows =
          segments.length > 0
            ? segments.map((s) => ({ startMs: s.originalStartMs, endMs: s.originalEndMs }))
            : scratch.speakerTurns.map((t) => ({ startMs: t.startMs, endMs: t.endMs }));

        const separated = separateAudioStemsConservative({
          stereoLeft: stereo.left,
          stereoRight: stereo.right,
          sourceChannels: stereo.channels,
          sampleRate: stereo.sampleRate,
          soundEvents,
          dialogueWindows,
          externalCleanMe,
        });

        scratch.backgroundLeft = separated.backgroundLeft;
        scratch.backgroundRight = separated.backgroundRight;
        scratch.backgroundSampleRate = separated.sampleRate;

        const now = new Date().toISOString();
        const dialogueBlob = encodeFloat32ToWavBlob(
          separated.dialogueSamples,
          separated.sampleRate
        );
        // Preserve FULL STEREO (44.1 / 48 kHz) background stem!
        const bgBlob = encodeStereoToWavBlob(
          separated.backgroundLeft,
          separated.backgroundRight,
          separated.sampleRate
        );

        const dlgKey = `generated_audio/${projectId}/dialogue_stem.wav`;
        const bgKey = `generated_audio/${projectId}/background_stem.wav`;

        await putManyRecords<VaultEntry>(STORES.file_vault, [
          {
            vaultKey: dlgKey,
            projectId,
            namespace: 'generated_audio',
            fileName: 'dialogue_stem.wav',
            mimeType: 'audio/wav',
            sizeBytes: dialogueBlob.size,
            blob: dialogueBlob,
            storedAt: now,
          },
          {
            vaultKey: bgKey,
            projectId,
            namespace: 'generated_audio',
            fileName: 'background_stem.wav',
            mimeType: 'audio/wav',
            sizeBytes: bgBlob.size,
            blob: bgBlob,
            storedAt: now,
          },
        ]);

        const dlgStem = buildAudioStemRecord({
          projectId,
          stemType: 'dialogue_stem',
          vaultKey: dlgKey,
          sampleRate: separated.sampleRate,
          channels: 1,
          durationMs: separated.durationMs,
          sizeBytes: dialogueBlob.size,
          separationMethod: separated.separationMethod,
          confidence: separated.confidence,
          residualDialogueLeakageDb: separated.residualDialogueLeakageDb,
          artifactRiskScore: separated.artifactRiskScore,
          isExternalCleanStem: separated.isExternalCleanStem,
          artifactWarning: separated.artifactWarning,
        });
        const bgStem = buildAudioStemRecord({
          projectId,
          stemType: 'background_stem',
          vaultKey: bgKey,
          sampleRate: separated.sampleRate,
          channels: 2,
          durationMs: separated.durationMs,
          sizeBytes: bgBlob.size,
          separationMethod: separated.separationMethod,
          confidence: separated.confidence,
          residualDialogueLeakageDb: separated.residualDialogueLeakageDb,
          artifactRiskScore: separated.artifactRiskScore,
          isExternalCleanStem: separated.isExternalCleanStem,
          artifactWarning: separated.artifactWarning,
        });
        await putManyRecords(STORES.audio_stems, [dlgStem, bgStem]);

        const tracks = await getByIndex<TimelineTrack>(
          STORES.timeline_tracks,
          'projectId',
          projectId
        );
        const musicTrack = tracks.find((t) => t.kind === 'music_sfx');
        if (musicTrack && separated.durationMs > 0) {
          const bgPeaks = computeRealWaveformPeaks(separated.backgroundSamples, 140);
          await putRecord<AudioClip>(STORES.audio_clips, {
            clipId: `clip_bg_stem_${projectId}`,
            projectId,
            trackId: musicTrack.trackId,
            segmentId: null,
            label: separated.isExternalCleanStem
              ? 'Clean M&E Stem (Stereo)'
              : `Preserved Stereo Music & SFX (${separated.sampleRate} Hz)`,
            startMs: 0,
            endMs: separated.durationMs,
            durationMs: separated.durationMs,
            sourceNamespace: 'generated_audio',
            sourceRef: bgKey,
            hasRealAudio: true,
            waveformPeaks: bgPeaks,
            volumeDb: 0,
            fadeInMs: 0,
            fadeOutMs: 0,
          });
        }

        return {
          status: separated.isExternalCleanStem ? 'completed' : 'completed_with_warnings',
          outputSummary: `${separated.separationMethod} wrote stereo background_stem.wav (${(
            separated.durationMs / 1000
          ).toFixed(1)}s, residual dialogue leakage: ${
            separated.residualDialogueLeakageDb !== null
              ? `${separated.residualDialogueLeakageDb} dB`
              : 'n/a'
          }).`,
          errorMessage: null,
          executionEngine: separated.separationMethod,
        };
      }

      case 'audio_mixing': {
        return await this.runAudioMixingForProject(projectId);
      }

      case 'quality_assurance': {
        const qaRes = await this.runQualityAssuranceForProject(projectId, settings);
        scratch.lastQAReport = qaRes;
        return {
          status:
            qaRes.overallStatus === 'failed'
              ? 'needs_review'
              : qaRes.overallStatus === 'warning' || qaRes.overallStatus === 'needs_review'
              ? 'completed_with_warnings'
              : 'completed',
          outputSummary: `18-Check QA (${qaRes.overallStatus}): ${qaRes.passedCount} passed, ${qaRes.warningCount} warning(s), ${qaRes.failedCount} failed, ${qaRes.reviewRequiredCount} review item(s). ${
            qaRes.acousticMetrics
              ? `Stereo Master ${qaRes.acousticMetrics.sampleRate ?? ''}Hz · Peak ${qaRes.acousticMetrics.peakDbfs} dBFS · Clipping: ${qaRes.acousticMetrics.clippingSampleCount}.`
              : ''
          }`.trim(),
          errorMessage: null,
          executionEngine: qaRes.semanticQAResult?.executed
            ? `18-Check Acoustic/Structural QA + ${qaRes.semanticQAResult.engine}`
            : '18-Check Local Acoustic & Structural QA',
        };
      }

      default:
        return {
          status: 'not_integrated',
          outputSummary: `${def.integrationMilestone} — awaiting integration.`,
          errorMessage: null,
        };
    }
  }

  /**
   * Reusable Agent #23 Stereo Multitrack Audio Mixing entry point (44.1 / 48 kHz Stereo).
   */
  async runAudioMixingForProject(projectId: string): Promise<SingleAgentOutcome> {
    const [tracks, clips, stems, soundEvents, metaList, versions] = await Promise.all([
      getByIndex<TimelineTrack>(STORES.timeline_tracks, 'projectId', projectId),
      getByIndex<AudioClip>(STORES.audio_clips, 'projectId', projectId),
      getByIndex<AudioStemRecord>(STORES.audio_stems, 'projectId', projectId),
      getByIndex<SoundEventRecord>(STORES.sound_events, 'projectId', projectId),
      getByIndex<MediaMetadata>(STORES.media_metadata, 'projectId', projectId),
      getByIndex<ProjectVersion>(STORES.project_versions, 'projectId', projectId),
    ]);

    const trackById = new Map(tracks.map((t) => [t.trackId, t]));

    // Prefer user-imported clean M&E stem, then separated stereo background stem, then native stereo original
    let bgStereo: DecodedAudioStereo | null = null;
    const preferredBgStem =
      stems.find((s) => s.stemType === 'external_me_stem') ??
      stems.find((s) => s.stemType === 'background_stem') ??
      null;

    if (preferredBgStem) {
      const entry = await getRecord<VaultEntry>(STORES.file_vault, preferredBgStem.vaultKey);
      if (entry) {
        bgStereo = await decodeStoredWavBlobToStereo(entry.blob);
        if (!bgStereo) {
          try {
            bgStereo = await decodeMediaBlobToStereo(entry.blob);
          } catch {
            bgStereo = null;
          }
        }
      }
    }

    if (!bgStereo) {
      const mediaList = await getByIndex<ImportedMedia>(
        STORES.imported_media,
        'projectId',
        projectId
      );
      if (mediaList[0]?.vaultKey) {
        const origEntry = await getRecord<VaultEntry>(
          STORES.file_vault,
          mediaList[0].vaultKey
        );
        if (origEntry) {
          try {
            bgStereo = await decodeMediaBlobToStereo(
              origEntry.blob,
              mediaList[0].fileExtension
            );
          } catch {
            bgStereo = null;
          }
        }
      }
    }

    const dialogueInputs: MixDialogueClipInput[] = [];
    for (const clip of clips) {
      const tr = trackById.get(clip.trackId);
      if (!tr || (tr.kind !== 'dialogue' && tr.kind !== 'character')) continue;
      if (!clip.hasRealAudio || !clip.sourceRef) continue;
      const entry = await getRecord<VaultEntry>(STORES.file_vault, clip.sourceRef);
      if (!entry) continue;
      const buf = await entry.blob.arrayBuffer();
      const wav = decodePcmWavBuffer(buf);
      if (wav) {
        dialogueInputs.push({
          clip,
          track: tr,
          samples: wav.samples,
          sampleRate: wav.sampleRate,
        });
      }
    }

    if (!bgStereo && dialogueInputs.length === 0) {
      return {
        status: 'completed_with_warnings',
        outputSummary:
          'No decoded background stem or generated Hindi dialogue WAV clips available to render stereo master mix yet.',
        errorMessage: null,
        executionEngine: 'Stereo Multitrack Mastering Mixer',
      };
    }

    const targetRate = bgStereo && bgStereo.sampleRate >= 44100 ? bgStereo.sampleRate : 48000;
    const mix = mixFinalDubAudio({
      tracks,
      backgroundSamples: null,
      backgroundLeft: bgStereo?.left ?? null,
      backgroundRight: bgStereo?.right ?? null,
      backgroundSampleRate: bgStereo?.sampleRate ?? targetRate,
      dialogueInputs,
      soundEvents,
      totalDurationMs: metaList[0]?.durationMs ?? 0,
      targetSampleRate: targetRate,
    });

    const now = new Date().toISOString();
    const mixVaultKey = `exported_results/${projectId}/final_dub_master.wav`;
    await putRecord<VaultEntry>(STORES.file_vault, {
      vaultKey: mixVaultKey,
      projectId,
      namespace: 'exported_results',
      fileName: 'final_dub_master.wav',
      mimeType: 'audio/wav',
      sizeBytes: mix.wavBlob.size,
      blob: mix.wavBlob,
      storedAt: now,
    });

    const mixStem = buildAudioStemRecord({
      projectId,
      stemType: 'final_mix',
      vaultKey: mixVaultKey,
      sampleRate: mix.sampleRate,
      channels: 2,
      durationMs: mix.durationMs,
      sizeBytes: mix.wavBlob.size,
      separationMethod: `Stereo Multitrack Mix (${mix.sampleRate} Hz Stereo · ${dialogueInputs.length} Hindi clip(s) + Ducking + -1.0 dBFS Stereo Limiter)`,
      confidence: dialogueInputs.length > 0 ? 0.94 : 0.72,
      isExternalCleanStem: preferredBgStem?.stemType === 'external_me_stem',
      artifactWarning:
        dialogueInputs.length === 0
          ? 'Rendered preserved stereo background/M&E master only (0 generated Hindi dialogue clips present yet).'
          : null,
    });
    await putRecord(STORES.audio_stems, mixStem);

    const nextVersionNumber =
      versions.reduce((max, v) => Math.max(max, v.versionNumber), 0) + 1;
    await putRecord<ProjectVersion>(STORES.project_versions, {
      id: `ver_${projectId}_${nextVersionNumber}`,
      projectId,
      versionNumber: nextVersionNumber,
      label: `v${nextVersionNumber}.0 Stereo Dub Mix Master`,
      createdAt: now,
      summary: `Mixed ${dialogueInputs.length} Hindi clip(s) at ${mix.sampleRate} Hz Stereo (${(
        mix.durationMs / 1000
      ).toFixed(1)}s · Peak ${mix.metrics.peakDbfs} dBFS · RMS ${mix.metrics.rmsDbfs} dBFS).`,
    });

    return {
      status: dialogueInputs.length > 0 ? 'completed' : 'completed_with_warnings',
      outputSummary: `Rendered stereo final_dub_master.wav (${mix.sampleRate} Hz 2ch · ${(
        mix.durationMs / 1000
      ).toFixed(1)}s · ${dialogueInputs.length} Hindi clip(s) · Peak ${
        mix.metrics.peakDbfs
      } dBFS · Clipping: ${mix.metrics.clippingSampleCount}).`,
      errorMessage: null,
      executionEngine: `Stereo Multitrack Mastering Mixer (${mix.sampleRate} Hz Stereo)`,
    };
  }

  /**
   * Reusable Agent #24 Comprehensive 18-Check Quality Assurance Audit
   * with separate Semantic QA execution and explicit responsible-agent issue attribution.
   */
  async runQualityAssuranceForProject(
    projectId: string,
    settings: AppSettings
  ): Promise<QAReport> {
    const [projectRec, segments, allCharacters, clips, stems, soundEvents, pronunciations] =
      await Promise.all([
        getRecord<Project>(STORES.projects, projectId),
        getByIndex<DialogueSegment>(STORES.dialogue_segments, 'projectId', projectId),
        getAllRecords<CharacterProfile>(STORES.characters),
        getByIndex<AudioClip>(STORES.audio_clips, 'projectId', projectId),
        getByIndex<AudioStemRecord>(STORES.audio_stems, 'projectId', projectId),
        getByIndex<SoundEventRecord>(STORES.sound_events, 'projectId', projectId),
        getAllRecords<PronunciationEntry>(STORES.pronunciation_entries),
      ]);

    const seriesScope = projectRec?.seriesTitle || 'Default Series';
    const characters = allCharacters.filter(
      (c) =>
        c.projectId === projectId ||
        c.seriesScope.trim().toLowerCase() === seriesScope.trim().toLowerCase()
    );

    const issues: QAIssue[] = [];
    const checks: QACheckSummaryItem[] = [];
    let passedCount = 0;
    let warningCount = 0;
    let failedCount = 0;
    let reviewRequiredCount = 0;

    // 1. Acoustic QA on Final Master Mix WAV (stereo-aware)
    let acousticMetrics: AcousticQAMetrics | null = null;
    const finalMixStem =
      stems.find((s) => s.stemType === 'final_mix') ??
      stems.find((s) => s.stemType === 'background_stem') ??
      null;

    if (finalMixStem) {
      const entry = await getRecord<VaultEntry>(STORES.file_vault, finalMixStem.vaultKey);
      if (entry) {
        const decodedStereo = await decodeStoredWavBlobToStereo(entry.blob);
        if (decodedStereo) {
          acousticMetrics = measureStereoAcousticQAMetrics(
            decodedStereo.left,
            decodedStereo.right,
            decodedStereo.sampleRate,
            null,
            finalMixStem.vaultKey
          );
          acousticMetrics.channels = decodedStereo.channels;
          if (acousticMetrics.clippingSampleCount > 0) {
            failedCount += 1;
            issues.push({
              id: `qa_acoustic_clipping_${projectId}`,
              segmentId: null,
              category: 'audio_quality',
              severity: 'error',
              message: `Detected ${acousticMetrics.clippingSampleCount} clipped sample(s) in ${finalMixStem.stemType} (Peak ${acousticMetrics.peakDbfs} dBFS).`,
              evidence: `Peak=${acousticMetrics.peakDbfs} dBFS, ClippedSamples=${acousticMetrics.clippingSampleCount}`,
              responsibleAgent: 'audio_mixing',
              resolutionState: 'open',
              retryCount: 0,
              finalReviewStatus: 'needs_review',
              resolved: false,
            });
          }
          if (!acousticMetrics.exportIntegrityVerified) {
            warningCount += 1;
            issues.push({
              id: `qa_acoustic_silent_${projectId}`,
              segmentId: null,
              category: 'audio_quality',
              severity: 'warning',
              message: `Rendered audio master ${finalMixStem.vaultKey} appears near-silent (Peak ${acousticMetrics.peakDbfs} dBFS).`,
              evidence: `Peak=${acousticMetrics.peakDbfs} dBFS, SilenceRatio=${acousticMetrics.silenceRatio}`,
              responsibleAgent: 'audio_mixing',
              resolutionState: 'open',
              retryCount: 0,
              finalReviewStatus: 'needs_review',
              resolved: false,
            });
          }
        }
      }
    }

    // Check #14: Stereo & Sample-Rate Integrity
    const isStereoMaster = Boolean(
      acousticMetrics && (acousticMetrics.channels ?? 1) >= 2 && (acousticMetrics.sampleRate ?? 0) >= 44100
    );
    if (acousticMetrics && !isStereoMaster) {
      warningCount += 1;
      issues.push({
        id: `qa_stereo_integrity_${projectId}`,
        segmentId: null,
        category: 'stereo_integrity',
        severity: 'warning',
        message: `Master output is ${acousticMetrics.channels ?? 1}ch @ ${acousticMetrics.sampleRate ?? 0} Hz (studio stereo target is 2ch @ 44.1/48 kHz).`,
        evidence: `channels=${acousticMetrics.channels}, sampleRate=${acousticMetrics.sampleRate}`,
        responsibleAgent: 'audio_mixing',
        resolutionState: 'open',
        retryCount: 0,
        finalReviewStatus: 'needs_review',
        resolved: false,
      });
    }

    // Check #13: Residual Japanese Dialogue Leakage
    const bgStem = stems.find((s) => s.stemType === 'background_stem');
    const extMeStem = stems.find((s) => s.stemType === 'external_me_stem');
    const residualLeakageDb = extMeStem
      ? -48
      : bgStem?.residualDialogueLeakageDb ?? null;

    if (bgStem?.artifactWarning && !extMeStem) {
      issues.push({
        id: `qa_leakage_${projectId}`,
        segmentId: null,
        category: 'leakage',
        severity:
          residualLeakageDb !== null && residualLeakageDb > -10 ? 'review_required' : 'warning',
        message: bgStem.artifactWarning,
        evidence: `ResidualDialogueLeakage=${residualLeakageDb !== null ? `${residualLeakageDb} dB` : 'unmeasured'}, ArtifactRisk=${bgStem.artifactRiskScore ?? 'n/a'}`,
        responsibleAgent: 'audio_separation',
        resolutionState: 'manual_review_required',
        retryCount: 0,
        finalReviewStatus: 'needs_review',
        resolved: false,
      });
    }

    // Check #12: Song / OP-ED Preservation
    const protectedSongs = soundEvents.filter((e) => e.category === 'song').length;
    if (protectedSongs > 0) {
      issues.push({
        id: `qa_song_preserve_${projectId}`,
        segmentId: null,
        category: 'sound_preservation',
        severity: 'review_required',
        message: `${protectedSongs} vocal song/OP-ED region(s) shielded from vocal cancellation — verify Hindi dialogue does not overlap singing.`,
        evidence: `ProtectedSongs=${protectedSongs}`,
        responsibleAgent: 'sound_classification',
        resolutionState: 'manual_review_required',
        retryCount: 0,
        finalReviewStatus: 'needs_review',
        resolved: false,
      });
    }

    // Check #11: Overlapping dialogue clips
    const dialogueClips = clips.filter((c) => Boolean(c.segmentId));
    const overlaps = findOverlappingClips(dialogueClips);
    for (const [cA, cB] of overlaps.slice(0, 8)) {
      issues.push({
        id: `qa_overlap_${cA.clipId}_${cB.clipId}`,
        segmentId: cA.segmentId,
        clipId: cA.clipId,
        category: 'timing',
        severity: 'warning',
        message: `Overlapping dialogue clips "${cA.label}" and "${cB.label}" — verify intentional anime overlap in Audio Studio.`,
        evidence: `ClipA=[${cA.startMs}..${cA.endMs}ms], ClipB=[${cB.startMs}..${cB.endMs}ms]`,
        responsibleAgent: 'synchronization',
        resolutionState: 'open',
        retryCount: 0,
        finalReviewStatus: 'needs_review',
        resolved: false,
      });
    }

    // Track aggregates for the 18 explicit checks
    let emptyJapaneseCount = 0;
    let emptyHindiCount = 0;
    let disagreementCount = 0;
    let pronunciationMissCount = 0;
    let unassignedSpeakerCount = 0;
    let missingVoiceCount = 0;
    let missingActingCount = 0;
    let timingOutOfTolCount = 0;
    let wsolaNeedsAdjCount = 0;
    let missingAudioCount = 0;
    let clipClippingCount = 0;

    for (const seg of segments) {
      let segHasError = false;
      let segHasWarning = false;
      let segNeedsReview = false;
      const linkedClip = clips.find((c) => c.segmentId === seg.segmentId) ?? null;

      if (!seg.japaneseText.trim()) {
        emptyJapaneseCount += 1;
        segHasWarning = true;
        issues.push({
          id: `qa_${seg.segmentId}_jp`,
          segmentId: seg.segmentId,
          clipId: linkedClip?.clipId ?? null,
          category: 'asr_quality',
          severity: 'warning',
          message: `${seg.segmentId}: Source Japanese transcription is empty.`,
          evidence: 'japaneseText.length === 0',
          responsibleAgent: 'japanese_asr',
          resolutionState: 'open',
          retryCount: 0,
          finalReviewStatus: 'needs_review',
          resolved: false,
        });
      }

      if (!seg.hindiText.trim()) {
        emptyHindiCount += 1;
        segHasError = true;
        issues.push({
          id: `qa_${seg.segmentId}_hi`,
          segmentId: seg.segmentId,
          clipId: linkedClip?.clipId ?? null,
          category: 'translation',
          severity: 'error',
          message: `${seg.segmentId}: Missing Hindi translation text.`,
          evidence: 'hindiText.length === 0',
          responsibleAgent: 'translation',
          resolutionState: 'open',
          retryCount: 0,
          finalReviewStatus: 'needs_review',
          resolved: false,
        });
      }

      if (seg.sourceSpeakerId === 'UNASSIGNED_SPEAKER') {
        unassignedSpeakerCount += 1;
        segNeedsReview = true;
        issues.push({
          id: `qa_${seg.segmentId}_spk`,
          segmentId: seg.segmentId,
          clipId: linkedClip?.clipId ?? null,
          category: 'speaker_identity',
          severity: 'review_required',
          message: `${seg.segmentId}: Speaker could not be matched to a diarized turn (UNASSIGNED_SPEAKER). Assign speaker manually.`,
          evidence: 'sourceSpeakerId === UNASSIGNED_SPEAKER',
          responsibleAgent: 'speaker_diarization',
          resolutionState: 'manual_review_required',
          retryCount: 0,
          finalReviewStatus: 'needs_review',
          resolved: false,
        });
      }

      // Check #4: Pronunciation glossary consistency
      if (seg.hindiText.trim() && pronunciations.length > 0) {
        for (const p of pronunciations) {
          if (
            seg.japaneseText.includes(p.sourceTerm) &&
            p.targetHindiForm &&
            !seg.hindiText.includes(p.targetHindiForm)
          ) {
            pronunciationMissCount += 1;
            segHasWarning = true;
            issues.push({
              id: `qa_${seg.segmentId}_pron_${p.id}`,
              segmentId: seg.segmentId,
              clipId: linkedClip?.clipId ?? null,
              category: 'pronunciation',
              severity: 'warning',
              message: `${seg.segmentId}: Glossary term "${p.sourceTerm}" expected Hindi form "${p.targetHindiForm}".`,
              evidence: `Source contains "${p.sourceTerm}", Hindi missing "${p.targetHindiForm}"`,
              responsibleAgent: 'pronunciation',
              resolutionState: 'open',
              retryCount: 0,
              finalReviewStatus: 'needs_review',
              resolved: false,
            });
            break;
          }
        }
      }

      if (seg.collaborativeMeta?.disagreementFlag) {
        disagreementCount += 1;
        segNeedsReview = true;
        issues.push({
          id: `qa_${seg.segmentId}_collab_disagree`,
          segmentId: seg.segmentId,
          clipId: linkedClip?.clipId ?? null,
          category: 'cultural_nuance',
          severity: 'review_required',
          message: `${seg.segmentId}: Gemini & Local models disagreed — inspect alternatives in Translation Studio.`,
          evidence: seg.collaborativeMeta.evidence ?? 'disagreementFlag=true',
          responsibleAgent: 'translation',
          resolutionState: 'manual_review_required',
          retryCount: 0,
          finalReviewStatus: 'needs_review',
          resolved: false,
        });
      }

      if (!seg.actingDirective) {
        missingActingCount += 1;
      }

      const timingEval = evaluateTimingAdjustment(
        seg.originalStartMs,
        seg.finalStartMs,
        seg.preferredShiftLimitMs || settings.preferredTimingAdjustmentMs
      );
      if (!timingEval.withinPreferredRange) {
        timingOutOfTolCount += 1;
        segHasWarning = true;
        segNeedsReview = true;
        issues.push({
          id: `qa_${seg.segmentId}_timing`,
          segmentId: seg.segmentId,
          clipId: linkedClip?.clipId ?? null,
          category: 'timing',
          severity: 'warning',
          message: `${seg.segmentId}: ${timingEval.label}.`,
          evidence: `originalStart=${seg.originalStartMs}ms, finalStart=${seg.finalStartMs}ms`,
          responsibleAgent: 'synchronization',
          resolutionState: 'open',
          retryCount: 0,
          finalReviewStatus: 'needs_review',
          resolved: false,
        });
      }

      if (seg.syncStatus === 'needs_adjustment') {
        wsolaNeedsAdjCount += 1;
        segNeedsReview = true;
        issues.push({
          id: `qa_${seg.segmentId}_wsola`,
          segmentId: seg.segmentId,
          clipId: linkedClip?.clipId ?? null,
          category: 'timing',
          severity: 'review_required',
          message: `${seg.segmentId}: Hindi duration exceeds 1.15× natural WSOLA limit (delta ${seg.syncDeltaMs ?? 0} ms) — shorten Hindi phrasing instead of truncating.`,
          evidence: `appliedSpeed=${seg.appliedSpeedMultiplier ?? 1}x, syncDeltaMs=${seg.syncDeltaMs ?? 0}`,
          responsibleAgent: 'translation',
          resolutionState: 'manual_review_required',
          retryCount: 0,
          finalReviewStatus: 'needs_review',
          resolved: false,
        });
      }

      if (!seg.assignedHindiVoiceId) {
        missingVoiceCount += 1;
        segNeedsReview = true;
        issues.push({
          id: `qa_${seg.segmentId}_voice`,
          segmentId: seg.segmentId,
          clipId: linkedClip?.clipId ?? null,
          category: 'voice',
          severity: 'review_required',
          message: `${seg.segmentId}: No permanent Hindi Voice ID assigned yet.`,
          evidence: 'assignedHindiVoiceId === null',
          responsibleAgent: 'voice_assignment',
          resolutionState: 'open',
          retryCount: 0,
          finalReviewStatus: 'needs_review',
          resolved: false,
        });
      }

      if (!seg.generatedAudioRef) {
        missingAudioCount += 1;
        segHasWarning = true;
        issues.push({
          id: `qa_${seg.segmentId}_audio`,
          segmentId: seg.segmentId,
          clipId: linkedClip?.clipId ?? null,
          category: 'audio_quality',
          severity: 'warning',
          message: `${seg.segmentId}: Generated Hindi WAV audio not synthesized yet.`,
          evidence: 'generatedAudioRef === null',
          responsibleAgent: 'hindi_tts',
          resolutionState: 'open',
          retryCount: 0,
          finalReviewStatus: 'needs_review',
          resolved: false,
        });
      } else {
        const entry = await getRecord<VaultEntry>(STORES.file_vault, seg.generatedAudioRef);
        if (entry) {
          const decoded = decodePcmWavBuffer(await entry.blob.arrayBuffer());
          if (decoded) {
            const clipMetrics = measureAcousticQAMetrics(decoded.samples, decoded.sampleRate);
            if (clipMetrics.clippingSampleCount > 0) {
              clipClippingCount += 1;
              segHasWarning = true;
              issues.push({
                id: `qa_${seg.segmentId}_clipping`,
                segmentId: seg.segmentId,
                clipId: linkedClip?.clipId ?? null,
                category: 'audio_quality',
                severity: 'warning',
                message: `${seg.segmentId}: Synthesized WAV has ${clipMetrics.clippingSampleCount} clipped sample(s) (Peak ${clipMetrics.peakDbfs} dBFS).`,
                evidence: `ClipPeak=${clipMetrics.peakDbfs} dBFS`,
                responsibleAgent: 'hindi_tts',
                resolutionState: 'open',
                retryCount: 0,
                finalReviewStatus: 'needs_review',
                resolved: false,
              });
            }
          }
        }
      }

      if (seg.reviewStatus === 'needs_review') {
        segNeedsReview = true;
      }

      let nextQaStatus: DialogueSegment['qaStatus'] = 'passed';
      if (segHasError) {
        failedCount += 1;
        nextQaStatus = 'failed';
      } else if (segNeedsReview) {
        reviewRequiredCount += 1;
        nextQaStatus = 'needs_review';
      } else if (segHasWarning) {
        warningCount += 1;
        nextQaStatus = 'warning';
      } else {
        passedCount += 1;
      }

      await putRecord<DialogueSegment>(STORES.dialogue_segments, {
        ...seg,
        qaStatus: nextQaStatus,
      });
    }

    // Character identity uncertainty check
    let lowConfChars = 0;
    for (const ch of characters) {
      if (ch.reviewStatus === 'needs_review' || ch.identityConfidence < 0.7) {
        lowConfChars += 1;
        reviewRequiredCount += 1;
        issues.push({
          id: `qa_chr_${ch.characterId}`,
          segmentId: null,
          category: 'character_identity',
          severity: 'review_required',
          message: `Character ${ch.displayName} (${ch.characterId}) has confidence ${Math.round(
            ch.identityConfidence * 100
          )}% and requires identity review.`,
          evidence: `identityConfidence=${ch.identityConfidence}, reviewStatus=${ch.reviewStatus}`,
          responsibleAgent: 'face_voice_matching',
          resolutionState: 'manual_review_required',
          retryCount: 0,
          finalReviewStatus: 'needs_review',
          resolved: false,
        });
      }
    }

    // Check #18: Separate Independent Semantic QA Execution (never conflated with translation drafting!)
    const semanticFindings: string[] = [];
    let semanticEngine: string | null = null;
    let semanticCheckedCount = 0;
    const semanticTargets = segments
      .filter((s) => s.japaneseText.trim() && s.hindiText.trim())
      .sort((a, b) => Number(Boolean(b.collaborativeMeta?.disagreementFlag)) - Number(Boolean(a.collaborativeMeta?.disagreementFlag)))
      .slice(0, 4);

    const charById = new Map(characters.map((c) => [c.characterId, c]));
    for (const seg of semanticTargets) {
      const ch = seg.characterId ? charById.get(seg.characterId) : null;
      const semRes = await runSemanticQAReviewOnSegment({
        japaneseText: seg.japaneseText,
        hindiText: seg.hindiText,
        characterContext: ch ? `${ch.displayName} (${ch.personality})` : seg.sourceSpeakerId,
        politenessRegister: ch?.relationships[0]?.politenessRegister ?? '',
        targetDurationMs: seg.originalDurationMs,
        pronunciationRules: pronunciations,
        settings,
      });
      if (semRes.executed) {
        semanticCheckedCount += 1;
        semanticEngine = semRes.engine;
        for (const w of semRes.warnings) {
          semanticFindings.push(`${seg.segmentId}: ${w}`);
        }
      } else {
        break; // Offline or cloud disabled — do not retry remaining segments
      }
    }

    const semanticQAResult: SemanticQAResult = {
      executed: semanticCheckedCount > 0,
      engine: semanticEngine,
      checkedCount: semanticCheckedCount,
      findings: semanticFindings,
      executedAt: semanticCheckedCount > 0 ? new Date().toISOString() : null,
    };

    // Assemble all 18 explicit QA check summary items
    checks.push(
      {
        id: 'chk_01_asr',
        label: '1. Japanese ASR Completeness',
        status: segments.length === 0 ? 'skipped' : emptyJapaneseCount > 0 ? 'warning' : 'passed',
        evidence: `${segments.length - emptyJapaneseCount}/${segments.length} segments have Japanese source text`,
      },
      {
        id: 'chk_02_translation',
        label: '2. Hindi Translation Completeness',
        status: segments.length === 0 ? 'skipped' : emptyHindiCount > 0 ? 'failed' : 'passed',
        evidence: `${segments.length - emptyHindiCount}/${segments.length} segments translated into Hindi`,
      },
      {
        id: 'chk_03_cultural',
        label: '3. Cultural / Idiom Agreement',
        status: segments.length === 0 ? 'skipped' : disagreementCount > 0 ? 'review_required' : 'passed',
        evidence: `${disagreementCount} Gemini vs Local disagreement(s)`,
      },
      {
        id: 'chk_04_pronunciation',
        label: '4. Pronunciation Glossary Consistency',
        status: pronunciations.length === 0 ? 'skipped' : pronunciationMissCount > 0 ? 'warning' : 'passed',
        evidence: `${pronunciations.length} glossary rule(s) checked, ${pronunciationMissCount} mismatch(es)`,
      },
      {
        id: 'chk_05_speaker',
        label: '5. Speaker Attribution Integrity',
        status: segments.length === 0 ? 'skipped' : unassignedSpeakerCount > 0 ? 'review_required' : 'passed',
        evidence: `${unassignedSpeakerCount} unassigned speaker segment(s)`,
      },
      {
        id: 'chk_06_character',
        label: '6. Character Identity Confidence',
        status: characters.length === 0 ? 'skipped' : lowConfChars > 0 ? 'review_required' : 'passed',
        evidence: `${characters.length - lowConfChars}/${characters.length} series characters verified ≥70%`,
      },
      {
        id: 'chk_07_voice',
        label: '7. Permanent Voice Consistency',
        status: segments.length === 0 ? 'skipped' : missingVoiceCount > 0 ? 'review_required' : 'passed',
        evidence: `${segments.length - missingVoiceCount}/${segments.length} segments have assigned Hindi Voice ID`,
      },
      {
        id: 'chk_08_acting',
        label: '8. Emotion & Voice Acting Directives',
        status: segments.length === 0 ? 'skipped' : missingActingCount > 0 ? 'warning' : 'passed',
        evidence: `${segments.length - missingActingCount}/${segments.length} segments carry acting directives`,
      },
      {
        id: 'chk_09_timing',
        label: '9. Dialogue Timing Tolerance (±300ms)',
        status: segments.length === 0 ? 'skipped' : timingOutOfTolCount > 0 ? 'warning' : 'passed',
        evidence: `${timingOutOfTolCount} segment(s) shifted beyond preferred tolerance`,
      },
      {
        id: 'chk_10_wsola',
        label: '10. Real WSOLA Sync & Non-Truncation',
        status: segments.length === 0 ? 'skipped' : wsolaNeedsAdjCount > 0 ? 'review_required' : 'passed',
        evidence: `${wsolaNeedsAdjCount} segment(s) exceeded 1.15× natural WSOLA limit`,
      },
      {
        id: 'chk_11_overlap',
        label: '11. Timeline Clip Overlap Audit',
        status: dialogueClips.length === 0 ? 'skipped' : overlaps.length > 0 ? 'warning' : 'passed',
        evidence: `${overlaps.length} overlapping dialogue clip pair(s)`,
      },
      {
        id: 'chk_12_songs',
        label: '12. Vocal Song & OP-ED Preservation',
        status: soundEvents.length === 0 ? 'skipped' : protectedSongs > 0 ? 'review_required' : 'passed',
        evidence: `${protectedSongs} vocal song region(s) shielded from vocal removal`,
      },
      {
        id: 'chk_13_leakage',
        label: '13. Residual Japanese Dialogue Leakage',
        status:
          residualLeakageDb === null
            ? 'skipped'
            : extMeStem
            ? 'passed'
            : residualLeakageDb > -10
            ? 'review_required'
            : 'warning',
        evidence:
          extMeStem
            ? 'Clean M&E stem active (-48 dB leakage)'
            : residualLeakageDb !== null
            ? `Measured residual vocal level: ${residualLeakageDb} dB`
            : 'Separation not yet run',
      },
      {
        id: 'chk_14_stereo',
        label: '14. Stereo & Studio Sample-Rate Integrity',
        status: !acousticMetrics ? 'skipped' : isStereoMaster ? 'passed' : 'warning',
        evidence: acousticMetrics
          ? `${acousticMetrics.channels ?? 1}ch @ ${acousticMetrics.sampleRate ?? 0} Hz`
          : 'No master WAV rendered yet',
      },
      {
        id: 'chk_15_peak_clip',
        label: '15. True Peak & Zero-Clipping Verification',
        status:
          !acousticMetrics
            ? 'skipped'
            : acousticMetrics.clippingSampleCount > 0 || clipClippingCount > 0
            ? 'failed'
            : 'passed',
        evidence: acousticMetrics
          ? `Master peak ${acousticMetrics.peakDbfs} dBFS · ${acousticMetrics.clippingSampleCount} clipped master samples · ${clipClippingCount} clipped dialogue clip(s)`
          : 'Unmeasured',
      },
      {
        id: 'chk_16_loudness',
        label: '16. Integrated RMS Loudness & Silence Ratio',
        status:
          !acousticMetrics
            ? 'skipped'
            : acousticMetrics.silenceRatio > 0.92
            ? 'warning'
            : 'passed',
        evidence: acousticMetrics
          ? `RMS ${acousticMetrics.rmsDbfs} dBFS · Silence ratio ${Math.round(acousticMetrics.silenceRatio * 100)}%`
          : 'Unmeasured',
      },
      {
        id: 'chk_17_export',
        label: '17. Export Master & Clip WAV Integrity',
        status:
          !acousticMetrics && missingAudioCount > 0
            ? 'warning'
            : acousticMetrics?.exportIntegrityVerified && missingAudioCount === 0
            ? 'passed'
            : 'warning',
        evidence: `${segments.length - missingAudioCount}/${segments.length} dialogue WAVs present · Master integrity ${
          acousticMetrics?.exportIntegrityVerified ? 'verified' : 'pending'
        }`,
      },
      {
        id: 'chk_18_semantic',
        label: '18. Independent Semantic QA Pass',
        status: !semanticQAResult.executed
          ? 'skipped'
          : semanticFindings.length > 0
          ? 'review_required'
          : 'passed',
        evidence: semanticQAResult.executed
          ? `${semanticQAResult.engine} audited ${semanticQAResult.checkedCount} segment(s) (${semanticFindings.length} finding(s))`
          : 'Not executed (offline mode or Cloud Intelligence disabled)',
      }
    );

    const report: QAReport = {
      id: `qar_${projectId}_${Date.now()}`,
      projectId,
      createdAt: new Date().toISOString(),
      overallStatus:
        segments.length === 0 && !acousticMetrics
          ? 'not_run'
          : failedCount > 0
          ? 'failed'
          : reviewRequiredCount > 0
          ? 'needs_review'
          : warningCount > 0
          ? 'warning'
          : 'passed',
      checkedSegmentCount: segments.length,
      passedCount,
      warningCount,
      failedCount,
      reviewRequiredCount,
      issues,
      checksEvaluated: checks,
      acousticMetrics,
      semanticQAResult,
      correctionCyclesRun: 0,
      residualDialogueLeakageDb: residualLeakageDb,
      semanticReviewSummary: semanticQAResult.executed
        ? `Independent Semantic QA (${semanticQAResult.engine}) audited ${semanticQAResult.checkedCount} segment(s): ${semanticFindings.length} finding(s).`
        : 'Independent Semantic QA not executed (enable Cloud Intelligence in Settings to run Gemini Semantic QA separately from translation drafting).',
      engineNote:
        '18-Check Production QA audit completed (stereo 44.1/48 kHz acoustics, residual dialogue leakage, WSOLA sync integrity, glossary rules, speaker attribution, and separate Semantic QA).',
    };

    await putRecord(STORES.qa_reports, report);
    return report;
  }
}

export const masterOrchestrator = new MasterOrchestratorRuntime();
