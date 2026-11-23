import React, { useRef, useState } from 'react';
import { FileAudio, Upload } from 'lucide-react';
import type { LanguageCode, MediaCategory } from '../types/domain';
import { useStudio } from '../state/StudioContext';
import {
  KeyValueList,
  NoticeBanner,
  PageHeader,
  SectionTitle,
  Surface,
} from '../components/StudioPrimitives';
import {
  FILE_PICKER_ACCEPT,
  formatBytes,
  SUPPORTED_MEDIA_FORMATS,
  validateMediaFile,
} from '../core/storage/mediaInspector';
import { formatTimecode } from '../core/timeline/timelineEngine';

const MEDIA_CATEGORIES: Array<{ value: MediaCategory; label: string }> = [
  { value: 'anime_episode', label: 'Anime Episode' },
  { value: 'movie', label: 'Movie / Film' },
  { value: 'documentary', label: 'Documentary' },
  { value: 'educational', label: 'Educational Video' },
  { value: 'podcast', label: 'Podcast / Interview' },
  { value: 'gaming', label: 'Gaming Content' },
  { value: 'other_spoken', label: 'Other Spoken Media' },
];

const LANGUAGES: Array<{ code: LanguageCode; label: string }> = [
  { code: 'ja', label: 'Japanese (ja)' },
  { code: 'hi', label: 'Hindi (hi)' },
  { code: 'en', label: 'English (en)' },
  { code: 'ko', label: 'Korean (ko)' },
  { code: 'zh', label: 'Chinese (zh)' },
  { code: 'es', label: 'Spanish (es)' },
  { code: 'fr', label: 'French (fr)' },
];

export function MediaImportScreen() {
  const {
    projects,
    activeProjectId,
    activeBundle,
    settings,
    createProject,
    importMediaIntoProject,
    setActiveScreen,
  } = useStudio();

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [mode, setMode] = useState<'new_project' | 'attach_existing'>('new_project');
  const [targetProjectId, setTargetProjectId] = useState<string>(activeProjectId ?? '');
  const [projectName, setProjectName] = useState('');
  const [seriesTitle, setSeriesTitle] = useState('');
  const [episodeLabel, setEpisodeLabel] = useState('Episode 01');
  const [mediaCategory, setMediaCategory] = useState<MediaCategory>('anime_episode');
  const [sourceLanguage, setSourceLanguage] = useState<LanguageCode>(
    settings.defaultSourceLanguage
  );
  const [targetLanguage, setTargetLanguage] = useState<LanguageCode>(
    settings.defaultTargetLanguage
  );
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setValidationError(null);
    setStatusMessage(null);
    const file = e.target.files?.[0] ?? null;
    if (!file) {
      setSelectedFile(null);
      return;
    }

    const check = validateMediaFile(file.name, file.type, file.size);
    if (!check.valid) {
      setSelectedFile(null);
      setValidationError(check.errorMessage);
      return;
    }

    setSelectedFile(file);
    if (!projectName.trim()) {
      const base = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
      setProjectName(base);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError(null);
    setStatusMessage(null);

    if (mode === 'new_project') {
      if (!projectName.trim()) {
        setValidationError('Enter a project name before creating the local workspace.');
        return;
      }

      setSubmitting(true);
      try {
        const result = await createProject({
          name: projectName,
          seriesTitle: seriesTitle || projectName,
          episodeLabel,
          mediaCategory,
          sourceLanguage,
          targetLanguage,
          file: selectedFile,
        });
        if (result.warning) {
          setValidationError(result.warning);
        } else {
          setStatusMessage(
            selectedFile
              ? `Created "${result.project.name}" and preserved "${selectedFile.name}" locally in original_media storage.`
              : `Created "${result.project.name}". You can import an audio or video file into this project at any time.`
          );
          setProjectName('');
          setSeriesTitle('');
          setSelectedFile(null);
          if (fileInputRef.current) fileInputRef.current.value = '';
        }
      } catch (err) {
        setValidationError(err instanceof Error ? err.message : 'Failed to create project.');
      } finally {
        setSubmitting(false);
      }
    } else {
      const chosenId = targetProjectId || activeProjectId;
      if (!chosenId) {
        setValidationError('Select an existing project to attach media.');
        return;
      }
      if (!selectedFile) {
        setValidationError('Choose a supported video or audio file first.');
        return;
      }

      setSubmitting(true);
      try {
        const res = await importMediaIntoProject(chosenId, selectedFile);
        if (!res.ok) {
          setValidationError(res.error ?? 'Import failed.');
        } else {
          setStatusMessage(
            `Preserved "${selectedFile.name}" locally and extracted available container metadata.`
          );
          setSelectedFile(null);
          if (fileInputRef.current) fileInputRef.current.value = '';
        }
      } finally {
        setSubmitting(false);
      }
    }
  };

  const activeMedia = activeBundle?.media ?? null;
  const activeMeta = activeBundle?.metadata ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Media Import"
        subtitle="Create a local project workspace, validate supported containers, preserve original media untouched, and prepare overlapping chunk schedules."
        action={
          activeBundle ? (
            <button
              type="button"
              onClick={() => setActiveScreen('analysis')}
              className="min-h-[40px] px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-800 whitespace-nowrap shrink-0"
            >
              Open Media Analysis
            </button>
          ) : null
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <Surface className="lg:col-span-7">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg mb-5 w-fit">
            <button
              type="button"
              onClick={() => {
                setMode('new_project');
                setValidationError(null);
              }}
              className={`min-h-[36px] px-3.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                mode === 'new_project'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Create New Project
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('attach_existing');
                setValidationError(null);
              }}
              className={`min-h-[36px] px-3.5 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                mode === 'attach_existing'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Import Into Existing Project
            </button>
          </div>

          <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
            {mode === 'new_project' ? (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="sm:col-span-2">
                    <label
                      htmlFor="import-project-name"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      Project Name
                    </label>
                    <input
                      id="import-project-name"
                      type="text"
                      value={projectName}
                      onChange={(e) => setProjectName(e.target.value)}
                      placeholder="e.g. Horizon Chronicles — Ep 01"
                      className="w-full h-11 px-3.5 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 focus:border-blue-600"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="import-series-title"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      Series / Show Scope (Character Memory)
                    </label>
                    <input
                      id="import-series-title"
                      type="text"
                      value={seriesTitle}
                      onChange={(e) => setSeriesTitle(e.target.value)}
                      placeholder="e.g. Horizon Chronicles"
                      className="w-full h-11 px-3.5 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 focus:border-blue-600"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="import-episode-label"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      Episode / Part Label
                    </label>
                    <input
                      id="import-episode-label"
                      type="text"
                      value={episodeLabel}
                      onChange={(e) => setEpisodeLabel(e.target.value)}
                      placeholder="Episode 01"
                      className="w-full h-11 px-3.5 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 focus:border-blue-600"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="import-media-category"
                      className="block text-xs font-medium text-slate-700 mb-1"
                    >
                      Media Category
                    </label>
                    <select
                      id="import-media-category"
                      value={mediaCategory}
                      onChange={(e) => setMediaCategory(e.target.value as MediaCategory)}
                      className="w-full h-11 px-3 rounded-lg border border-slate-300 bg-white text-sm text-slate-900"
                    >
                      {MEDIA_CATEGORIES.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label
                        htmlFor="import-source-lang"
                        className="block text-xs font-medium text-slate-700 mb-1"
                      >
                        Source
                      </label>
                      <select
                        id="import-source-lang"
                        value={sourceLanguage}
                        onChange={(e) => setSourceLanguage(e.target.value as LanguageCode)}
                        className="w-full h-11 px-2.5 rounded-lg border border-slate-300 bg-white text-sm text-slate-900"
                      >
                        {LANGUAGES.map((l) => (
                          <option key={l.code} value={l.code}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label
                        htmlFor="import-target-lang"
                        className="block text-xs font-medium text-slate-700 mb-1"
                      >
                        Target
                      </label>
                      <select
                        id="import-target-lang"
                        value={targetLanguage}
                        onChange={(e) => setTargetLanguage(e.target.value as LanguageCode)}
                        className="w-full h-11 px-2.5 rounded-lg border border-slate-300 bg-white text-sm text-slate-900"
                      >
                        {LANGUAGES.map((l) => (
                          <option key={l.code} value={l.code}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div>
                <label
                  htmlFor="attach-project-select"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Target Local Project
                </label>
                <select
                  id="attach-project-select"
                  value={targetProjectId || activeProjectId || ''}
                  onChange={(e) => setTargetProjectId(e.target.value)}
                  className="w-full h-11 px-3 rounded-lg border border-slate-300 bg-white text-sm text-slate-900"
                >
                  {projects.length === 0 ? (
                    <option value="">No existing projects</option>
                  ) : (
                    projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))
                  )}
                </select>
              </div>
            )}

            {/* Local File Picker */}
            <div>
              <label
                htmlFor="media-file-input"
                className="block text-xs font-medium text-slate-700 mb-1.5"
              >
                Local Video or Audio File {mode === 'new_project' ? '(Optional on creation)' : '(Required)'}
              </label>
              <div className="border border-dashed border-slate-300 rounded-xl p-5 bg-slate-50/70">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <FileAudio className="w-5 h-5 text-slate-500 mt-0.5 shrink-0" aria-hidden="true" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 truncate">
                        {selectedFile ? selectedFile.name : 'Select media from device storage'}
                      </p>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {selectedFile
                          ? `${formatBytes(selectedFile.size)} · ${selectedFile.type || 'container detected by extension'}`
                          : 'Preserved untouched in local original_media storage. Never uploaded.'}
                      </p>
                    </div>
                  </div>
                  <label
                    htmlFor="media-file-input"
                    className="min-h-[40px] px-3.5 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-800 inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Upload className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>Choose File</span>
                  </label>
                  <input
                    ref={fileInputRef}
                    id="media-file-input"
                    type="file"
                    accept={FILE_PICKER_ACCEPT}
                    onChange={handleFileChange}
                    className="sr-only"
                  />
                </div>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Supported containers:{' '}
                {SUPPORTED_MEDIA_FORMATS.map((f) => f.extension.toUpperCase()).join(' · ')}
              </p>
            </div>

            {validationError ? (
              <NoticeBanner
                tone="error"
                title="Validation Error"
                description={validationError}
              />
            ) : null}

            {statusMessage ? (
              <NoticeBanner
                tone="success"
                title="Local Workspace Updated"
                description={statusMessage}
              />
            ) : null}

            <div className="pt-2 flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={submitting}
                className="min-h-[44px] px-5 py-2.5 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-50 text-white text-sm font-medium transition-colors whitespace-nowrap"
              >
                {submitting
                  ? 'Saving Locally…'
                  : mode === 'new_project'
                  ? 'Create Local Project'
                  : 'Import Media File'}
              </button>
              <span className="text-xs text-slate-500 tabular-nums">
                Chunk plan: {settings.chunkDurationSec}s window · {settings.chunkOverlapSec}s overlap
              </span>
            </div>
          </form>
        </Surface>

        {/* Active Project Imported Media Summary */}
        <Surface className="lg:col-span-5">
          <SectionTitle
            title="Active Project Media Metadata"
            meta={activeBundle ? activeBundle.project.name : 'No active project selected'}
          />

          {activeMedia && activeMeta ? (
            <div className="space-y-4">
              <KeyValueList
                items={[
                  { label: 'File Name', value: activeMedia.fileName },
                  { label: 'Storage Namespace', value: activeMedia.storageNamespace, mono: true },
                  { label: 'Original Preserved', value: activeMedia.preservedOriginal ? 'Yes (Immutable Copy)' : 'No' },
                  { label: 'File Size', value: formatBytes(activeMedia.sizeBytes), mono: true },
                  { label: 'Container Format', value: activeMeta.containerFormat },
                  { label: 'Duration', value: formatTimecode(activeMeta.durationMs), mono: true },
                  {
                    label: 'Resolution',
                    value:
                      activeMeta.widthPx && activeMeta.heightPx
                        ? `${activeMeta.widthPx} × ${activeMeta.heightPx}`
                        : 'Unavailable / Audio-only',
                    mono: true,
                  },
                  {
                    label: 'Frame Rate',
                    value: activeMeta.frameRateFps
                      ? `${activeMeta.frameRateFps} fps`
                      : 'Requires container demuxer',
                    mono: true,
                  },
                  {
                    label: 'Sample Rate / Channels',
                    value:
                      activeMeta.sampleRateHz && activeMeta.channels
                        ? `${activeMeta.sampleRateHz} Hz · ${activeMeta.channels} ch`
                        : 'Unavailable in browser header probe',
                    mono: true,
                  },
                  {
                    label: 'Planned Chunks',
                    value: `${activeMedia.chunkPlan.length} chunks (${Math.round(
                      activeMedia.chunkDurationMs / 1000
                    )}s / ${Math.round(activeMedia.chunkOverlapMs / 1000)}s overlap)`,
                    mono: true,
                  },
                ]}
              />
              <p className="text-xs text-slate-500 leading-relaxed pt-2 border-t border-slate-100">
                Decoder note: {activeMeta.decoderNotes}
              </p>
            </div>
          ) : (
            <p className="text-xs text-slate-500 leading-relaxed">
              No media file has been imported into the active project yet. Select a supported MP4, WebM, MKV, MOV, WAV, MP3, M4A, FLAC, or OGG file to inspect real container metadata and build an overlapping chunk plan.
            </p>
          )}
        </Surface>
      </div>
    </div>
  );
}
