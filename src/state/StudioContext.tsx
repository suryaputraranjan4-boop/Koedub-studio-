import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type {
  AppSettings,
  AudioClip,
  CharacterProfile,
  DialogueSegment,
  GeminiConnectionStatus,
  ImportedMedia,
  LanguageCode,
  MediaCategory,
  ModelMetadata,
  ProcessingJob,
  ProcessingLog,
  Project,
  ProjectVersion,
  PronunciationEntry,
  QAReport,
  ResourceSnapshot,
  ReviewStatus,
  ScreenId,
  SpeakerRoleType,
  TimelineTrack,
  TranslationRecord,
  VoiceAssignment,
  VoiceProfile,
} from '../types/domain';
import type { ProcessingPlan } from '../core/agents/types';
import {
  bootstrapLocalDatabase,
  buildDefaultProjectTracks,
  clearTemporaryProcessingData,
  DEFAULT_APP_SETTINGS,
  deleteProjectCascade,
  deleteRecord,
  getAllRecords,
  getRecord,
  loadProjectBundle,
  putManyRecords,
  putRecord,
  STORES,
  type ProjectBundle,
  type VaultEntry,
} from '../core/storage/database';
import {
  buildChunkPlan,
  createMediaMetadataRecord,
  probeMediaFile,
  validateMediaFile,
} from '../core/storage/mediaInspector';
import { resourceManager } from '../core/resources/resourceManager';
import { masterOrchestrator } from '../core/orchestrator/masterOrchestrator';
import { evaluateTimingAdjustment } from '../core/timeline/timelineEngine';
import { localModelRuntime } from '../core/ai/modelRuntime';
import {
  buildVoiceActingDirective,
  computeSynchronizedPlacement,
  synthesizeHindiWavWithModel,
} from '../core/ai/speechSynthesis';
import { computeWaveformPeaksFromBlob } from '../core/ai/audioProduction';
import {
  executeCollaborativeIntelligence,
  fetchGeminiConnectionStatus,
  synthesizeHindiWavViaGeminiCloud,
} from '../core/ai/intelligenceRouter';
import {
  buildProductionReportJson,
  buildSrtSubtitles,
  triggerBrowserDownload,
} from '../core/ai/exportManager';

export interface CreateProjectInput {
  name: string;
  seriesTitle: string;
  episodeLabel: string;
  mediaCategory: MediaCategory;
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  file?: File | null;
}

export interface CreateCharacterInput {
  displayName: string;
  seriesScope: string;
  visualDescriptors: string[];
  associatedSpeakerIds: string[];
  pitchRange: string;
  timbre: string;
  pacing: string;
  ageEstimate: string;
  genderPresentation: string;
  assignedHindiVoiceId: string | null;
  voiceLocked: boolean;
  personality: string;
  speakingStyle: string;
  speakerRole: SpeakerRoleType;
  identityConfidence: number;
  reviewStatus: ReviewStatus;
  ambiguityNote: string;
}

export interface CreateDialogueSegmentInput {
  projectId: string;
  sourceSpeakerId: string;
  characterId: string | null;
  originalStartMs: number;
  originalEndMs: number;
  japaneseText: string;
  hindiText: string;
  primaryEmotion: string;
  emotionIntensity: number;
}

interface StudioContextValue {
  ready: boolean;
  loadError: string | null;
  activeScreen: ScreenId;
  setActiveScreen: (screen: ScreenId) => void;
  projects: Project[];
  activeProjectId: string | null;
  setActiveProjectId: (projectId: string | null) => void;
  activeBundle: ProjectBundle | null;
  characters: CharacterProfile[];
  voices: VoiceProfile[];
  models: ModelMetadata[];
  pronunciations: PronunciationEntry[];
  allJobs: ProcessingJob[];
  settings: AppSettings;
  resources: ResourceSnapshot | null;
  activePlan: ProcessingPlan | null;
  isPipelineRunning: boolean;
  modelDownloadProgress: Record<string, { percent: number; text: string }>;
  playingVaultKey: string | null;
  geminiStatus: GeminiConnectionStatus | null;
  focusedClipId: string | null;
  setFocusedClipId: (clipId: string | null) => void;
  jumpToAudioStudioClip: (clipId: string | null, segmentId?: string | null) => void;
  refreshGeminiStatus: (verifyLive?: boolean) => Promise<GeminiConnectionStatus>;
  collaborateOnSegment: (
    segmentId: string,
    taskType?: 'translate_and_adapt' | 'concise_timing_rewrite' | 'semantic_qa_review'
  ) => Promise<{ ok: boolean; message: string }>;
  regenerateCharacterDialogues: (
    characterId: string
  ) => Promise<{ ok: boolean; message: string }>;
  mixProjectMasterAudio: (projectId: string) => Promise<{ ok: boolean; message: string }>;
  exportProjectAsset: (
    projectId: string,
    format: 'final_wav' | 'hindi_srt' | 'japanese_srt' | 'production_json'
  ) => Promise<{ ok: boolean; message: string }>;
  refreshAll: (overrideActiveId?: string | null) => Promise<void>;
  refreshResources: () => Promise<void>;
  createProject: (input: CreateProjectInput) => Promise<{ project: Project; warning?: string }>;
  importMediaIntoProject: (projectId: string, file: File) => Promise<{ ok: boolean; error?: string }>;
  renameProject: (projectId: string, newName: string) => Promise<void>;
  deleteProject: (projectId: string, deleteOriginalMediaBlob: boolean) => Promise<void>;
  createCharacter: (input: CreateCharacterInput) => Promise<CharacterProfile>;
  updateCharacter: (character: CharacterProfile) => Promise<void>;
  assignVoiceToCharacter: (
    characterId: string,
    voiceId: string | null,
    locked: boolean,
    reason: string
  ) => Promise<void>;
  addCharacterRelationship: (
    characterId: string,
    targetCharacterId: string,
    relationType: string,
    politenessRegister: string,
    notes: string
  ) => Promise<void>;
  addPronunciationEntry: (input: {
    sourceTerm: string;
    targetHindiForm: string;
    category: PronunciationEntry['category'];
    notes?: string;
    seriesScope?: string;
    phoneticHint?: string;
  }) => Promise<PronunciationEntry>;
  deletePronunciationEntry: (entryId: string) => Promise<void>;
  createDialogueSegment: (input: CreateDialogueSegmentInput) => Promise<DialogueSegment>;
  updateDialogueSegment: (segment: DialogueSegment) => Promise<void>;
  deleteDialogueSegment: (segmentId: string) => Promise<void>;
  synthesizeSingleSegment: (segmentId: string) => Promise<{ ok: boolean; message: string }>;
  downloadModel: (modelId: string) => Promise<{ ok: boolean; message: string }>;
  removeModel: (modelId: string) => Promise<void>;
  playVaultAudio: (vaultKey: string) => Promise<{ ok: boolean; error?: string }>;
  stopAudioPlayback: () => void;
  previewHindiVoice: (voiceId: string, sampleText?: string) => Promise<{ ok: boolean; error?: string }>;
  saveTimelineState: (
    projectId: string,
    tracks: TimelineTrack[],
    clips: AudioClip[]
  ) => Promise<void>;
  addCharacterTrackToTimeline: (projectId: string, character: CharacterProfile) => Promise<void>;
  runFoundationPipeline: (projectId: string, resumeFromCheckpoint: boolean) => Promise<void>;
  cancelActivePipeline: (projectId: string) => void;
  runStructuralQACheck: (projectId: string) => Promise<QAReport>;
  updateSettings: (partial: Partial<AppSettings>) => Promise<void>;
  purgeTemporaryStorage: (projectId?: string) => Promise<number>;
}

const StudioContext = createContext<StudioContextValue | null>(null);

export function StudioProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeScreen, setActiveScreen] = useState<ScreenId>('home');
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(null);
  const [activeBundle, setActiveBundle] = useState<ProjectBundle | null>(null);
  const [characters, setCharacters] = useState<CharacterProfile[]>([]);
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [models, setModels] = useState<ModelMetadata[]>([]);
  const [pronunciations, setPronunciations] = useState<PronunciationEntry[]>([]);
  const [allJobs, setAllJobs] = useState<ProcessingJob[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [resources, setResources] = useState<ResourceSnapshot | null>(null);
  const [activePlan, setActivePlan] = useState<ProcessingPlan | null>(null);
  const [isPipelineRunning, setIsPipelineRunning] = useState(false);
  const [modelDownloadProgress, setModelDownloadProgress] = useState<
    Record<string, { percent: number; text: string }>
  >({});
  const [playingVaultKey, setPlayingVaultKey] = useState<string | null>(null);
  const [geminiStatus, setGeminiStatus] = useState<GeminiConnectionStatus | null>(null);
  const [focusedClipId, setFocusedClipId] = useState<string | null>(null);
  const audioRef = React.useRef<{ audio: HTMLAudioElement; url: string } | null>(null);

  const refreshGeminiStatus = useCallback(async (verifyLive: boolean = false) => {
    const status = await fetchGeminiConnectionStatus(verifyLive);
    setGeminiStatus(status);
    return status;
  }, []);

  const jumpToAudioStudioClip = useCallback(
    (clipId: string | null, segmentId?: string | null) => {
      const resolvedId = clipId || (segmentId ? `clip_${segmentId}` : null);
      setFocusedClipId(resolvedId);
      setActiveScreen('audio_studio');
    },
    []
  );

  const refreshResourcesInternal = useCallback(async (currentSettings: AppSettings) => {
    const snap = await resourceManager.captureSnapshot(currentSettings);
    setResources(snap);
  }, []);

  const refreshAll = useCallback(
    async (overrideActiveId?: string | null) => {
      try {
        await bootstrapLocalDatabase();
        const [
          projList,
          charList,
          voiceList,
          modelList,
          pronList,
          jobList,
          storedSettings,
        ] = await Promise.all([
          getAllRecords<Project>(STORES.projects),
          getAllRecords<CharacterProfile>(STORES.characters),
          getAllRecords<VoiceProfile>(STORES.voice_profiles),
          getAllRecords<ModelMetadata>(STORES.model_metadata),
          getAllRecords<PronunciationEntry>(STORES.pronunciation_entries),
          getAllRecords<ProcessingJob>(STORES.processing_jobs),
          getRecord<AppSettings>(STORES.app_settings, 'app_settings'),
        ]);

        const sortedProjects = [...projList].sort((a, b) =>
          b.updatedAt.localeCompare(a.updatedAt)
        );
        const activeSettings = storedSettings ?? DEFAULT_APP_SETTINGS;

        setProjects(sortedProjects);
        setCharacters(
          [...charList].sort((a, b) => a.displayName.localeCompare(b.displayName))
        );
        setVoices(voiceList);
        setModels(modelList);
        setPronunciations(
          [...pronList].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        );
        setAllJobs([...jobList].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
        setSettings(activeSettings);

        const resolvedActiveId =
          overrideActiveId !== undefined
            ? overrideActiveId
            : activeProjectId && sortedProjects.some((p) => p.id === activeProjectId)
            ? activeProjectId
            : sortedProjects[0]?.id ?? null;

        setActiveProjectIdState(resolvedActiveId);

        if (resolvedActiveId) {
          const bundle = await loadProjectBundle(resolvedActiveId);
          setActiveBundle(bundle);
        } else {
          setActiveBundle(null);
        }

        await refreshResourcesInternal(activeSettings);
        setReady(true);
      } catch (err) {
        setLoadError(
          err instanceof Error
            ? err.message
            : 'Unable to initialize local IndexedDB storage.'
        );
        setReady(true);
      }
    },
    [activeProjectId, refreshResourcesInternal]
  );

  useEffect(() => {
    void refreshAll();
    void refreshGeminiStatus(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setActiveProjectId = useCallback(async (projectId: string | null) => {
    setActiveProjectIdState(projectId);
    setActivePlan(null);
    if (projectId) {
      const bundle = await loadProjectBundle(projectId);
      setActiveBundle(bundle);
    } else {
      setActiveBundle(null);
    }
  }, []);

  const refreshResources = useCallback(async () => {
    await refreshResourcesInternal(settings);
  }, [refreshResourcesInternal, settings]);

  const attachMediaFileToProject = useCallback(
    async (project: Project, file: File): Promise<{ ok: boolean; error?: string }> => {
      const validation = validateMediaFile(file.name, file.type, file.size);
      if (!validation.valid || !validation.spec) {
        return { ok: false, error: validation.errorMessage ?? 'Unsupported media file.' };
      }

      const now = new Date().toISOString();
      const mediaId = `med_${project.id}_${Date.now()}`;
      const vaultKey = `original_media/${project.id}/${mediaId}_${file.name}`;

      // Store binary file inside separated original_media namespace (never in project metadata record)
      const vaultEntry: VaultEntry = {
        vaultKey,
        projectId: project.id,
        namespace: 'original_media',
        fileName: file.name,
        mimeType: file.type || validation.spec.mimeTypes[0],
        sizeBytes: file.size,
        blob: file,
        storedAt: now,
      };
      await putRecord(STORES.file_vault, vaultEntry);

      // Probe real browser-decodable metadata
      const probe = await probeMediaFile(
        file,
        validation.spec.kind,
        validation.spec.containerLabel
      );

      const chunkDurationMs = settings.chunkDurationSec * 1000;
      const chunkOverlapMs = settings.chunkOverlapSec * 1000;
      const chunkPlan = buildChunkPlan(probe.durationMs, chunkDurationMs, chunkOverlapMs);

      const importedMedia: ImportedMedia = {
        id: mediaId,
        projectId: project.id,
        fileName: file.name,
        fileExtension: validation.extension,
        mimeType: file.type || validation.spec.mimeTypes[0],
        mediaKind: validation.spec.kind,
        sizeBytes: file.size,
        storageNamespace: 'original_media',
        vaultKey,
        preservedOriginal: true,
        importedAt: now,
        originalLastModifiedMs: file.lastModified || Date.now(),
        chunkPlan,
        chunkDurationMs,
        chunkOverlapMs,
      };
      await putRecord(STORES.imported_media, importedMedia);

      const metadata = createMediaMetadataRecord(
        project.id,
        mediaId,
        validation.spec.containerLabel,
        probe
      );
      await putRecord(STORES.media_metadata, metadata);

      // Add reference clip on Original Audio track with real PCM waveform peaks (null if unreadable)
      const existingTracks = (await loadProjectBundle(project.id))?.tracks ?? [];
      const originalTrack = existingTracks.find((t) => t.kind === 'original');
      if (originalTrack && probe.durationMs && probe.durationMs > 0) {
        const realPeaks = await computeWaveformPeaksFromBlob(file, 140);
        const refClip: AudioClip = {
          clipId: `clip_orig_${mediaId}`,
          projectId: project.id,
          trackId: originalTrack.trackId,
          segmentId: null,
          label: `Original: ${file.name}`,
          startMs: 0,
          endMs: probe.durationMs,
          durationMs: probe.durationMs,
          sourceNamespace: 'original_media',
          sourceRef: vaultKey,
          hasRealAudio: true,
          waveformPeaks: realPeaks,
          volumeDb: 0,
          fadeInMs: 0,
          fadeOutMs: 0,
        };
        await putRecord(STORES.audio_clips, refClip);
      }

      const updatedProject: Project = {
        ...project,
        status: 'imported',
        importedMediaId: mediaId,
        lastStageLabel: 'Media Imported (Original Preserved)',
        updatedAt: now,
      };
      await putRecord(STORES.projects, updatedProject);

      const log: ProcessingLog = {
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        projectId: project.id,
        jobId: null,
        agentId: 'media_analyzer',
        level: 'info',
        message: `Imported "${file.name}" (${validation.spec.containerLabel}) into isolated original_media storage. Planned ${chunkPlan.length} overlapping processing chunks.`,
        timestamp: now,
      };
      await putRecord(STORES.processing_logs, log);

      return { ok: true };
    },
    [settings.chunkDurationSec, settings.chunkOverlapSec]
  );

  const createProject = useCallback(
    async (input: CreateProjectInput): Promise<{ project: Project; warning?: string }> => {
      const trimmedName = input.name.trim();
      if (!trimmedName) {
        throw new Error('Project name is required.');
      }

      const now = new Date().toISOString();
      const id = `prj_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const project: Project = {
        id,
        name: trimmedName,
        seriesTitle: input.seriesTitle.trim() || trimmedName,
        episodeLabel: input.episodeLabel.trim() || 'Episode 01',
        mediaCategory: input.mediaCategory,
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        status: 'draft',
        workingDirectoryPath: `local://koedub/projects/${id}`,
        importedMediaId: null,
        lastCheckpointId: null,
        lastStageLabel: 'Project Created',
        createdAt: now,
        updatedAt: now,
      };

      await putRecord(STORES.projects, project);
      await putManyRecords(STORES.timeline_tracks, buildDefaultProjectTracks(id));

      const initialVersion: ProjectVersion = {
        id: `ver_${id}_1`,
        projectId: id,
        versionNumber: 1,
        label: 'v1.0 Foundation Initialized',
        createdAt: now,
        summary: `Initialized local workspace (${input.sourceLanguage.toUpperCase()} → ${input.targetLanguage.toUpperCase()}).`,
      };
      await putRecord(STORES.project_versions, initialVersion);

      let warning: string | undefined;
      if (input.file) {
        const mediaResult = await attachMediaFileToProject(project, input.file);
        if (!mediaResult.ok) {
          warning = mediaResult.error;
        }
      }

      await refreshAll(id);
      const persisted = (await getRecord<Project>(STORES.projects, id)) ?? project;
      return { project: persisted, warning };
    },
    [attachMediaFileToProject, refreshAll]
  );

  const importMediaIntoProject = useCallback(
    async (projectId: string, file: File): Promise<{ ok: boolean; error?: string }> => {
      const project = await getRecord<Project>(STORES.projects, projectId);
      if (!project) return { ok: false, error: 'Selected project not found.' };
      const result = await attachMediaFileToProject(project, file);
      if (result.ok) {
        await refreshAll(projectId);
      }
      return result;
    },
    [attachMediaFileToProject, refreshAll]
  );

  const renameProject = useCallback(
    async (projectId: string, newName: string) => {
      const clean = newName.trim();
      if (!clean) return;
      const project = await getRecord<Project>(STORES.projects, projectId);
      if (!project) return;
      await putRecord<Project>(STORES.projects, {
        ...project,
        name: clean,
        updatedAt: new Date().toISOString(),
      });
      await refreshAll(activeProjectId);
    },
    [activeProjectId, refreshAll]
  );

  const deleteProject = useCallback(
    async (projectId: string, deleteOriginalMediaBlob: boolean) => {
      await deleteProjectCascade(projectId, { deleteOriginalMediaBlob });
      const nextActive = activeProjectId === projectId ? null : activeProjectId;
      await refreshAll(nextActive);
    },
    [activeProjectId, refreshAll]
  );

  const createCharacter = useCallback(
    async (input: CreateCharacterInput): Promise<CharacterProfile> => {
      const now = new Date().toISOString();
      const characterId = `CHR-${Date.now().toString(36).toUpperCase()}`;
      const voiceObj = voices.find((v) => v.voiceId === input.assignedHindiVoiceId);

      const profile: CharacterProfile = {
        characterId,
        projectId: activeProjectId,
        seriesScope: input.seriesScope.trim() || activeBundle?.project.seriesTitle || 'Global Series Memory',
        displayName: input.displayName.trim(),
        visualDescriptors: input.visualDescriptors.filter(Boolean),
        associatedSpeakerIds: input.associatedSpeakerIds.filter(Boolean),
        voiceCharacteristics: {
          pitchRange: input.pitchRange.trim() || 'Unspecified',
          timbre: input.timbre.trim() || 'Unspecified',
          pacing: input.pacing.trim() || 'Medium',
          ageEstimate: input.ageEstimate.trim() || 'Unspecified',
          genderPresentation: input.genderPresentation.trim() || 'Unspecified',
        },
        assignedHindiVoiceId: input.assignedHindiVoiceId,
        voiceLocked: input.voiceLocked,
        personality: input.personality.trim() || 'Not specified',
        speakingStyle: input.speakingStyle.trim() || 'Natural conversational',
        relationships: [],
        dialogueHistoryIds: [],
        firstSeenMs: null,
        lastSeenMs: null,
        identityConfidence: input.identityConfidence,
        reviewStatus: input.reviewStatus,
        speakerRole: input.speakerRole,
        ambiguityNote: input.ambiguityNote.trim(),
        voiceAssignmentHistory: input.assignedHindiVoiceId
          ? [
              {
                voiceId: input.assignedHindiVoiceId,
                voiceName: voiceObj?.displayName ?? input.assignedHindiVoiceId,
                assignedAt: now,
                reason: 'Initial manual voice assignment',
                locked: input.voiceLocked,
              },
            ]
          : [],
        createdAt: now,
        updatedAt: now,
      };

      await putRecord(STORES.characters, profile);

      if (activeProjectId && input.assignedHindiVoiceId) {
        const va: VoiceAssignment = {
          id: `va_${activeProjectId}_${characterId}`,
          projectId: activeProjectId,
          characterId,
          voiceId: input.assignedHindiVoiceId,
          locked: input.voiceLocked,
          assignedBy: 'user',
          assignedAt: now,
        };
        await putRecord(STORES.voice_assignments, va);
      }

      await refreshAll(activeProjectId);
      return profile;
    },
    [activeBundle?.project.seriesTitle, activeProjectId, refreshAll, voices]
  );

  const updateCharacter = useCallback(
    async (character: CharacterProfile) => {
      await putRecord(STORES.characters, {
        ...character,
        updatedAt: new Date().toISOString(),
      });
      await refreshAll(activeProjectId);
    },
    [activeProjectId, refreshAll]
  );

  const assignVoiceToCharacter = useCallback(
    async (
      characterId: string,
      voiceId: string | null,
      locked: boolean,
      reason: string
    ) => {
      const char = await getRecord<CharacterProfile>(STORES.characters, characterId);
      if (!char) return;
      const now = new Date().toISOString();
      const voiceObj = voices.find((v) => v.voiceId === voiceId);

      const historyEntry = voiceId
        ? [
            {
              voiceId,
              voiceName: voiceObj?.displayName ?? voiceId,
              assignedAt: now,
              reason,
              locked,
            },
            ...char.voiceAssignmentHistory,
          ]
        : char.voiceAssignmentHistory;

      await putRecord<CharacterProfile>(STORES.characters, {
        ...char,
        assignedHindiVoiceId: voiceId,
        voiceLocked: locked,
        voiceAssignmentHistory: historyEntry,
        updatedAt: now,
      });

      if (activeProjectId && voiceId) {
        const va: VoiceAssignment = {
          id: `va_${activeProjectId}_${characterId}`,
          projectId: activeProjectId,
          characterId,
          voiceId,
          locked,
          assignedBy: 'user',
          assignedAt: now,
        };
        await putRecord(STORES.voice_assignments, va);
      }

      await refreshAll(activeProjectId);
    },
    [activeProjectId, refreshAll, voices]
  );

  const addCharacterRelationship = useCallback(
    async (
      characterId: string,
      targetCharacterId: string,
      relationType: string,
      politenessRegister: string,
      notes: string
    ) => {
      const char = await getRecord<CharacterProfile>(STORES.characters, characterId);
      const target = await getRecord<CharacterProfile>(STORES.characters, targetCharacterId);
      if (!char || !target) return;

      const updated: CharacterProfile = {
        ...char,
        relationships: [
          ...char.relationships.filter((r) => r.targetCharacterId !== targetCharacterId),
          {
            targetCharacterId,
            targetName: target.displayName,
            relationType: relationType.trim(),
            politenessRegister: politenessRegister.trim(),
            notes: notes.trim(),
          },
        ],
        updatedAt: new Date().toISOString(),
      };
      await putRecord(STORES.characters, updated);
      await refreshAll(activeProjectId);
    },
    [activeProjectId, refreshAll]
  );

  const addPronunciationEntry = useCallback(
    async (input: {
      sourceTerm: string;
      targetHindiForm: string;
      category: PronunciationEntry['category'];
      notes?: string;
      seriesScope?: string;
      phoneticHint?: string;
    }): Promise<PronunciationEntry> => {
      const entry: PronunciationEntry = {
        id: `pron_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        seriesScope: input.seriesScope?.trim() || activeBundle?.project.seriesTitle || 'Global',
        sourceTerm: input.sourceTerm.trim(),
        targetHindiForm: input.targetHindiForm.trim(),
        phoneticHint: (input.phoneticHint ?? '').trim(),
        category: input.category,
        notes: (input.notes ?? '').trim(),
        updatedAt: new Date().toISOString(),
      };
      await putRecord(STORES.pronunciation_entries, entry);
      await refreshAll(activeProjectId);
      return entry;
    },
    [activeBundle?.project.seriesTitle, activeProjectId, refreshAll]
  );

  const deletePronunciationEntry = useCallback(
    async (entryId: string) => {
      await deleteRecord(STORES.pronunciation_entries, entryId);
      await refreshAll(activeProjectId);
    },
    [activeProjectId, refreshAll]
  );

  const stopAudioPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.audio.pause();
      URL.revokeObjectURL(audioRef.current.url);
      audioRef.current = null;
    }
    setPlayingVaultKey(null);
  }, []);

  const playBlobInternal = useCallback(
    async (blob: Blob, keyLabel: string): Promise<{ ok: boolean; error?: string }> => {
      stopAudioPlayback();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = { audio, url };
      setPlayingVaultKey(keyLabel);

      audio.onended = () => {
        if (audioRef.current?.url === url) {
          URL.revokeObjectURL(url);
          audioRef.current = null;
          setPlayingVaultKey(null);
        }
      };
      audio.onerror = () => {
        if (audioRef.current?.url === url) {
          URL.revokeObjectURL(url);
          audioRef.current = null;
          setPlayingVaultKey(null);
        }
      };

      try {
        await audio.play();
        return { ok: true };
      } catch (err) {
        stopAudioPlayback();
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : 'Browser blocked or failed audio playback.',
        };
      }
    },
    [stopAudioPlayback]
  );

  const playVaultAudio = useCallback(
    async (vaultKey: string): Promise<{ ok: boolean; error?: string }> => {
      const entry = await getRecord<VaultEntry>(STORES.file_vault, vaultKey);
      if (!entry) {
        return { ok: false, error: 'Audio file not found in local file_vault storage.' };
      }
      return playBlobInternal(entry.blob, vaultKey);
    },
    [playBlobInternal]
  );

  const downloadModel = useCallback(
    async (modelId: string): Promise<{ ok: boolean; message: string }> => {
      try {
        setModelDownloadProgress((prev) => ({
          ...prev,
          [modelId]: { percent: 2, text: 'Initializing offline model download…' },
        }));
        const verified = await localModelRuntime.downloadAndVerifyModel(modelId, (info) => {
          setModelDownloadProgress((prev) => ({
            ...prev,
            [modelId]: { percent: info.progressPercent, text: info.statusText },
          }));
        });
        await refreshAll(activeProjectId);
        return {
          ok: true,
          message: `${verified.name} downloaded, cached offline, and verified.`,
        };
      } catch (err) {
        await refreshAll(activeProjectId);
        return {
          ok: false,
          message:
            err instanceof Error
              ? err.message
              : 'Model download or local verification failed.',
        };
      } finally {
        setModelDownloadProgress((prev) => {
          const next = { ...prev };
          delete next[modelId];
          return next;
        });
      }
    },
    [activeProjectId, refreshAll]
  );

  const removeModel = useCallback(
    async (modelId: string) => {
      await localModelRuntime.removeInstalledModel(modelId);
      await refreshAll(activeProjectId);
    },
    [activeProjectId, refreshAll]
  );

  const previewHindiVoice = useCallback(
    async (
      voiceId: string,
      sampleText: string = 'नमस्ते, यह लोकल ऑफ़लाइन हिंदी आवाज़ का परीक्षण है।'
    ): Promise<{ ok: boolean; error?: string }> => {
      const voice = voices.find((v) => v.voiceId === voiceId);
      if (!voice) return { ok: false, error: 'Voice profile not found.' };
      const installed = await localModelRuntime.isModelInstalled('model_mms_tts_hin');
      if (!installed) {
        return {
          ok: false,
          error:
            'Meta MMS-TTS Hindi is not installed locally. Download & verify it in Model Manager first.',
        };
      }

      try {
        type TtsPipe = (text: string) => Promise<{ audio: Float32Array; sampling_rate: number }>;
        const ttsPipe = await localModelRuntime.loadInstalledModel<TtsPipe>('model_mms_tts_hin');
        const directive = buildVoiceActingDirective(
          { primaryEmotion: 'Calm', intensity: 0.4, deliveryNotes: 'Voice preview', source: 'manual' },
          voice
        );
        const result = await synthesizeHindiWavWithModel({
          ttsPipeline: ttsPipe,
          hindiText: sampleText,
          directive,
        });
        return await playBlobInternal(result.wavBlob, `preview:${voiceId}`);
      } catch (err) {
        return {
          ok: false,
          error:
            err instanceof Error
              ? err.message
              : 'Hindi TTS synthesis failed during voice preview.',
        };
      } finally {
        await localModelRuntime.unloadActiveModel();
      }
    },
    [playBlobInternal, voices]
  );

  const synthesizeSingleSegment = useCallback(
    async (segmentId: string): Promise<{ ok: boolean; message: string }> => {
      const seg = await getRecord<DialogueSegment>(STORES.dialogue_segments, segmentId);
      if (!seg) return { ok: false, message: 'Dialogue segment not found.' };
      if (!seg.hindiText.trim()) {
        return { ok: false, message: 'Enter or translate Hindi dialogue text before synthesizing.' };
      }

      const useCloudTts =
        settings.cloudTtsEnabled &&
        !settings.offlineOnlyMode &&
        settings.cloudIntelligenceEnabled;
      const installed = await localModelRuntime.isModelInstalled('model_mms_tts_hin');

      if (!installed && !useCloudTts) {
        return {
          ok: false,
          message:
            'Meta MMS-TTS Hindi is not installed. Download & verify it in Model Manager (or enable optional Gemini Cloud TTS in Settings).',
        };
      }

      try {
        const voice = voices.find((v) => v.voiceId === seg.assignedHindiVoiceId) ?? voices[0] ?? null;
        const directive = buildVoiceActingDirective(seg.emotion, voice);

        let wavBlob: Blob;
        let durationMs: number;
        let engineText = 'Meta MMS-TTS-HIN (16 kHz offline)';

        if (useCloudTts) {
          const cloudRes = await synthesizeHindiWavViaGeminiCloud({
            hindiText: seg.hindiText,
            emotionStyle: `${seg.emotion.primaryEmotion} anime Hindi dubbing (${directive.deliveryStyle})`,
            voiceName: 'Kore',
            model: settings.preferredCloudTtsModel || 'gemini-3.8-flash-lite-tts',
          });
          wavBlob = cloudRes.wavBlob;
          durationMs = cloudRes.durationMs;
          engineText = `Gemini Cloud TTS (${cloudRes.model}, 24 kHz)`;
          void refreshGeminiStatus(false);
        } else {
          type TtsPipe = (text: string) => Promise<{ audio: Float32Array; sampling_rate: number }>;
          const ttsPipe = await localModelRuntime.loadInstalledModel<TtsPipe>('model_mms_tts_hin');
          const synth = await synthesizeHindiWavWithModel({
            ttsPipeline: ttsPipe,
            hindiText: seg.hindiText,
            directive,
          });
          wavBlob = synth.wavBlob;
          durationMs = synth.durationMs;
        }

        const now = new Date().toISOString();
        const vaultKey = `generated_audio/${seg.projectId}/${seg.segmentId}.wav`;
        const entry: VaultEntry = {
          vaultKey,
          projectId: seg.projectId,
          namespace: 'generated_audio',
          fileName: `${seg.segmentId}.wav`,
          mimeType: 'audio/wav',
          sizeBytes: wavBlob.size,
          blob: wavBlob,
          storedAt: now,
        };
        await putRecord(STORES.file_vault, entry);

        const sync = computeSynchronizedPlacement({
          originalStartMs: seg.originalStartMs,
          originalEndMs: seg.originalEndMs,
          measuredAudioDurationMs: durationMs,
          preferredShiftLimitMs: seg.preferredShiftLimitMs || settings.preferredTimingAdjustmentMs,
        });

        const timingMatchLabel: DialogueSegment['timingMatchLabel'] =
          sync.syncStatus === 'needs_adjustment'
            ? 'Needs Review'
            : Math.abs(sync.syncDeltaMs) <= 150
            ? 'Matched'
            : 'Close Match';

        await putRecord<DialogueSegment>(STORES.dialogue_segments, {
          ...seg,
          assignedHindiVoiceId: voice?.voiceId ?? seg.assignedHindiVoiceId,
          actingDirective: directive,
          generatedAudioRef: vaultKey,
          actualGeneratedDurationMs: durationMs,
          finalStartMs: sync.finalStartMs,
          finalEndMs: sync.finalEndMs,
          syncDeltaMs: sync.syncDeltaMs,
          appliedSpeedMultiplier: sync.appliedSpeedMultiplier,
          syncStatus: sync.syncStatus,
          timingMatchLabel,
          updatedAt: now,
        });

        const realPeaks = await computeWaveformPeaksFromBlob(wavBlob, 64);
        const existingClip = await getRecord<AudioClip>(
          STORES.audio_clips,
          `clip_${seg.segmentId}`
        );
        if (existingClip) {
          await putRecord<AudioClip>(STORES.audio_clips, {
            ...existingClip,
            startMs: sync.finalStartMs,
            endMs: sync.finalEndMs,
            durationMs: Math.max(100, sync.finalEndMs - sync.finalStartMs),
            sourceNamespace: 'generated_audio',
            sourceRef: vaultKey,
            hasRealAudio: true,
            waveformPeaks: realPeaks,
          });
        }

        await refreshAll(seg.projectId);
        return {
          ok: true,
          message: `${engineText} synthesized real Hindi WAV (${(durationMs / 1000).toFixed(2)}s). ${sync.note}`,
        };
      } catch (err) {
        return {
          ok: false,
          message: err instanceof Error ? err.message : 'Hindi TTS generation failed.',
        };
      } finally {
        await localModelRuntime.unloadActiveModel();
      }
    },
    [
      refreshAll,
      refreshGeminiStatus,
      settings.cloudIntelligenceEnabled,
      settings.cloudTtsEnabled,
      settings.offlineOnlyMode,
      settings.preferredCloudTtsModel,
      settings.preferredTimingAdjustmentMs,
      voices,
    ]
  );

  const collaborateOnSegment = useCallback(
    async (
      segmentId: string,
      taskType: 'translate_and_adapt' | 'concise_timing_rewrite' | 'semantic_qa_review' = 'translate_and_adapt'
    ): Promise<{ ok: boolean; message: string }> => {
      const seg = await getRecord<DialogueSegment>(STORES.dialogue_segments, segmentId);
      if (!seg) return { ok: false, message: 'Dialogue segment not found.' };

      const bundle = await loadProjectBundle(seg.projectId);
      const segments = bundle?.segments ?? [];
      const idx = segments.findIndex((s) => s.segmentId === segmentId);
      const char = seg.characterId
        ? characters.find((c) => c.characterId === seg.characterId) ?? null
        : null;
      const register = char?.relationships[0]?.politenessRegister ?? '';

      const outcome = await executeCollaborativeIntelligence({
        taskType,
        japaneseText: seg.japaneseText,
        localDraftHindi: seg.hindiText,
        characterContext: char
          ? `${char.displayName} (${char.personality}; style: ${char.speakingStyle})`
          : seg.sourceSpeakerId,
        politenessRegister: register,
        targetDurationMs: seg.originalDurationMs,
        previousTurns: segments
          .slice(Math.max(0, idx - 2), Math.max(0, idx))
          .map((s) => `${s.sourceSpeakerId}: ${s.japaneseText || s.hindiText}`),
        nextTurns: segments
          .slice(idx + 1, idx + 3)
          .map((s) => `${s.sourceSpeakerId}: ${s.japaneseText || s.hindiText}`),
        pronunciationRules: pronunciations,
        settings,
      });

      const now = new Date().toISOString();
      await putRecord<DialogueSegment>(STORES.dialogue_segments, {
        ...seg,
        hindiText: outcome.hindiText || seg.hindiText,
        collaborativeMeta: outcome.meta,
        reviewStatus: outcome.meta.disagreementFlag ? 'needs_review' : seg.reviewStatus,
        updatedAt: now,
      });

      await putRecord<TranslationRecord>(STORES.translations, {
        id: `tr_${seg.segmentId}`,
        projectId: seg.projectId,
        segmentId: seg.segmentId,
        sourceLang: 'ja',
        targetLang: 'hi',
        sourceText: seg.japaneseText,
        translatedText: outcome.hindiText || seg.hindiText,
        contextNotes: outcome.meta.culturalNote,
        pronunciationOverrides: [],
        collaborativeMeta: outcome.meta,
        status: outcome.meta.disagreementFlag ? 'needs_review' : 'draft',
        updatedAt: now,
      });

      void refreshGeminiStatus(false);
      await refreshAll(seg.projectId);

      if (outcome.meta.cloudReviewPending) {
        return {
          ok: true,
          message: `Completed locally (${outcome.meta.modelUsed ?? 'Offline'}). ${outcome.meta.culturalNote}`,
        };
      }
      return {
        ok: true,
        message: `Collaborative review completed via ${outcome.meta.modelUsed ?? 'Gemini'} (${outcome.meta.alternatives.length} option(s)).`,
      };
    },
    [characters, pronunciations, refreshAll, refreshGeminiStatus, settings]
  );

  const regenerateCharacterDialogues = useCallback(
    async (characterId: string): Promise<{ ok: boolean; message: string }> => {
      if (!activeBundle) return { ok: false, message: 'No active project selected.' };
      const targets = activeBundle.segments.filter(
        (s) => s.characterId === characterId && s.hindiText.trim().length > 0
      );
      if (targets.length === 0) {
        return {
          ok: false,
          message: 'No Hindi dialogue segments found for this character in the active project.',
        };
      }
      let okCount = 0;
      let lastError = '';
      for (const seg of targets) {
        const res = await synthesizeSingleSegment(seg.segmentId);
        if (res.ok) okCount += 1;
        else lastError = res.message;
      }
      return {
        ok: okCount > 0,
        message:
          okCount > 0
            ? `Regenerated ${okCount} of ${targets.length} dialogue WAV(s) for this character.`
            : lastError || 'Character dialogue regeneration failed.',
      };
    },
    [activeBundle, synthesizeSingleSegment]
  );

  const mixProjectMasterAudio = useCallback(
    async (projectId: string): Promise<{ ok: boolean; message: string }> => {
      const outcome = await masterOrchestrator.runAudioMixingForProject(projectId);
      await refreshAll(projectId);
      return {
        ok: outcome.status === 'completed' || outcome.status === 'completed_with_warnings',
        message: outcome.outputSummary,
      };
    },
    [refreshAll]
  );

  const exportProjectAsset = useCallback(
    async (
      projectId: string,
      format: 'final_wav' | 'hindi_srt' | 'japanese_srt' | 'production_json'
    ): Promise<{ ok: boolean; message: string }> => {
      const bundle = await loadProjectBundle(projectId);
      if (!bundle) return { ok: false, message: 'Project not found.' };
      const safeName = bundle.project.name.replace(/[^a-zA-Z0-9_-]+/g, '_').toLowerCase();

      if (format === 'final_wav') {
        const finalStem = bundle.audioStems.find((s) => s.stemType === 'final_mix');
        if (!finalStem) {
          return {
            ok: false,
            message: 'Final dubbed WAV master has not been rendered yet. Click Render Final Dub Mix first.',
          };
        }
        const entry = await getRecord<VaultEntry>(STORES.file_vault, finalStem.vaultKey);
        if (!entry) {
          return { ok: false, message: 'Rendered final WAV blob not found in exported_results vault.' };
        }
        triggerBrowserDownload(entry.blob, `${safeName}_hindi_dub_master.wav`);
        return {
          ok: true,
          message: `Exported real mixed Hindi WAV (${(entry.sizeBytes / 1024).toFixed(1)} KB).`,
        };
      }

      if (format === 'hindi_srt' || format === 'japanese_srt') {
        const lang = format === 'hindi_srt' ? 'hi' : 'ja';
        const srtText = buildSrtSubtitles(bundle.segments, lang);
        if (!srtText.trim()) {
          return {
            ok: false,
            message: `No ${lang === 'hi' ? 'Hindi' : 'Japanese'} dialogue segments available for SRT export.`,
          };
        }
        const blob = new Blob([srtText], { type: 'text/plain;charset=utf-8' });
        triggerBrowserDownload(blob, `${safeName}_${lang}.srt`);
        return {
          ok: true,
          message: `Exported ${lang === 'hi' ? 'Hindi' : 'Japanese'} SRT subtitle file.`,
        };
      }

      const reportJson = buildProductionReportJson(bundle, characters, voices);
      const blob = new Blob([reportJson], { type: 'application/json;charset=utf-8' });
      triggerBrowserDownload(blob, `${safeName}_production_report.json`);
      return {
        ok: true,
        message:
          'Exported complete JSON Production Package (timestamps, characters, voices, collaborative translation report, QA metrics, and editable snapshot).',
      };
    },
    [characters, voices]
  );

  const createDialogueSegment = useCallback(
    async (input: CreateDialogueSegmentInput): Promise<DialogueSegment> => {
      const now = new Date().toISOString();
      const startMs = Math.max(0, Math.round(input.originalStartMs));
      const endMs = Math.max(startMs + 100, Math.round(input.originalEndMs));
      const durationMs = endMs - startMs;
      const segmentId = `SEG-${Date.now().toString(36).toUpperCase()}`;

      const matchedChar = input.characterId
        ? characters.find((c) => c.characterId === input.characterId)
        : null;

      const segment: DialogueSegment = {
        segmentId,
        projectId: input.projectId,
        sourceSpeakerId: input.sourceSpeakerId.trim() || 'SPK_01',
        characterId: input.characterId,
        originalStartMs: startMs,
        originalEndMs: endMs,
        originalDurationMs: durationMs,
        japaneseText: input.japaneseText.trim(),
        hindiText: input.hindiText.trim(),
        emotion: {
          primaryEmotion: input.primaryEmotion || 'Neutral',
          intensity: input.emotionIntensity,
          deliveryNotes: '',
          source: 'manual',
        },
        assignedHindiVoiceId: matchedChar?.assignedHindiVoiceId ?? null,
        generatedAudioRef: null,
        actualGeneratedDurationMs: null,
        finalStartMs: startMs,
        finalEndMs: endMs,
        preferredShiftLimitMs: settings.preferredTimingAdjustmentMs,
        overlapGroupId: null,
        syncStatus: 'unmeasured',
        qaStatus: 'not_run',
        reviewStatus: input.hindiText.trim() ? 'unreviewed' : 'needs_review',
        updatedAt: now,
      };

      await putRecord(STORES.dialogue_segments, segment);

      const translationRecord: TranslationRecord = {
        id: `tr_${segmentId}`,
        projectId: input.projectId,
        segmentId,
        sourceLang: 'ja',
        targetLang: 'hi',
        sourceText: segment.japaneseText,
        translatedText: segment.hindiText,
        contextNotes: '',
        pronunciationOverrides: [],
        status: segment.hindiText ? 'draft' : 'needs_review',
        updatedAt: now,
      };
      await putRecord(STORES.translations, translationRecord);

      // Synchronize structural timeline clip on Dialogue Master track (hasRealAudio: false, waveformPeaks: null)
      const bundle = await loadProjectBundle(input.projectId);
      const dialogueTrack = bundle?.tracks.find((t) => t.kind === 'dialogue');
      if (dialogueTrack) {
        const clip: AudioClip = {
          clipId: `clip_${segmentId}`,
          projectId: input.projectId,
          trackId: dialogueTrack.trackId,
          segmentId,
          label: `${matchedChar?.displayName ?? segment.sourceSpeakerId}: ${
            segment.hindiText || segment.japaneseText || segmentId
          }`.slice(0, 48),
          startMs,
          endMs,
          durationMs,
          sourceNamespace: null,
          sourceRef: null,
          hasRealAudio: false,
          waveformPeaks: null,
        };
        await putRecord(STORES.audio_clips, clip);
      }

      await refreshAll(input.projectId);
      return segment;
    },
    [characters, refreshAll, settings.preferredTimingAdjustmentMs]
  );

  const updateDialogueSegment = useCallback(
    async (segment: DialogueSegment) => {
      const now = new Date().toISOString();
      const updated = { ...segment, updatedAt: now };
      await putRecord(STORES.dialogue_segments, updated);

      const translationRecord: TranslationRecord = {
        id: `tr_${segment.segmentId}`,
        projectId: segment.projectId,
        segmentId: segment.segmentId,
        sourceLang: 'ja',
        targetLang: 'hi',
        sourceText: segment.japaneseText,
        translatedText: segment.hindiText,
        contextNotes: '',
        pronunciationOverrides: [],
        status:
          segment.reviewStatus === 'approved'
            ? 'approved'
            : segment.hindiText.trim()
            ? 'draft'
            : 'needs_review',
        updatedAt: now,
      };
      await putRecord(STORES.translations, translationRecord);

      // Keep corresponding timeline clip timing aligned
      const existingClip = await getRecord<AudioClip>(
        STORES.audio_clips,
        `clip_${segment.segmentId}`
      );
      if (existingClip) {
        await putRecord<AudioClip>(STORES.audio_clips, {
          ...existingClip,
          startMs: segment.finalStartMs,
          endMs: segment.finalEndMs,
          durationMs: Math.max(100, segment.finalEndMs - segment.finalStartMs),
        });
      }

      await refreshAll(activeProjectId);
    },
    [activeProjectId, refreshAll]
  );

  const deleteDialogueSegment = useCallback(
    async (segmentId: string) => {
      await deleteRecord(STORES.dialogue_segments, segmentId);
      await deleteRecord(STORES.translations, `tr_${segmentId}`);
      await deleteRecord(STORES.audio_clips, `clip_${segmentId}`);
      await refreshAll(activeProjectId);
    },
    [activeProjectId, refreshAll]
  );

  const saveTimelineState = useCallback(
    async (projectId: string, tracks: TimelineTrack[], clips: AudioClip[]) => {
      await putManyRecords(STORES.timeline_tracks, tracks);
      await putManyRecords(STORES.audio_clips, clips);

      // Persist clip start/end updates back to linked dialogue segments
      for (const clip of clips) {
        if (clip.segmentId) {
          const seg = await getRecord<DialogueSegment>(
            STORES.dialogue_segments,
            clip.segmentId
          );
          if (seg) {
            const evalResult = evaluateTimingAdjustment(
              seg.originalStartMs,
              clip.startMs,
              seg.preferredShiftLimitMs
            );
            await putRecord<DialogueSegment>(STORES.dialogue_segments, {
              ...seg,
              finalStartMs: clip.startMs,
              finalEndMs: clip.endMs,
              syncStatus:
                clip.startMs === seg.originalStartMs
                  ? seg.generatedAudioRef
                    ? 'in_tolerance'
                    : 'unmeasured'
                  : evalResult.withinPreferredRange
                  ? 'manual_override'
                  : 'needs_adjustment',
              updatedAt: new Date().toISOString(),
            });
          }
        }
      }

      await refreshAll(projectId);
    },
    [refreshAll]
  );

  const addCharacterTrackToTimeline = useCallback(
    async (projectId: string, character: CharacterProfile) => {
      const bundle = await loadProjectBundle(projectId);
      if (!bundle) return;
      const alreadyExists = bundle.tracks.some(
        (t) => t.characterId === character.characterId
      );
      if (alreadyExists) return;

      const track: TimelineTrack = {
        trackId: `trk_${projectId}_chr_${character.characterId}`,
        projectId,
        name: `Character: ${character.displayName}`,
        kind: 'character',
        characterId: character.characterId,
        orderIndex: bundle.tracks.length,
        muted: false,
        solo: false,
        gainDb: 0,
        locked: false,
      };
      await putRecord(STORES.timeline_tracks, track);
      await refreshAll(projectId);
    },
    [refreshAll]
  );

  const runFoundationPipeline = useCallback(
    async (projectId: string, resumeFromCheckpoint: boolean) => {
      setIsPipelineRunning(true);
      try {
        await masterOrchestrator.runProjectPipeline(
          projectId,
          settings,
          { resumeFromLatestCheckpoint: resumeFromCheckpoint },
          {
            onPlanUpdated: (plan) => {
              setActivePlan({ ...plan, tasks: { ...plan.tasks } });
            },
          }
        );
      } finally {
        setIsPipelineRunning(false);
        await refreshAll(projectId);
      }
    },
    [refreshAll, settings]
  );

  const cancelActivePipeline = useCallback((projectId: string) => {
    masterOrchestrator.cancelProjectJob(projectId);
  }, []);

  const runStructuralQACheck = useCallback(
    async (projectId: string): Promise<QAReport> => {
      const report = await masterOrchestrator.runQualityAssuranceForProject(
        projectId,
        settings
      );
      await refreshAll(projectId);
      return report;
    },
    [refreshAll, settings]
  );

  const updateSettings = useCallback(
    async (partial: Partial<AppSettings>) => {
      const next: AppSettings = {
        ...settings,
        ...partial,
        id: 'app_settings',
        updatedAt: new Date().toISOString(),
      };
      await putRecord(STORES.app_settings, next);
      setSettings(next);
      await refreshResourcesInternal(next);
    },
    [refreshResourcesInternal, settings]
  );

  const purgeTemporaryStorage = useCallback(
    async (projectId?: string) => {
      const reclaimed = await clearTemporaryProcessingData(projectId);
      await refreshAll(activeProjectId);
      return reclaimed;
    },
    [activeProjectId, refreshAll]
  );

  return (
    <StudioContext.Provider
      value={{
        ready,
        loadError,
        activeScreen,
        setActiveScreen,
        projects,
        activeProjectId,
        setActiveProjectId,
        activeBundle,
        characters,
        voices,
        models,
        pronunciations,
        allJobs,
        settings,
        resources,
        activePlan,
        isPipelineRunning,
        modelDownloadProgress,
        playingVaultKey,
        geminiStatus,
        focusedClipId,
        setFocusedClipId,
        jumpToAudioStudioClip,
        refreshGeminiStatus,
        collaborateOnSegment,
        regenerateCharacterDialogues,
        mixProjectMasterAudio,
        exportProjectAsset,
        refreshAll,
        refreshResources,
        createProject,
        importMediaIntoProject,
        renameProject,
        deleteProject,
        createCharacter,
        updateCharacter,
        assignVoiceToCharacter,
        addCharacterRelationship,
        addPronunciationEntry,
        deletePronunciationEntry,
        createDialogueSegment,
        updateDialogueSegment,
        deleteDialogueSegment,
        synthesizeSingleSegment,
        downloadModel,
        removeModel,
        playVaultAudio,
        stopAudioPlayback,
        previewHindiVoice,
        saveTimelineState,
        addCharacterTrackToTimeline,
        runFoundationPipeline,
        cancelActivePipeline,
        runStructuralQACheck,
        updateSettings,
        purgeTemporaryStorage,
      }}
    >
      {children}
    </StudioContext.Provider>
  );
}

export function useStudio(): StudioContextValue {
  const ctx = useContext(StudioContext);
  if (!ctx) {
    throw new Error('useStudio must be used inside StudioProvider');
  }
  return ctx;
}
