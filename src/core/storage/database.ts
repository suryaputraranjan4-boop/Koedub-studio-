import type {
  AgentExecutionRecord,
  AppSettings,
  AudioClip,
  AudioStemRecord,
  CharacterProfile,
  CharacterSpeakerAssociation,
  Checkpoint,
  ContextSnapshot,
  DialogueSegment,
  ExtractedFrame,
  ImportedMedia,
  MediaMetadata,
  ModelMetadata,
  ProcessingJob,
  ProcessingLog,
  Project,
  ProjectVersion,
  PronunciationEntry,
  QAReport,
  Scene,
  SoundEventRecord,
  Speaker,
  StorageNamespace,
  TimelineTrack,
  TranslationRecord,
  VoiceAssignment,
  VoiceProfile,
} from '../../types/domain';

export const DB_NAME = 'KoeDubStudioLocalDB';
export const DB_VERSION = 4;

/**
 * Structured relational-style object stores (26 structured stores + settings + separated binary file vault).
 * Migrations v1 -> v2 -> v3 -> v4 safely preserve all existing project data while adding
 * pronunciation_entries, context_snapshots, sound_events, audio_stems, and pipeline_artifacts.
 */
export const STORES = {
  projects: 'projects',
  imported_media: 'imported_media',
  media_metadata: 'media_metadata',
  scenes: 'scenes',
  extracted_frames: 'extracted_frames',
  characters: 'characters',
  speakers: 'speakers',
  character_speaker_associations: 'character_speaker_associations',
  voice_profiles: 'voice_profiles',
  voice_assignments: 'voice_assignments',
  dialogue_segments: 'dialogue_segments',
  translations: 'translations',
  pronunciation_entries: 'pronunciation_entries',
  context_snapshots: 'context_snapshots',
  processing_jobs: 'processing_jobs',
  agent_executions: 'agent_executions',
  model_metadata: 'model_metadata',
  timeline_tracks: 'timeline_tracks',
  audio_clips: 'audio_clips',
  qa_reports: 'qa_reports',
  project_versions: 'project_versions',
  checkpoints: 'checkpoints',
  processing_logs: 'processing_logs',
  sound_events: 'sound_events',
  audio_stems: 'audio_stems',
  pipeline_artifacts: 'pipeline_artifacts',
  app_settings: 'app_settings',
  file_vault: 'file_vault',
} as const;

export type StoreName = (typeof STORES)[keyof typeof STORES];

export interface VaultEntry {
  vaultKey: string;
  projectId: string | null;
  namespace: StorageNamespace;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  blob: Blob;
  storedAt: string;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  id: 'app_settings',
  defaultSourceLanguage: 'ja',
  defaultTargetLanguage: 'hi',
  maxConcurrentHeavyModels: 1,
  targetRamBudgetGb: 8,
  chunkDurationSec: 30,
  chunkOverlapSec: 2,
  preferredTimingAdjustmentMs: 300,
  offlineOnlyMode: false,
  preserveOriginalMediaAlways: true,
  autoUnloadUnusedModels: true,
  pauseOnLowBattery: true,
  lowBatteryThresholdPercent: 20,
  cloudIntelligenceEnabled: true,
  preferredGeminiModel: 'gemini-4-hydrogen',
  cloudTtsEnabled: false,
  preferredCloudTtsModel: 'gemini-3.8-flash-lite-tts',
  collaborationMode: 'draft_and_review',
  allowSendDialogueTextToCloud: true,
  allowSendKeyframesToCloud: false,
  updatedAt: new Date().toISOString(),
};

/**
 * Verified open-source ONNX & TFLite models researched for Prompt 2 local-first execution.
 * Every model starts honestly as 'not_installed' / 'not_downloaded' until the user explicitly
 * downloads & verifies it into the browser's persistent offline cache.
 * Prompt 3 audio classification & source separation remain honestly unconfigured for Prompt 3.
 */
export const VERIFIED_MODEL_CATALOG: ModelMetadata[] = [
  {
    id: 'model_whisper_small_onnx',
    name: 'OpenAI Whisper Small (ONNX Quantized)',
    repoId: 'onnx-community/whisper-small',
    architecture: 'Encoder-Decoder Transformer (244M params)',
    category: 'japanese_asr',
    officialSource: 'https://huggingface.co/onnx-community/whisper-small',
    downloadUrl: 'https://huggingface.co/onnx-community/whisper-small',
    license: 'Apache-2.0',
    commercialUseNote: 'Permitted under Apache 2.0 license.',
    supportedLanguages: ['ja', 'en', 'hi', 'ko', 'zh', '99 languages'],
    androidArmCompatibility: 'Compatible via ONNX Runtime Web (WASM SIMD / WebGPU) on Android Chrome & WebView ARM64',
    runtimeCompatibility: '@huggingface/transformers v3 (ONNX Runtime Web)',
    fileSizeBytes: 265 * 1024 * 1024,
    estimatedMemoryMb: 1200,
    quantization: 'q8 (INT8 encoder/decoder)',
    version: 'onnx-community/whisper-small',
    integrityHashSha256: null,
    downloadStatus: 'not_downloaded',
    downloadProgressPercent: 0,
    installStatus: 'not_installed',
    availabilityStatus: 'download_required',
    integrationStage: 'Prompt 2',
    verifiedAt: null,
    lastError: null,
    notes:
      'Supports Japanese speech recognition with 30s chunking, 5s stride overlap, and segment timestamps. Unloaded immediately after ASR to stay within 8 GB RAM.',
  },
  {
    id: 'model_pyannote_segmentation',
    name: 'PyAnnote Segmentation 3.0 (ONNX)',
    repoId: 'onnx-community/pyannote-segmentation-3.0',
    architecture: 'SincNet + BiLSTM Frame Classifier (PyanNet)',
    category: 'speaker_diarization',
    officialSource: 'https://huggingface.co/onnx-community/pyannote-segmentation-3.0',
    downloadUrl: 'https://huggingface.co/onnx-community/pyannote-segmentation-3.0',
    license: 'MIT',
    commercialUseNote: 'Permitted under MIT license.',
    supportedLanguages: ['language-agnostic'],
    androidArmCompatibility: 'Compatible via ONNX Runtime Web (WASM) on Android ARM64',
    runtimeCompatibility: '@huggingface/transformers v3 (ONNX Runtime Web)',
    fileSizeBytes: 6 * 1024 * 1024,
    estimatedMemoryMb: 420,
    quantization: 'fp32 (lightweight ~6 MB)',
    version: '3.0-onnx',
    integrityHashSha256: null,
    downloadStatus: 'not_downloaded',
    downloadProgressPercent: 0,
    installStatus: 'not_installed',
    availabilityStatus: 'download_required',
    integrationStage: 'Prompt 2',
    verifiedAt: null,
    lastError: null,
    notes:
      'Detects frame-level speech activity and local overlapping speaker turns; paired with local spectral-MFCC clustering for cross-scene Speaker ID persistence.',
  },
  {
    id: 'model_mediapipe_blazeface',
    name: 'MediaPipe BlazeFace Short Range (Float16 TFLite)',
    repoId: 'mediapipe/blaze_face_short_range',
    architecture: 'Lightweight Single-Shot Face Detector (BlazeFace)',
    category: 'face_detection',
    officialSource:
      'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
    downloadUrl:
      'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
    license: 'Apache-2.0',
    commercialUseNote: 'Permitted under Apache 2.0 license.',
    supportedLanguages: ['visual'],
    androidArmCompatibility: 'Native TFLite WASM / MediaPipe Tasks Vision on Android ARM64',
    runtimeCompatibility: '@mediapipe/tasks-vision (WASM)',
    fileSizeBytes: 230 * 1024,
    estimatedMemoryMb: 280,
    quantization: 'float16',
    version: '1.0-short-range',
    integrityHashSha256: null,
    downloadStatus: 'not_downloaded',
    downloadProgressPercent: 0,
    installStatus: 'not_installed',
    availabilityStatus: 'download_required',
    integrationStage: 'Prompt 2',
    verifiedAt: null,
    lastError: null,
    notes:
      'Detects visible faces and facial keypoints (including mouth region) on extracted video keyframes. Trained on photographic faces; stylized 2D anime faces may have lower recall and are flagged for review.',
  },
  {
    id: 'model_nllb_200_600m',
    name: 'Meta NLLB-200 Distilled 600M (ONNX Quantized)',
    repoId: 'Xenova/nllb-200-distilled-600M',
    architecture: 'Multilingual Seq2Seq Transformer (600M params)',
    category: 'translation',
    officialSource: 'https://huggingface.co/Xenova/nllb-200-distilled-600M',
    downloadUrl: 'https://huggingface.co/Xenova/nllb-200-distilled-600M',
    license: 'CC-BY-NC-4.0',
    commercialUseNote: 'Non-Commercial only (CC-BY-NC-4.0). Not licensed for commercial distribution.',
    supportedLanguages: ['ja (jpn_Jpan)', 'hi (hin_Deva)', '200 languages'],
    androidArmCompatibility: 'Compatible via ONNX Runtime Web (INT8 WASM) on 8 GB Android ARM64',
    runtimeCompatibility: '@huggingface/transformers v3 (ONNX Runtime Web)',
    fileSizeBytes: 620 * 1024 * 1024,
    estimatedMemoryMb: 1450,
    quantization: 'q8 (INT8 quantized ONNX)',
    version: 'nllb-200-distilled-600M',
    integrityHashSha256: null,
    downloadStatus: 'not_downloaded',
    downloadProgressPercent: 0,
    installStatus: 'not_installed',
    availabilityStatus: 'download_required',
    integrationStage: 'Prompt 2',
    verifiedAt: null,
    lastError: null,
    notes:
      'Direct Japanese (jpn_Jpan) to Hindi (hin_Deva) offline neural translation paired with Pronunciation Dictionary overrides, Relationship registers, and Context Intelligence.',
  },
  {
    id: 'model_multilingual_sentiment',
    name: 'DistilBERT Multilingual Sentiment (ONNX Quantized)',
    repoId: 'Xenova/distilbert-base-multilingual-cased-sentiments-student',
    architecture: 'Distilled Multilingual Transformer Classifier',
    category: 'emotion_detection',
    officialSource:
      'https://huggingface.co/Xenova/distilbert-base-multilingual-cased-sentiments-student',
    downloadUrl:
      'https://huggingface.co/Xenova/distilbert-base-multilingual-cased-sentiments-student',
    license: 'Apache-2.0',
    commercialUseNote: 'Permitted under Apache 2.0 license.',
    supportedLanguages: ['ja', 'hi', 'en', 'multilingual'],
    androidArmCompatibility: 'Compatible via ONNX Runtime Web (INT8 WASM) on Android ARM64',
    runtimeCompatibility: '@huggingface/transformers v3 (ONNX Runtime Web)',
    fileSizeBytes: 135 * 1024 * 1024,
    estimatedMemoryMb: 380,
    quantization: 'q8 (INT8 quantized ONNX)',
    version: 'student-onnx',
    integrityHashSha256: null,
    downloadStatus: 'not_downloaded',
    downloadProgressPercent: 0,
    installStatus: 'not_installed',
    availabilityStatus: 'download_required',
    integrationStage: 'Prompt 2',
    verifiedAt: null,
    lastError: null,
    notes:
      'Optional text-valence neural model enhancing the built-in acoustic prosody + Japanese/Hindi lexical Emotion Detection Agent (#16).',
  },
  {
    id: 'model_mms_tts_hin',
    name: 'Meta MMS-TTS Hindi (VITS ONNX)',
    repoId: 'Xenova/mms-tts-hin',
    architecture: 'End-to-End VITS Neural Speech Synthesizer (16 kHz mono)',
    category: 'hindi_tts',
    officialSource: 'https://huggingface.co/Xenova/mms-tts-hin',
    downloadUrl: 'https://huggingface.co/Xenova/mms-tts-hin',
    license: 'CC-BY-NC-4.0',
    commercialUseNote: 'Non-Commercial only (CC-BY-NC-4.0). Single-speaker Hindi VITS base model.',
    supportedLanguages: ['hi (Devanagari)'],
    androidArmCompatibility: 'Compatible via ONNX Runtime Web (WASM) on Android ARM64',
    runtimeCompatibility: '@huggingface/transformers v3 (ONNX Runtime Web)',
    fileSizeBytes: 145 * 1024 * 1024,
    estimatedMemoryMb: 480,
    quantization: 'fp32 / q8 ONNX',
    version: 'facebook/mms-tts-hin',
    integrityHashSha256: null,
    downloadStatus: 'not_downloaded',
    downloadProgressPercent: 0,
    installStatus: 'not_installed',
    availabilityStatus: 'download_required',
    integrationStage: 'Prompt 2',
    verifiedAt: null,
    lastError: null,
    notes:
      'Native Devanagari Hindi text-to-speech generating real 16 kHz mono PCM WAV files offline. Single-speaker base; distinct character voice presets use transparent post-synthesis Web Audio DSP.',
  },
  {
    id: 'model_local_llm_qwen_onnx',
    name: 'Qwen2.5-0.5B-Instruct (ONNX q4 Local LLM)',
    repoId: 'onnx-community/Qwen2.5-0.5B-Instruct',
    architecture: 'Decoder-Only Instruction LLM (494M params)',
    category: 'local_llm',
    officialSource: 'https://huggingface.co/onnx-community/Qwen2.5-0.5B-Instruct',
    downloadUrl: 'https://huggingface.co/onnx-community/Qwen2.5-0.5B-Instruct',
    license: 'Apache-2.0',
    commercialUseNote: 'Permitted under Apache 2.0 license.',
    supportedLanguages: ['ja', 'hi', 'en', '29+ languages'],
    androidArmCompatibility:
      'Runs locally in browser WASM / ONNX Runtime Web on 8 GB ARM64 devices (Android-native 4B GGUF via llama.cpp requires native C++ runtime outside browser sandbox)',
    runtimeCompatibility: '@huggingface/transformers v3 (ONNX Runtime Web q4)',
    fileSizeBytes: 360 * 1024 * 1024,
    estimatedMemoryMb: 920,
    quantization: 'q4 (4-bit ONNX)',
    version: 'Qwen2.5-0.5B-Instruct-ONNX',
    integrityHashSha256: null,
    downloadStatus: 'not_downloaded',
    downloadProgressPercent: 0,
    installStatus: 'not_installed',
    availabilityStatus: 'download_required',
    integrationStage: 'Prompt 3',
    verifiedAt: null,
    lastError: null,
    notes:
      'On-device collaborative local LLM used for offline Hindi phrasing refinement, concise timing rewrites, and cross-checking Gemini drafts. Always unloaded immediately after inference to protect 8 GB RAM.',
  },
  {
    id: 'slot_sound_classification',
    name: 'Local Spectral/Harmonic Sound Classifier (Built-In DSP) + YAMNet Reference',
    repoId: null,
    architecture: 'Multi-Feature Spectral/Harmonic/ZCR Audio Event Classifier (Built-In Web Audio DSP)',
    category: 'sound_classification',
    officialSource: 'Built-in Local Web Audio DSP (Android-native YAMNet TFLite requires native MediaPipe Audio runtime)',
    downloadUrl: 'https://www.kaggle.com/models/google/yamnet/tfLite',
    license: 'Apache-2.0',
    commercialUseNote: 'Built-in DSP classifier is active immediately offline with zero external dependency.',
    supportedLanguages: ['audio'],
    androidArmCompatibility: 'Active immediately in all browsers & Android WebView (0 MB download)',
    runtimeCompatibility: 'Built-In Web Audio DSP Engine (Active Offline)',
    fileSizeBytes: 0,
    estimatedMemoryMb: 180,
    quantization: 'FP32 PCM DSP',
    version: 'Prompt 3 Built-In v1.0',
    integrityHashSha256: null,
    checksumStatus: 'runtime_only_no_published_checksum',
    runtimeVerified: true,
    runtimeVerifiedAt: new Date().toISOString(),
    downloadStatus: 'verified',
    downloadProgressPercent: 100,
    installStatus: 'installed_verified',
    availabilityStatus: 'ready_offline',
    integrationStage: 'Prompt 3',
    verifiedAt: new Date().toISOString(),
    lastError: null,
    notes:
      'Heuristic multi-feature DSP classifier (not neural YAMNet). Classifies speech, music, songs, footsteps, rain, wind, water, birds, animals, ambience, crowd, and impact SFX to build a non-destructive preservation mask for Agent #21.',
  },
  {
    id: 'slot_audio_separation',
    name: 'Conservative Stereo/Spectral Stem Separator (Built-In DSP) + Spleeter Note',
    repoId: null,
    architecture: 'Mask-Guided Mid-Side Stereo + Voice-Band Adaptive Attenuator (Built-In Web Audio DSP)',
    category: 'audio_separation',
    officialSource: 'Built-in Local Web Audio DSP (Neural Spleeter/UVR-MDX exceeds browser WASM RAM budget on 8 GB devices)',
    downloadUrl: 'https://github.com/deezer/spleeter',
    license: 'MIT',
    commercialUseNote: 'Built-in conservative separator runs immediately offline and never destructively modifies original_media.',
    supportedLanguages: ['audio'],
    androidArmCompatibility: 'Active immediately in all browsers & Android WebView (0 MB download)',
    runtimeCompatibility: 'Built-In Web Audio DSP Engine (Active Offline)',
    fileSizeBytes: 0,
    estimatedMemoryMb: 320,
    quantization: 'FP32 PCM DSP',
    version: 'Prompt 3 Built-In v1.0',
    integrityHashSha256: null,
    checksumStatus: 'runtime_only_no_published_checksum',
    runtimeVerified: true,
    runtimeVerifiedAt: new Date().toISOString(),
    downloadStatus: 'verified',
    downloadProgressPercent: 100,
    installStatus: 'installed_verified',
    availabilityStatus: 'ready_offline',
    integrationStage: 'Prompt 3',
    verifiedAt: new Date().toISOString(),
    lastError: null,
    notes:
      'Produces stereo background_stem.wav and dialogue_stem.wav (or prefers an imported clean M&E stem when provided) while protecting songs, music, ambience, and SFX. Measures residual dialogue leakage dB honestly.',
  },
];

/**
 * Truthful Hindi Voice Profiles:
 * - Local Offline Voices tied to single-speaker Xenova/mms-tts-hin (honestly distinguishing the base
 *   neural speaker from bounded post-synthesis DSP presets).
 * - Optional Cloud Prebuilt Multi-Voices tied to Gemini 3.8 TTS (Puck, Charon, Kore, Fenrir, Zephyr),
 *   so multi-character scenes can assign genuinely distinct persistent voices when Cloud TTS is enabled.
 */
export const VERIFIED_VOICE_PROFILES: VoiceProfile[] = [
  {
    voiceId: 'mms_hin_base',
    displayName: 'MMS Hindi Base (Local Neural VITS)',
    language: 'hi',
    locale: 'hi-IN',
    characteristics: 'Native Devanagari Hindi VITS speaker · 16 kHz mono · balanced neutral timbre',
    genderStyle: 'Balanced / Neutral Base',
    engineRuntime: 'Xenova/mms-tts-hin (ONNX Runtime Web · Offline)',
    modelId: 'model_mms_tts_hin',
    synthesisMode: 'neural_native',
    cloudVoiceName: 'Kore',
    dspPitchSemitones: 0,
    dspRateMultiplier: 1.0,
    nativeEmotionControl: false,
    availabilityStatus: 'not_installed',
    installStatus: 'not_installed',
    lockedCharacterIds: [],
    notes:
      'Authentic Meta MMS-TTS-HIN neural output (CC-BY-NC-4.0) with zero pitch alteration. Requires downloading Meta MMS-TTS Hindi in Model Manager.',
  },
  {
    voiceId: 'mms_hin_bright',
    displayName: 'MMS Hindi Bright (Local Single-Speaker + DSP Preset)',
    language: 'hi',
    locale: 'hi-IN',
    characteristics: 'Youthful / bright DSP preset · +1.8 st pitch & 1.04× cadence via Web Audio DSP',
    genderStyle: 'Youthful / Higher Pitch (DSP Preset)',
    engineRuntime: 'Xenova/mms-tts-hin + Web Audio DSP (Offline)',
    modelId: 'model_mms_tts_hin',
    synthesisMode: 'single_speaker_dsp_preset',
    cloudVoiceName: 'Zephyr',
    dspPitchSemitones: 1.8,
    dspRateMultiplier: 1.04,
    nativeEmotionControl: false,
    availabilityStatus: 'not_installed',
    installStatus: 'not_installed',
    lockedCharacterIds: [],
    notes:
      'Derived from single-speaker MMS-TTS-HIN plus bounded post-synthesis DSP—explicitly NOT a separate neural speaker embedding.',
  },
  {
    voiceId: 'mms_hin_warm',
    displayName: 'MMS Hindi Deep / Mentor (Local Single-Speaker + DSP Preset)',
    language: 'hi',
    locale: 'hi-IN',
    characteristics: 'Mature / deeper DSP preset · -2.0 st pitch & 0.96× cadence via Web Audio DSP',
    genderStyle: 'Adult / Deeper Pitch (DSP Preset)',
    engineRuntime: 'Xenova/mms-tts-hin + Web Audio DSP (Offline)',
    modelId: 'model_mms_tts_hin',
    synthesisMode: 'single_speaker_dsp_preset',
    cloudVoiceName: 'Charon',
    dspPitchSemitones: -2.0,
    dspRateMultiplier: 0.96,
    nativeEmotionControl: false,
    availabilityStatus: 'not_installed',
    installStatus: 'not_installed',
    lockedCharacterIds: [],
    notes:
      'Derived from single-speaker MMS-TTS-HIN plus bounded post-synthesis DSP—explicitly NOT a separate neural speaker embedding.',
  },
  {
    voiceId: 'mms_hin_narrator',
    displayName: 'MMS Hindi Narrator (Local Single-Speaker + DSP Preset)',
    language: 'hi',
    locale: 'hi-IN',
    characteristics: 'Measured exposition / narrator DSP preset · -0.7 st pitch & 0.94× pacing',
    genderStyle: 'Narrator / Measured (DSP Preset)',
    engineRuntime: 'Xenova/mms-tts-hin + Web Audio DSP (Offline)',
    modelId: 'model_mms_tts_hin',
    synthesisMode: 'single_speaker_dsp_preset',
    cloudVoiceName: 'Fenrir',
    dspPitchSemitones: -0.7,
    dspRateMultiplier: 0.94,
    nativeEmotionControl: false,
    availabilityStatus: 'not_installed',
    installStatus: 'not_installed',
    lockedCharacterIds: [],
    notes:
      'Reserved for narrator or off-screen exposition characters using single-speaker MMS-TTS-HIN plus steady pacing DSP.',
  },
  {
    voiceId: 'cloud_gemini_kore',
    displayName: 'Gemini Cloud — Kore (Firm / Clear Multi-Voice)',
    language: 'hi',
    locale: 'hi-IN',
    characteristics: 'Distinct cloud prebuilt Hindi-capable neural voice · clear studio articulation',
    genderStyle: 'Clear / Expressive Lead (Cloud Prebuilt)',
    engineRuntime: 'Gemini 3.8 TTS (Server-Side Cloud Proxy)',
    modelId: 'gemini_cloud_tts',
    synthesisMode: 'cloud_prebuilt_voice',
    cloudVoiceName: 'Kore',
    dspPitchSemitones: 0,
    dspRateMultiplier: 1.0,
    nativeEmotionControl: true,
    availabilityStatus: 'available',
    installStatus: 'verified_installed',
    lockedCharacterIds: [],
    notes:
      'Distinct cloud prebuilt speaker via server-side Gemini TTS proxy (requires Cloud Intelligence + Cloud TTS enabled; falls back to local MMS-TTS offline).',
  },
  {
    voiceId: 'cloud_gemini_puck',
    displayName: 'Gemini Cloud — Puck (Upbeat / Youthful Multi-Voice)',
    language: 'hi',
    locale: 'hi-IN',
    characteristics: 'Distinct cloud prebuilt neural voice · energetic youthful protagonist cadence',
    genderStyle: 'Energetic / Youthful (Cloud Prebuilt)',
    engineRuntime: 'Gemini 3.8 TTS (Server-Side Cloud Proxy)',
    modelId: 'gemini_cloud_tts',
    synthesisMode: 'cloud_prebuilt_voice',
    cloudVoiceName: 'Puck',
    dspPitchSemitones: 0,
    dspRateMultiplier: 1.0,
    nativeEmotionControl: true,
    availabilityStatus: 'available',
    installStatus: 'verified_installed',
    lockedCharacterIds: [],
    notes:
      'Distinct cloud prebuilt speaker via server-side Gemini TTS proxy (requires Cloud Intelligence + Cloud TTS enabled).',
  },
  {
    voiceId: 'cloud_gemini_charon',
    displayName: 'Gemini Cloud — Charon (Deep / Mature Multi-Voice)',
    language: 'hi',
    locale: 'hi-IN',
    characteristics: 'Distinct cloud prebuilt neural voice · resonant mature mentor / authority timbre',
    genderStyle: 'Deep / Mature (Cloud Prebuilt)',
    engineRuntime: 'Gemini 3.8 TTS (Server-Side Cloud Proxy)',
    modelId: 'gemini_cloud_tts',
    synthesisMode: 'cloud_prebuilt_voice',
    cloudVoiceName: 'Charon',
    dspPitchSemitones: 0,
    dspRateMultiplier: 1.0,
    nativeEmotionControl: true,
    availabilityStatus: 'available',
    installStatus: 'verified_installed',
    lockedCharacterIds: [],
    notes:
      'Distinct cloud prebuilt speaker via server-side Gemini TTS proxy (requires Cloud Intelligence + Cloud TTS enabled).',
  },
  {
    voiceId: 'cloud_gemini_fenrir',
    displayName: 'Gemini Cloud — Fenrir (Dramatic / Narrator Multi-Voice)',
    language: 'hi',
    locale: 'hi-IN',
    characteristics: 'Distinct cloud prebuilt neural voice · dramatic intense rival or narrator delivery',
    genderStyle: 'Dramatic / Narrator (Cloud Prebuilt)',
    engineRuntime: 'Gemini 3.8 TTS (Server-Side Cloud Proxy)',
    modelId: 'gemini_cloud_tts',
    synthesisMode: 'cloud_prebuilt_voice',
    cloudVoiceName: 'Fenrir',
    dspPitchSemitones: 0,
    dspRateMultiplier: 1.0,
    nativeEmotionControl: true,
    availabilityStatus: 'available',
    installStatus: 'verified_installed',
    lockedCharacterIds: [],
    notes:
      'Distinct cloud prebuilt speaker via server-side Gemini TTS proxy (requires Cloud Intelligence + Cloud TTS enabled).',
  },
  {
    voiceId: 'cloud_gemini_zephyr',
    displayName: 'Gemini Cloud — Zephyr (Bright / Warm Multi-Voice)',
    language: 'hi',
    locale: 'hi-IN',
    characteristics: 'Distinct cloud prebuilt neural voice · bright warm expressive character tone',
    genderStyle: 'Bright / Warm (Cloud Prebuilt)',
    engineRuntime: 'Gemini 3.8 TTS (Server-Side Cloud Proxy)',
    modelId: 'gemini_cloud_tts',
    synthesisMode: 'cloud_prebuilt_voice',
    cloudVoiceName: 'Zephyr',
    dspPitchSemitones: 0,
    dspRateMultiplier: 1.0,
    nativeEmotionControl: true,
    availabilityStatus: 'available',
    installStatus: 'verified_installed',
    lockedCharacterIds: [],
    notes:
      'Distinct cloud prebuilt speaker via server-side Gemini TTS proxy (requires Cloud Intelligence + Cloud TTS enabled).',
  },
];

let dbPromise: Promise<IDBDatabase> | null = null;

function createStoreWithIndexes(
  db: IDBDatabase,
  name: string,
  keyPath: string,
  indexes: Array<{ name: string; keyPath: string; unique?: boolean }> = []
) {
  if (!db.objectStoreNames.contains(name)) {
    const store = db.createObjectStore(name, { keyPath });
    for (const idx of indexes) {
      store.createIndex(idx.name, idx.keyPath, { unique: Boolean(idx.unique) });
    }
  }
}

export function openStudioDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const oldVersion = event.oldVersion;

      if (oldVersion < 1) {
        createStoreWithIndexes(db, STORES.projects, 'id', [
          { name: 'status', keyPath: 'status' },
          { name: 'updatedAt', keyPath: 'updatedAt' },
        ]);
        createStoreWithIndexes(db, STORES.imported_media, 'id', [
          { name: 'projectId', keyPath: 'projectId' },
        ]);
        createStoreWithIndexes(db, STORES.media_metadata, 'id', [
          { name: 'projectId', keyPath: 'projectId' },
          { name: 'mediaId', keyPath: 'mediaId', unique: true },
        ]);
        createStoreWithIndexes(db, STORES.scenes, 'id', [
          { name: 'projectId', keyPath: 'projectId' },
        ]);
        createStoreWithIndexes(db, STORES.extracted_frames, 'id', [
          { name: 'projectId', keyPath: 'projectId' },
          { name: 'sceneId', keyPath: 'sceneId' },
        ]);
        createStoreWithIndexes(db, STORES.characters, 'characterId', [
          { name: 'projectId', keyPath: 'projectId' },
          { name: 'seriesScope', keyPath: 'seriesScope' },
        ]);
        createStoreWithIndexes(db, STORES.speakers, 'id', [
          { name: 'projectId', keyPath: 'projectId' },
        ]);
        createStoreWithIndexes(db, STORES.character_speaker_associations, 'id', [
          { name: 'projectId', keyPath: 'projectId' },
          { name: 'characterId', keyPath: 'characterId' },
        ]);
        createStoreWithIndexes(db, STORES.voice_profiles, 'voiceId', [
          { name: 'language', keyPath: 'language' },
        ]);
        createStoreWithIndexes(db, STORES.voice_assignments, 'id', [
          { name: 'projectId', keyPath: 'projectId' },
          { name: 'characterId', keyPath: 'characterId' },
        ]);
        createStoreWithIndexes(db, STORES.dialogue_segments, 'segmentId', [
          { name: 'projectId', keyPath: 'projectId' },
          { name: 'characterId', keyPath: 'characterId' },
        ]);
        createStoreWithIndexes(db, STORES.translations, 'id', [
          { name: 'projectId', keyPath: 'projectId' },
          { name: 'segmentId', keyPath: 'segmentId', unique: true },
        ]);
        createStoreWithIndexes(db, STORES.processing_jobs, 'jobId', [
          { name: 'projectId', keyPath: 'projectId' },
          { name: 'status', keyPath: 'status' },
        ]);
        createStoreWithIndexes(db, STORES.agent_executions, 'id', [
          { name: 'jobId', keyPath: 'jobId' },
          { name: 'projectId', keyPath: 'projectId' },
        ]);
        createStoreWithIndexes(db, STORES.model_metadata, 'id', [
          { name: 'category', keyPath: 'category' },
        ]);
        createStoreWithIndexes(db, STORES.timeline_tracks, 'trackId', [
          { name: 'projectId', keyPath: 'projectId' },
        ]);
        createStoreWithIndexes(db, STORES.audio_clips, 'clipId', [
          { name: 'projectId', keyPath: 'projectId' },
          { name: 'trackId', keyPath: 'trackId' },
        ]);
        createStoreWithIndexes(db, STORES.qa_reports, 'id', [
          { name: 'projectId', keyPath: 'projectId' },
        ]);
        createStoreWithIndexes(db, STORES.project_versions, 'id', [
          { name: 'projectId', keyPath: 'projectId' },
        ]);
        createStoreWithIndexes(db, STORES.checkpoints, 'id', [
          { name: 'projectId', keyPath: 'projectId' },
          { name: 'jobId', keyPath: 'jobId' },
        ]);
        createStoreWithIndexes(db, STORES.processing_logs, 'id', [
          { name: 'projectId', keyPath: 'projectId' },
          { name: 'jobId', keyPath: 'jobId' },
        ]);
        createStoreWithIndexes(db, STORES.app_settings, 'id');
        createStoreWithIndexes(db, STORES.file_vault, 'vaultKey', [
          { name: 'projectId', keyPath: 'projectId' },
          { name: 'namespace', keyPath: 'namespace' },
        ]);
      }

      // Migration 1 -> 2: Add persistent Pronunciation Dictionary & Context Intelligence stores
      if (oldVersion < 2) {
        createStoreWithIndexes(db, STORES.pronunciation_entries, 'id', [
          { name: 'seriesScope', keyPath: 'seriesScope' },
        ]);
        createStoreWithIndexes(db, STORES.context_snapshots, 'id', [
          { name: 'projectId', keyPath: 'projectId' },
        ]);
      }

      // Migration 2 -> 3: Add Sound Classification Events & Audio Separation/Mix Stems stores
      if (oldVersion < 3) {
        createStoreWithIndexes(db, STORES.sound_events, 'id', [
          { name: 'projectId', keyPath: 'projectId' },
        ]);
        createStoreWithIndexes(db, STORES.audio_stems, 'id', [
          { name: 'projectId', keyPath: 'projectId' },
        ]);
      }

      // Migration 3 -> 4: Add Pipeline Artifacts store for full checkpoint intermediate recovery
      if (oldVersion < 4) {
        createStoreWithIndexes(db, STORES.pipeline_artifacts, 'id', [
          { name: 'projectId', keyPath: 'projectId' },
        ]);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('Failed to open local IndexedDB database.'));
    };
  });

  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export async function getAllRecords<T>(storeName: StoreName): Promise<T[]> {
  const db = await openStudioDatabase();
  const tx = db.transaction(storeName, 'readonly');
  const results = await reqToPromise(tx.objectStore(storeName).getAll());
  return results as T[];
}

export async function getByIndex<T>(
  storeName: StoreName,
  indexName: string,
  value: IDBValidKey
): Promise<T[]> {
  const db = await openStudioDatabase();
  const tx = db.transaction(storeName, 'readonly');
  const idx = tx.objectStore(storeName).index(indexName);
  const results = await reqToPromise(idx.getAll(value));
  return results as T[];
}

export async function getRecord<T>(
  storeName: StoreName,
  key: IDBValidKey
): Promise<T | undefined> {
  const db = await openStudioDatabase();
  const tx = db.transaction(storeName, 'readonly');
  const result = await reqToPromise(tx.objectStore(storeName).get(key));
  return result as T | undefined;
}

export async function putRecord<T>(storeName: StoreName, record: T): Promise<void> {
  const db = await openStudioDatabase();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).put(record);
  await txDone(tx);
}

export async function putManyRecords<T>(storeName: StoreName, records: T[]): Promise<void> {
  if (records.length === 0) return;
  const db = await openStudioDatabase();
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  for (const record of records) {
    store.put(record);
  }
  await txDone(tx);
}

export async function deleteRecord(storeName: StoreName, key: IDBValidKey): Promise<void> {
  const db = await openStudioDatabase();
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).delete(key);
  await txDone(tx);
}

/**
 * Bootstraps initial settings and upgrades Prompt 1 placeholder model/voice slots cleanly to
 * verified Prompt 2 manifests while preserving any user-verified installed state.
 */
export async function bootstrapLocalDatabase(): Promise<void> {
  const existingSettings = await getRecord<AppSettings>(STORES.app_settings, 'app_settings');
  if (!existingSettings) {
    await putRecord(STORES.app_settings, DEFAULT_APP_SETTINGS);
  } else if (existingSettings.preferredGeminiModel === undefined) {
    // Non-destructive Prompt 2 -> Prompt 3 settings upgrade
    await putRecord<AppSettings>(STORES.app_settings, {
      ...DEFAULT_APP_SETTINGS,
      ...existingSettings,
      cloudIntelligenceEnabled: existingSettings.cloudIntelligenceEnabled ?? true,
      preferredGeminiModel: existingSettings.preferredGeminiModel ?? 'gemini-4-hydrogen',
      cloudTtsEnabled: existingSettings.cloudTtsEnabled ?? false,
      preferredCloudTtsModel:
        existingSettings.preferredCloudTtsModel ?? 'gemini-3.8-flash-lite-tts',
      collaborationMode: existingSettings.collaborationMode ?? 'draft_and_review',
      allowSendDialogueTextToCloud: existingSettings.allowSendDialogueTextToCloud ?? true,
      allowSendKeyframesToCloud: existingSettings.allowSendKeyframesToCloud ?? false,
    });
  }

  // Upgrade legacy Prompt 1 unconfigured Prompt-2 slots into verified Prompt 2 catalog entries
  const existingModels = await getAllRecords<ModelMetadata>(STORES.model_metadata);
  const existingById = new Map(existingModels.map((m) => [m.id, m]));

  // Remove obsolete Prompt 1 unconfigured Prompt 2 slot IDs if present
  const obsoletePrompt1SlotIds = [
    'slot_japanese_asr',
    'slot_speaker_diarization',
    'slot_face_detection',
    'slot_translation_ja_hi',
    'slot_emotion_detection',
    'slot_hindi_tts',
  ];
  for (const oldId of obsoletePrompt1SlotIds) {
    if (existingById.has(oldId)) {
      await deleteRecord(STORES.model_metadata, oldId);
    }
  }

  const mergedModels: ModelMetadata[] = VERIFIED_MODEL_CATALOG.map((catalogItem) => {
    const existing = existingById.get(catalogItem.id);
    if (existing && existing.installStatus === 'installed_verified') {
      // Strip any legacy fabricated non-SHA256 strings from integrityHashSha256
      const isRealSha256 =
        typeof existing.integrityHashSha256 === 'string' &&
        /^[a-f0-9]{64}$/i.test(existing.integrityHashSha256);
      return {
        ...catalogItem,
        downloadStatus: 'verified',
        downloadProgressPercent: 100,
        installStatus: 'installed_verified',
        availabilityStatus: 'ready_offline',
        integrityHashSha256: isRealSha256 ? existing.integrityHashSha256 : null,
        checksumStatus: isRealSha256
          ? 'verified_sha256'
          : catalogItem.checksumStatus ?? 'runtime_only_no_published_checksum',
        runtimeVerified: existing.runtimeVerified ?? true,
        runtimeVerifiedAt: existing.runtimeVerifiedAt ?? existing.verifiedAt ?? new Date().toISOString(),
        verifiedAt: existing.verifiedAt ?? new Date().toISOString(),
      };
    }
    return catalogItem;
  });
  await putManyRecords(STORES.model_metadata, mergedModels);

  // Sync Voice Profiles with actual installation state of model_mms_tts_hin (while preserving Cloud Prebuilt voices)
  const ttsModel = mergedModels.find((m) => m.id === 'model_mms_tts_hin');
  const ttsInstalled = ttsModel?.installStatus === 'installed_verified';

  const existingVoices = await getAllRecords<VoiceProfile>(STORES.voice_profiles);
  for (const oldVoice of existingVoices) {
    if (oldVoice.voiceId.startsWith('hi_voice_slot_')) {
      await deleteRecord(STORES.voice_profiles, oldVoice.voiceId);
    }
  }

  const syncedVoices: VoiceProfile[] = VERIFIED_VOICE_PROFILES.map((v) => {
    if (v.synthesisMode === 'cloud_prebuilt_voice') {
      return {
        ...v,
        installStatus: 'verified_installed',
        availabilityStatus: 'available',
      };
    }
    return {
      ...v,
      installStatus: ttsInstalled ? 'verified_installed' : 'not_installed',
      availabilityStatus: ttsInstalled ? 'available' : 'not_installed',
    };
  });
  await putManyRecords(STORES.voice_profiles, syncedVoices);
}

export function buildDefaultProjectTracks(projectId: string): TimelineTrack[] {
  return [
    {
      trackId: `trk_${projectId}_original`,
      projectId,
      name: 'Original Audio',
      kind: 'original',
      characterId: null,
      orderIndex: 0,
      muted: false,
      solo: false,
      gainDb: 0,
      locked: true,
    },
    {
      trackId: `trk_${projectId}_music_sfx`,
      projectId,
      name: 'Music & SFX (Preserved)',
      kind: 'music_sfx',
      characterId: null,
      orderIndex: 1,
      muted: false,
      solo: false,
      gainDb: 0,
      locked: false,
    },
    {
      trackId: `trk_${projectId}_dialogue_master`,
      projectId,
      name: 'Hindi Dialogue Master',
      kind: 'dialogue',
      characterId: null,
      orderIndex: 2,
      muted: false,
      solo: false,
      gainDb: 0,
      locked: false,
    },
  ];
}

export async function clearTemporaryProcessingData(projectId?: string): Promise<number> {
  const entries = await getAllRecords<VaultEntry>(STORES.file_vault);
  const targets = entries.filter(
    (entry) =>
      entry.namespace === 'temp_processing' &&
      (!projectId || entry.projectId === projectId)
  );

  let reclaimedBytes = 0;
  for (const item of targets) {
    reclaimedBytes += item.sizeBytes;
    await deleteRecord(STORES.file_vault, item.vaultKey);
  }

  const frames = projectId
    ? await getByIndex<ExtractedFrame>(STORES.extracted_frames, 'projectId', projectId)
    : await getAllRecords<ExtractedFrame>(STORES.extracted_frames);
  for (const frame of frames) {
    await deleteRecord(STORES.extracted_frames, frame.id);
  }

  return reclaimedBytes;
}

export async function computeVaultNamespaceBytes(): Promise<Record<StorageNamespace, number>> {
  const totals: Record<StorageNamespace, number> = {
    original_media: 0,
    project_metadata: 0,
    generated_audio: 0,
    temp_processing: 0,
    installed_models: 0,
    exported_results: 0,
  };

  const vaultEntries = await getAllRecords<VaultEntry>(STORES.file_vault);
  for (const entry of vaultEntries) {
    totals[entry.namespace] = (totals[entry.namespace] ?? 0) + entry.sizeBytes;
  }

  // Add verified installed model sizes (stored in browser Cache API)
  const models = await getAllRecords<ModelMetadata>(STORES.model_metadata);
  for (const m of models) {
    if (m.installStatus === 'installed_verified' && m.fileSizeBytes) {
      totals.installed_models += m.fileSizeBytes;
    }
  }

  const projects = await getAllRecords<Project>(STORES.projects);
  const segments = await getAllRecords<DialogueSegment>(STORES.dialogue_segments);
  const characters = await getAllRecords<CharacterProfile>(STORES.characters);
  const logs = await getAllRecords<ProcessingLog>(STORES.processing_logs);
  const pronunciations = await getAllRecords<PronunciationEntry>(STORES.pronunciation_entries);
  const metaJsonBytes = new Blob([
    JSON.stringify({ projects, segments, characters, logs, pronunciations }),
  ]).size;
  totals.project_metadata = metaJsonBytes;

  return totals;
}

export async function deleteProjectCascade(
  projectId: string,
  options: { deleteOriginalMediaBlob: boolean }
): Promise<void> {
  const projectScopedStores: Array<{ store: StoreName; keyField: string }> = [
    { store: STORES.imported_media, keyField: 'id' },
    { store: STORES.media_metadata, keyField: 'id' },
    { store: STORES.scenes, keyField: 'id' },
    { store: STORES.extracted_frames, keyField: 'id' },
    { store: STORES.speakers, keyField: 'id' },
    { store: STORES.character_speaker_associations, keyField: 'id' },
    { store: STORES.voice_assignments, keyField: 'id' },
    { store: STORES.dialogue_segments, keyField: 'segmentId' },
    { store: STORES.translations, keyField: 'id' },
    { store: STORES.context_snapshots, keyField: 'id' },
    { store: STORES.processing_jobs, keyField: 'jobId' },
    { store: STORES.agent_executions, keyField: 'id' },
    { store: STORES.timeline_tracks, keyField: 'trackId' },
    { store: STORES.audio_clips, keyField: 'clipId' },
    { store: STORES.qa_reports, keyField: 'id' },
    { store: STORES.project_versions, keyField: 'id' },
    { store: STORES.checkpoints, keyField: 'id' },
    { store: STORES.processing_logs, keyField: 'id' },
    { store: STORES.sound_events, keyField: 'id' },
    { store: STORES.audio_stems, keyField: 'id' },
    { store: STORES.pipeline_artifacts, keyField: 'id' },
  ];

  for (const spec of projectScopedStores) {
    const records = await getByIndex<Record<string, unknown>>(
      spec.store,
      'projectId',
      projectId
    );
    for (const rec of records) {
      const key = rec[spec.keyField] as IDBValidKey;
      if (key !== undefined) {
        await deleteRecord(spec.store, key);
      }
    }
  }

  const vaultEntries = await getByIndex<VaultEntry>(
    STORES.file_vault,
    'projectId',
    projectId
  );
  for (const entry of vaultEntries) {
    if (entry.namespace === 'original_media' && !options.deleteOriginalMediaBlob) {
      continue;
    }
    await deleteRecord(STORES.file_vault, entry.vaultKey);
  }

  await deleteRecord(STORES.projects, projectId);
}

export interface ProjectBundle {
  project: Project;
  media: ImportedMedia | null;
  metadata: MediaMetadata | null;
  scenes: Scene[];
  frames: ExtractedFrame[];
  speakers: Speaker[];
  associations: CharacterSpeakerAssociation[];
  voiceAssignments: VoiceAssignment[];
  segments: DialogueSegment[];
  translations: TranslationRecord[];
  contextSnapshot: ContextSnapshot | null;
  jobs: ProcessingJob[];
  agentExecutions: AgentExecutionRecord[];
  tracks: TimelineTrack[];
  clips: AudioClip[];
  soundEvents: SoundEventRecord[];
  audioStems: AudioStemRecord[];
  qaReports: QAReport[];
  versions: ProjectVersion[];
  checkpoints: Checkpoint[];
  logs: ProcessingLog[];
}

export async function loadProjectBundle(projectId: string): Promise<ProjectBundle | null> {
  const project = await getRecord<Project>(STORES.projects, projectId);
  if (!project) return null;

  const [
    mediaList,
    metaList,
    scenes,
    frames,
    speakers,
    associations,
    voiceAssignments,
    segments,
    translations,
    contextList,
    jobs,
    agentExecutions,
    tracks,
    clips,
    soundEvents,
    audioStems,
    qaReports,
    versions,
    checkpoints,
    logs,
  ] = await Promise.all([
    getByIndex<ImportedMedia>(STORES.imported_media, 'projectId', projectId),
    getByIndex<MediaMetadata>(STORES.media_metadata, 'projectId', projectId),
    getByIndex<Scene>(STORES.scenes, 'projectId', projectId),
    getByIndex<ExtractedFrame>(STORES.extracted_frames, 'projectId', projectId),
    getByIndex<Speaker>(STORES.speakers, 'projectId', projectId),
    getByIndex<CharacterSpeakerAssociation>(STORES.character_speaker_associations, 'projectId', projectId),
    getByIndex<VoiceAssignment>(STORES.voice_assignments, 'projectId', projectId),
    getByIndex<DialogueSegment>(STORES.dialogue_segments, 'projectId', projectId),
    getByIndex<TranslationRecord>(STORES.translations, 'projectId', projectId),
    getByIndex<ContextSnapshot>(STORES.context_snapshots, 'projectId', projectId),
    getByIndex<ProcessingJob>(STORES.processing_jobs, 'projectId', projectId),
    getByIndex<AgentExecutionRecord>(STORES.agent_executions, 'projectId', projectId),
    getByIndex<TimelineTrack>(STORES.timeline_tracks, 'projectId', projectId),
    getByIndex<AudioClip>(STORES.audio_clips, 'projectId', projectId),
    getByIndex<SoundEventRecord>(STORES.sound_events, 'projectId', projectId),
    getByIndex<AudioStemRecord>(STORES.audio_stems, 'projectId', projectId),
    getByIndex<QAReport>(STORES.qa_reports, 'projectId', projectId),
    getByIndex<ProjectVersion>(STORES.project_versions, 'projectId', projectId),
    getByIndex<Checkpoint>(STORES.checkpoints, 'projectId', projectId),
    getByIndex<ProcessingLog>(STORES.processing_logs, 'projectId', projectId),
  ]);

  return {
    project,
    media: mediaList[0] ?? null,
    metadata: metaList[0] ?? null,
    scenes: scenes.sort((a, b) => a.index - b.index),
    frames,
    speakers,
    associations,
    voiceAssignments,
    segments: segments.sort((a, b) => a.originalStartMs - b.originalStartMs),
    translations,
    contextSnapshot: contextList[0] ?? null,
    jobs: jobs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    agentExecutions,
    tracks: tracks.sort((a, b) => a.orderIndex - b.orderIndex),
    clips: clips.sort((a, b) => a.startMs - b.startMs),
    soundEvents: soundEvents.sort((a, b) => a.startMs - b.startMs),
    audioStems: audioStems.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    qaReports: qaReports.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    versions: versions.sort((a, b) => b.versionNumber - a.versionNumber),
    checkpoints: checkpoints.sort((a, b) => b.savedAt.localeCompare(a.savedAt)),
    logs: logs.sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
  };
}
