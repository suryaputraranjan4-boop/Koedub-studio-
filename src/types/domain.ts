export type LanguageCode = 'ja' | 'hi' | 'en' | 'ko' | 'zh' | 'es' | 'fr';

export type MediaCategory =
  | 'anime_episode'
  | 'movie'
  | 'documentary'
  | 'educational'
  | 'podcast'
  | 'gaming'
  | 'other_spoken';

export type ProjectStatus =
  | 'draft'
  | 'imported'
  | 'analyzing'
  | 'processing'
  | 'paused'
  | 'needs_review'
  | 'completed'
  | 'failed'
  | 'interrupted';

export type JobStatus =
  | 'Waiting'
  | 'Ready'
  | 'Running'
  | 'Paused'
  | 'Completed'
  | 'Completed with Warnings'
  | 'Failed'
  | 'Cancelled'
  | 'Needs Review'
  | 'Waiting for Model';

export type ReviewStatus = 'unreviewed' | 'needs_review' | 'approved' | 'rejected';

export type SyncStatus =
  | 'pending'
  | 'unmeasured'
  | 'in_tolerance'
  | 'needs_adjustment'
  | 'manual_override'
  | 'not_integrated';

export type QAStatus = 'not_run' | 'passed' | 'warning' | 'failed' | 'needs_review';

export type StorageNamespace =
  | 'original_media'
  | 'project_metadata'
  | 'generated_audio'
  | 'temp_processing'
  | 'installed_models'
  | 'exported_results';

export type ScreenId =
  | 'home'
  | 'projects'
  | 'import'
  | 'analysis'
  | 'characters'
  | 'voices'
  | 'translation'
  | 'processing'
  | 'audio_studio'
  | 'qa'
  | 'models'
  | 'settings';

export interface Project {
  id: string;
  name: string;
  seriesTitle: string;
  episodeLabel: string;
  mediaCategory: MediaCategory;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  status: ProjectStatus;
  workingDirectoryPath: string;
  importedMediaId: string | null;
  lastCheckpointId: string | null;
  lastStageLabel: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChunkDefinition {
  index: number;
  startMs: number;
  endMs: number;
  overlapStartMs: number;
  overlapEndMs: number;
  status: 'planned' | 'processed' | 'failed';
}

export interface ImportedMedia {
  id: string;
  projectId: string;
  fileName: string;
  fileExtension: string;
  mimeType: string;
  mediaKind: 'video' | 'audio';
  sizeBytes: number;
  storageNamespace: 'original_media';
  vaultKey: string | null;
  preservedOriginal: boolean;
  importedAt: string;
  originalLastModifiedMs: number;
  chunkPlan: ChunkDefinition[];
  chunkDurationMs: number;
  chunkOverlapMs: number;
}

export interface MediaMetadata {
  id: string;
  projectId: string;
  mediaId: string;
  durationMs: number | null;
  containerFormat: string;
  sampleRateHz: number | null;
  channels: number | null;
  widthPx: number | null;
  heightPx: number | null;
  frameRateFps: number | null;
  bitrateKbps: number | null;
  decoderNotes: string;
  analyzedAt: string;
}

export interface Scene {
  id: string;
  projectId: string;
  index: number;
  startMs: number;
  endMs: number;
  contextSummary: string;
  environmentTag: string;
  detectionSource: 'unintegrated_placeholder_none' | 'manual' | 'prompt2_model';
}

export interface ExtractedFrame {
  id: string;
  projectId: string;
  sceneId: string;
  timestampMs: number;
  storageNamespace: 'temp_processing';
  vaultKey: string | null;
  widthPx: number;
  heightPx: number;
  detectedFaceCount: number;
}

export type SpeakerRoleType =
  | 'on_screen'
  | 'off_screen'
  | 'narrator'
  | 'overlapping'
  | 'ambiguous';

export interface VoiceCharacteristics {
  pitchRange: string;
  timbre: string;
  pacing: string;
  ageEstimate: string;
  genderPresentation: string;
  pitchMinHz?: number | null;
  pitchMaxHz?: number | null;
  pitchMeanHz?: number | null;
  pitchVariationHz?: number | null;
  spectralCentroidHz?: number | null;
  energyDb?: number | null;
  speakingRateCps?: number | null;
  voiceTexture?: string;
  rhythm?: string;
  resonance?: string;
  speechStyle?: string;
  vocalCategoryEstimate?: string;
  acousticMeasurementSource?: 'unmeasured' | 'web_audio_dsp';
}

export interface CharacterRelationship {
  targetCharacterId: string;
  targetName: string;
  relationType: string;
  politenessRegister: string;
  notes: string;
}

export interface VoiceAssignmentHistoryEntry {
  voiceId: string;
  voiceName: string;
  assignedAt: string;
  reason: string;
  locked: boolean;
}

export interface CharacterProfile {
  characterId: string;
  projectId: string | null; // null allows cross-episode persistent series memory
  seriesScope: string;
  displayName: string;
  visualDescriptors: string[];
  associatedSpeakerIds: string[];
  voiceCharacteristics: VoiceCharacteristics;
  assignedHindiVoiceId: string | null;
  voiceLocked: boolean;
  personality: string;
  speakingStyle: string;
  relationships: CharacterRelationship[];
  dialogueHistoryIds: string[];
  firstSeenMs: number | null;
  lastSeenMs: number | null;
  identityConfidence: number; // 0 to 1
  reviewStatus: ReviewStatus;
  speakerRole: SpeakerRoleType;
  ambiguityNote: string;
  voiceAssignmentHistory: VoiceAssignmentHistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface Speaker {
  id: string;
  projectId: string;
  speakerLabel: string;
  roleType: SpeakerRoleType;
  totalDurationMs: number;
  segmentCount: number;
  estimatedPitchHz: number | null;
  matchedCharacterId: string | null;
  matchConfidence: number;
  reviewStatus: ReviewStatus;
}

export interface CharacterSpeakerAssociation {
  id: string;
  projectId: string;
  characterId: string;
  speakerId: string;
  audioEvidenceScore: number;
  visualEvidenceScore: number;
  mouthSyncEvidenceScore: number;
  sceneContextScore: number;
  combinedConfidence: number;
  status: 'confirmed' | 'ambiguous' | 'needs_review' | 'rejected';
  updatedAt: string;
}

export interface VoiceProfile {
  voiceId: string;
  displayName: string;
  language: LanguageCode;
  locale: string;
  characteristics: string;
  genderStyle: string;
  engineRuntime: string;
  modelId: string;
  synthesisMode: 'neural_native' | 'single_speaker_dsp_preset';
  dspPitchSemitones: number;
  dspRateMultiplier: number;
  nativeEmotionControl: boolean;
  availabilityStatus: 'not_installed' | 'engine_not_integrated' | 'available';
  installStatus: 'not_installed' | 'verified_installed';
  lockedCharacterIds: string[];
  notes: string;
}

export interface VoiceAssignment {
  id: string;
  projectId: string;
  characterId: string;
  voiceId: string;
  locked: boolean;
  assignedBy: 'user' | 'agent_prompt2';
  assignedAt: string;
}

export interface EmotionMetadata {
  primaryEmotion: string;
  secondaryEmotion?: string | null;
  intensity: number; // 0 to 1
  confidence?: number; // 0 to 1
  deliveryNotes: string;
  acousticCues?: string[];
  textCues?: string[];
  source: 'unassigned' | 'manual' | 'prompt2_model' | 'acoustic_lexical_hybrid';
}

export interface WordTimestamp {
  word: string;
  startMs: number;
  endMs: number;
}

export interface VoiceActingDirective {
  emotion: string;
  intensity: number;
  speakingRateMultiplier: number;
  pitchShiftSemitones: number;
  gainDbAdjustment: number;
  pausePaddingMs: number;
  deliveryStyle: string;
  controlSource: 'post_synthesis_dsp' | 'native_tts_and_dsp';
  limitationNote: string;
}

export type CollaborationMode =
  | 'parallel'
  | 'complementary'
  | 'draft_and_review'
  | 'alternatives'
  | 'disagreement_resolution'
  | 'sequential'
  | 'offline_local';

export interface TranslationAlternative {
  id: string;
  label: string;
  hindiText: string;
  source: 'gemini' | 'local_llm' | 'nllb_local' | 'user';
  note: string;
}

export interface CollaborativeTranslationMeta {
  mode: CollaborationMode;
  geminiDraft: string | null;
  localDraft: string | null;
  selectedSource: 'gemini' | 'local_llm' | 'nllb_local' | 'hybrid_merged' | 'user';
  alternatives: TranslationAlternative[];
  culturalNote: string;
  humorOrIdiomAdapted: boolean;
  disagreementFlag: boolean;
  geminiConfidence: number | null;
  localConfidence: number | null;
  reasoning: string;
  cloudReviewPending: boolean;
  modelUsed: string | null;
  updatedAt: string;
}

export type TimingMatchLabel = 'Matched' | 'Close Match' | 'Needs Review' | 'Unresolved';

export interface DialogueSegment {
  segmentId: string;
  projectId: string;
  sourceSpeakerId: string;
  characterId: string | null;
  originalStartMs: number;
  originalEndMs: number;
  originalDurationMs: number;
  japaneseText: string;
  hindiText: string;
  asrConfidence?: number | null;
  wordTimestamps?: WordTimestamp[];
  emotion: EmotionMetadata;
  actingDirective?: VoiceActingDirective | null;
  assignedHindiVoiceId: string | null;
  generatedAudioRef: string | null;
  actualGeneratedDurationMs: number | null;
  finalStartMs: number;
  finalEndMs: number;
  syncDeltaMs?: number | null;
  appliedSpeedMultiplier?: number | null;
  preferredShiftLimitMs: number; // 200-400ms target tolerance
  overlapGroupId: string | null;
  syncStatus: SyncStatus;
  timingMatchLabel?: TimingMatchLabel;
  collaborativeMeta?: CollaborativeTranslationMeta | null;
  qaStatus: QAStatus;
  reviewStatus: ReviewStatus;
  updatedAt: string;
}

export interface PronunciationEntry {
  id: string;
  seriesScope: string;
  sourceTerm: string;
  targetHindiForm: string;
  phoneticHint: string;
  category:
    | 'character_name'
    | 'place'
    | 'fictional_term'
    | 'english_loanword'
    | 'repeated_word';
  notes: string;
  updatedAt: string;
}

export interface ContextSnapshot {
  id: string;
  projectId: string;
  sceneCount: number;
  windowSize: number;
  terminology: string[];
  characterBriefs: Array<{
    characterId: string;
    name: string;
    speakingStyle: string;
    registerSummary: string;
  }>;
  updatedAt: string;
}

export interface TranslationRecord {
  id: string;
  projectId: string;
  segmentId: string;
  sourceLang: LanguageCode;
  targetLang: LanguageCode;
  sourceText: string;
  translatedText: string;
  contextNotes: string;
  pronunciationOverrides: Array<{ term: string; reading: string }>;
  collaborativeMeta?: CollaborativeTranslationMeta | null;
  status: 'draft' | 'needs_review' | 'approved' | 'not_integrated';
  updatedAt: string;
}

export interface ProcessingJob {
  jobId: string;
  projectId: string;
  operationType: string;
  status: JobStatus;
  progressPercent: number;
  currentStage: string;
  startedAt: string;
  updatedAt: string;
  errorMessage: string | null;
  retryCount: number;
  checkpointId: string | null;
  cancelled: boolean;
}

export type AgentExecutionStatus =
  | 'idle'
  | 'waiting'
  | 'ready'
  | 'running'
  | 'completed'
  | 'completed_with_warnings'
  | 'failed'
  | 'cancelled'
  | 'not_integrated'
  | 'needs_review'
  | 'waiting_for_model';

export interface AgentExecutionRecord {
  id: string;
  jobId: string;
  projectId: string;
  agentId: string;
  status: AgentExecutionStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  inputSummary: string;
  outputSummary: string;
  errorMessage: string | null;
  checkpointSaved: boolean;
}

export type ModelCategory =
  | 'japanese_asr'
  | 'speaker_diarization'
  | 'face_detection'
  | 'translation'
  | 'emotion_detection'
  | 'hindi_tts'
  | 'local_llm'
  | 'sound_classification'
  | 'audio_separation';

export interface ModelMetadata {
  id: string;
  name: string;
  repoId: string | null;
  architecture: string;
  category: ModelCategory;
  officialSource: string;
  downloadUrl: string | null;
  license: string;
  commercialUseNote: string;
  supportedLanguages: string[];
  androidArmCompatibility: string;
  runtimeCompatibility: string;
  fileSizeBytes: number | null;
  estimatedMemoryMb: number | null;
  quantization: string;
  version: string;
  integrityHashSha256: string | null;
  downloadStatus:
    | 'not_downloaded'
    | 'downloading'
    | 'unconfigured_prompt2'
    | 'unconfigured_prompt3'
    | 'verified'
    | 'failed';
  downloadProgressPercent?: number;
  installStatus: 'not_installed' | 'installed_verified';
  availabilityStatus:
    | 'unavailable_pending_integration'
    | 'download_required'
    | 'ready_offline';
  integrationStage: 'Prompt 2' | 'Prompt 3';
  verifiedAt?: string | null;
  lastError?: string | null;
  notes: string;
}

export type SoundEventCategory =
  | 'speech'
  | 'music'
  | 'song'
  | 'sfx_impact'
  | 'ambience_nature'
  | 'animal'
  | 'crowd';

export interface SoundEventRecord {
  id: string;
  projectId: string;
  startMs: number;
  endMs: number;
  category: SoundEventCategory;
  preserveOriginal: boolean;
  confidence: number;
  label: string;
  spectralCentroidHz: number;
  energyDb: number;
}

export type AudioStemType = 'dialogue_stem' | 'background_stem' | 'final_mix';

export interface AudioStemRecord {
  id: string;
  projectId: string;
  stemType: AudioStemType;
  vaultKey: string;
  sampleRate: number;
  durationMs: number;
  sizeBytes: number;
  separationMethod: string;
  confidence: number;
  artifactWarning: string | null;
  createdAt: string;
}

export type TimelineTrackKind = 'dialogue' | 'original' | 'music_sfx' | 'character';

export interface TimelineTrack {
  trackId: string;
  projectId: string;
  name: string;
  kind: TimelineTrackKind;
  characterId: string | null;
  orderIndex: number;
  muted: boolean;
  solo: boolean;
  gainDb: number;
  locked: boolean;
}

export interface AudioClip {
  clipId: string;
  projectId: string;
  trackId: string;
  segmentId: string | null;
  label: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  sourceNamespace: StorageNamespace | null;
  sourceRef: string | null;
  hasRealAudio: boolean;
  waveformPeaks: number[] | null; // strictly null until real audio buffer decoded
  volumeDb?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  trimStartMs?: number;
  trimEndMs?: number;
}

export interface QAIssue {
  id: string;
  segmentId: string | null;
  clipId?: string | null;
  category:
    | 'translation'
    | 'timing'
    | 'voice'
    | 'audio_quality'
    | 'character_identity'
    | 'sound_preservation';
  severity: 'warning' | 'error' | 'review_required';
  message: string;
  resolved: boolean;
}

export interface AcousticQAMetrics {
  peakDbfs: number;
  rmsDbfs: number;
  clippingSampleCount: number;
  silenceRatio: number;
  dialogueToBackgroundDb: number | null;
  exportIntegrityVerified: boolean;
  measuredStemVaultKey: string | null;
}

export interface QAReport {
  id: string;
  projectId: string;
  createdAt: string;
  overallStatus: QAStatus;
  checkedSegmentCount: number;
  passedCount: number;
  warningCount: number;
  failedCount: number;
  reviewRequiredCount: number;
  issues: QAIssue[];
  acousticMetrics?: AcousticQAMetrics | null;
  semanticReviewSummary?: string | null;
  engineNote: string;
}

export interface ProjectVersion {
  id: string;
  projectId: string;
  versionNumber: number;
  label: string;
  createdAt: string;
  summary: string;
}

export interface Checkpoint {
  id: string;
  projectId: string;
  jobId: string;
  stageAgentId: string;
  completedAgentIds: string[];
  savedAt: string;
  valid: boolean;
  notes: string;
}

export interface ProcessingLog {
  id: string;
  projectId: string;
  jobId: string | null;
  agentId: string | null;
  level: 'info' | 'warning' | 'error';
  message: string;
  timestamp: string;
}

export interface GeminiSessionUsage {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  ttsRequests: number;
  lastModelUsed: string | null;
  lastVerifiedAt: string | null;
  lastVerifiedOk: boolean;
  lastError: string | null;
}

export interface GeminiConnectionStatus {
  configured: boolean;
  verified: boolean;
  primaryModel: string;
  ttsModel: string;
  availableModels: string[];
  availableTtsModels: string[];
  usage: GeminiSessionUsage;
  message: string;
}

export interface AppSettings {
  id: 'app_settings';
  defaultSourceLanguage: LanguageCode;
  defaultTargetLanguage: LanguageCode;
  maxConcurrentHeavyModels: 1 | 2;
  targetRamBudgetGb: number;
  chunkDurationSec: number;
  chunkOverlapSec: number;
  preferredTimingAdjustmentMs: number;
  offlineOnlyMode: boolean;
  preserveOriginalMediaAlways: boolean;
  autoUnloadUnusedModels: boolean;
  pauseOnLowBattery: boolean;
  lowBatteryThresholdPercent: number;
  cloudIntelligenceEnabled: boolean;
  preferredGeminiModel: string;
  cloudTtsEnabled: boolean;
  preferredCloudTtsModel: string;
  collaborationMode: CollaborationMode;
  allowSendDialogueTextToCloud: boolean;
  allowSendKeyframesToCloud: boolean;
  updatedAt: string;
}

export interface StorageUsageBreakdown {
  quotaBytes: number | null;
  usageBytes: number | null;
  availableBytes: number | null;
  namespaces: Record<StorageNamespace, number>;
  measurementSource: 'navigator_storage_api' | 'vault_accounting_only';
}

export interface ResourceSnapshot {
  deviceMemoryGb: number | null;
  memoryMeasurementSource: 'navigator_deviceMemory' | 'unavailable_in_browser';
  activeHeavyModelCount: number;
  activeModelMemoryMb: number;
  maxHeavyConcurrency: 1 | 2;
  storage: StorageUsageBreakdown;
  batteryLevelPercent: number | null;
  batteryCharging: boolean | null;
  batterySupported: boolean;
  thermalState: 'unavailable_in_web_runtime';
  schedulerStatus: 'nominal' | 'constrained' | 'paused_low_resources';
  capturedAt: string;
}
