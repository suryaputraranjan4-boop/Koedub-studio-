import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Layers,
  Merge,
  Play,
  Redo2,
  RefreshCw,
  Save,
  Scissors,
  Sliders,
  Square,
  Undo2,
  Upload,
  Volume2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useStudio } from '../state/StudioContext';
import {
  clampPlayhead,
  clampZoom,
  computeSilenceIntervals,
  createInitialTimelineHistory,
  evaluateTimingAdjustment,
  findOverlappingClips,
  formatTimecode,
  isTrackAudible,
  mergeAdjacentClips,
  nudgeClipTiming,
  redoTimeline,
  splitClipAtPlayhead,
  toggleTrackMute,
  toggleTrackSolo,
  trimClipTiming,
  undoTimeline,
  updateClipAudioParams,
  updateTrackGainDb,
  type TimelineHistoryState,
} from '../core/timeline/timelineEngine';
import {
  EmptyState,
  NoticeBanner,
  PageHeader,
  SectionTitle,
  StatusText,
  Surface,
} from '../components/StudioPrimitives';

function RealWaveformSvg({
  peaks,
  selected,
  accent,
}: {
  peaks: number[];
  selected: boolean;
  accent: 'original' | 'music' | 'dialogue';
}) {
  if (!peaks || peaks.length === 0) return null;
  const width = 200;
  const height = 28;
  const barW = Math.max(1, width / peaks.length);
  const fill = selected
    ? 'rgba(255,255,255,0.85)'
    : accent === 'music'
    ? 'rgba(16,185,129,0.75)'
    : accent === 'original'
    ? 'rgba(148,163,184,0.8)'
    : 'rgba(96,165,250,0.85)';

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="w-full h-7 block"
      aria-hidden="true"
      data-testid="real-waveform-svg"
    >
      {peaks.map((amp, i) => {
        const clamped = Math.max(0.04, Math.min(1, amp));
        const barH = Math.max(2, clamped * (height - 2));
        const y = (height - barH) / 2;
        return (
          <rect
            key={i}
            x={i * barW}
            y={y}
            width={Math.max(0.8, barW - 0.5)}
            height={barH}
            fill={fill}
            rx={0.5}
          />
        );
      })}
    </svg>
  );
}

export function AudioStudioScreen() {
  const {
    activeBundle,
    characters,
    saveTimelineState,
    setActiveScreen,
    playingVaultKey,
    playVaultAudio,
    stopAudioPlayback,
    focusedClipId,
    setFocusedClipId,
    mixProjectMasterAudio,
    exportProjectAsset,
    regenerateCharacterDialogues,
    importExternalMeStem,
  } = useStudio();

  const [history, setHistory] = useState<TimelineHistoryState>(() =>
    createInitialTimelineHistory([], [])
  );
  const [characterFilterId, setCharacterFilterId] = useState<string>('all');
  const [abMode, setAbMode] = useState<'original' | 'final'>('final');
  const [mixBusy, setMixBusy] = useState(false);
  const [regenBusy, setRegenBusy] = useState(false);
  const [actionNotice, setActionNotice] = useState<{
    tone: 'success' | 'error' | 'info';
    title: string;
    description: string;
  } | null>(null);

  const projectId = activeBundle?.project.id ?? null;
  const clipSignature = activeBundle
    ? `${activeBundle.tracks.length}:${activeBundle.clips.length}:${activeBundle.audioStems.length}:${activeBundle.clips
        .map((c) => `${c.clipId}:${c.waveformPeaks?.length ?? 0}`)
        .join(',')}`
    : '';

  useEffect(() => {
    if (activeBundle) {
      setHistory(createInitialTimelineHistory(activeBundle.tracks, activeBundle.clips));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, clipSignature]);

  // Honor 1-click jump from Quality Assurance screen
  useEffect(() => {
    if (!focusedClipId || !activeBundle) return;
    const match = activeBundle.clips.find((c) => c.clipId === focusedClipId);
    if (match) {
      setHistory((prev) => ({
        ...prev,
        present: {
          ...prev.present,
          selectedClipId: match.clipId,
          playheadMs: match.startMs,
        },
      }));
      setActionNotice({
        tone: 'info',
        title: 'Focused QA Clip',
        description: `Jumped directly to ${match.label} at ${formatTimecode(match.startMs)}.`,
      });
      setFocusedClipId(null);
    }
  }, [focusedClipId, activeBundle, setFocusedClipId]);

  const { tracks, clips, selectedClipId, playheadMs, zoomPxPerSec } = history.present;

  const visibleTracks = useMemo(() => {
    if (characterFilterId === 'all') return tracks;
    return tracks.filter(
      (t) =>
        t.kind === 'original' ||
        t.kind === 'music_sfx' ||
        t.kind === 'dialogue' ||
        t.characterId === characterFilterId
    );
  }, [tracks, characterFilterId]);

  if (!activeBundle) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Audio Studio"
          subtitle="Full multitrack audio production workstation with real PCM waveforms, clip trim/split/merge, fade & gain controls, conservative stem playback, master mixing, and export."
        />
        <EmptyState
          title="No active project loaded"
          description="Create or select a project to inspect waveforms, edit multitrack dialogue timing, mix the Hindi master, and export WAV/SRT deliverables."
          actionLabel="Open Projects"
          onAction={() => setActiveScreen('projects')}
        />
      </div>
    );
  }

  const maxClipEndMs = clips.reduce((max, c) => Math.max(max, c.endMs), 0);
  const totalDurationMs = Math.max(
    activeBundle.metadata?.durationMs ?? 0,
    maxClipEndMs + 2000,
    10000
  );
  const totalSeconds = Math.ceil(totalDurationMs / 1000);
  const timelineWidthPx = Math.max(680, Math.round(totalSeconds * zoomPxPerSec));

  const selectedClip = clips.find((c) => c.clipId === selectedClipId) ?? null;
  const linkedSegment = selectedClip?.segmentId
    ? activeBundle.segments.find((s) => s.segmentId === selectedClip.segmentId) ?? null
    : null;

  const originalVaultKey = activeBundle.media?.vaultKey ?? null;
  const externalMeStem = activeBundle.audioStems.find((s) => s.stemType === 'external_me_stem') ?? null;
  const backgroundStem =
    externalMeStem ??
    activeBundle.audioStems.find((s) => s.stemType === 'background_stem') ??
    null;
  const finalMixStem = activeBundle.audioStems.find((s) => s.stemType === 'final_mix') ?? null;

  const dialogueTrack = tracks.find((t) => t.kind === 'dialogue');
  const dialogueClips = dialogueTrack
    ? clips.filter((c) => c.trackId === dialogueTrack.trackId)
    : [];
  const silenceIntervals = computeSilenceIntervals(dialogueClips, totalDurationMs);
  const overlaps = findOverlappingClips(dialogueClips);

  const canSplitSelected =
    selectedClip !== null &&
    playheadMs > selectedClip.startMs + 150 &&
    playheadMs < selectedClip.endMs - 150;

  const hasAdjacentMergeTarget = useMemo(() => {
    if (!selectedClip) return false;
    const sameTrack = clips
      .filter((c) => c.trackId === selectedClip.trackId)
      .sort((a, b) => a.startMs - b.startMs);
    const idx = sameTrack.findIndex((c) => c.clipId === selectedClip.clipId);
    return idx >= 0 && idx + 1 < sameTrack.length;
  }, [clips, selectedClip]);

  const handleSave = async () => {
    await saveTimelineState(activeBundle.project.id, tracks, clips);
    setHistory((prev) => ({ ...prev, dirty: false }));
    setActionNotice({
      tone: 'success',
      title: 'Project Timeline Saved',
      description: 'Track gain, mute/solo states, fades, and clip timestamps persisted to IndexedDB.',
    });
  };

  const handleMixMaster = async () => {
    setMixBusy(true);
    setActionNotice(null);
    try {
      if (history.dirty) {
        await saveTimelineState(activeBundle.project.id, tracks, clips);
        setHistory((prev) => ({ ...prev, dirty: false }));
      }
      const res = await mixProjectMasterAudio(activeBundle.project.id);
      setActionNotice({
        tone: res.ok ? 'success' : 'error',
        title: res.ok ? 'Final Dub Master Rendered' : 'Audio Mix Failed',
        description: res.message,
      });
    } finally {
      setMixBusy(false);
    }
  };

  const handleTogglePlayKey = async (vaultKey: string | null, label: string) => {
    if (!vaultKey) {
      setActionNotice({
        tone: 'info',
        title: `${label} Not Rendered Yet`,
        description:
          label === 'Final Dub Master'
            ? 'Click "Render Final Dub Mix" to mix the background stem with synchronized Hindi dialogue first.'
            : `Run the pipeline in Processing Center to generate ${label}.`,
      });
      return;
    }
    if (playingVaultKey === vaultKey) {
      stopAudioPlayback();
      return;
    }
    const res = await playVaultAudio(vaultKey);
    if (!res.ok && res.error) {
      setActionNotice({
        tone: 'error',
        title: 'Playback Error',
        description: res.error,
      });
    }
  };

  const handleAbSwitch = async (nextMode: 'original' | 'final') => {
    setAbMode(nextMode);
    const key = nextMode === 'original' ? originalVaultKey : finalMixStem?.vaultKey ?? null;
    if (key) {
      await handleTogglePlayKey(key, nextMode === 'original' ? 'Original Audio' : 'Final Dub Master');
    }
  };

  const handleExport = async (
    format: 'final_wav' | 'hindi_srt' | 'japanese_srt' | 'production_json'
  ) => {
    const res = await exportProjectAsset(activeBundle.project.id, format);
    setActionNotice({
      tone: res.ok ? 'success' : 'error',
      title: res.ok ? 'Export Ready' : 'Export Unavailable',
      description: res.message,
    });
  };

  const handleImportCleanMe = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const res = await importExternalMeStem(activeBundle.project.id, file);
    setActionNotice({
      tone: res.ok ? 'success' : 'error',
      title: res.ok ? 'Clean M&E Stem Imported' : 'M&E Stem Import Failed',
      description: res.message,
    });
  };

  const handleRegenerateCharacter = async () => {
    if (characterFilterId === 'all') return;
    setRegenBusy(true);
    setActionNotice(null);
    try {
      const res = await regenerateCharacterDialogues(characterFilterId);
      setActionNotice({
        tone: res.ok ? 'success' : 'error',
        title: res.ok ? 'Character Dialogues Regenerated' : 'Regeneration Skipped',
        description: res.message,
      });
    } finally {
      setRegenBusy(false);
    }
  };

  const rulerStepSec = zoomPxPerSec >= 80 ? 1 : zoomPxPerSec >= 35 ? 2 : 5;
  const rulerTicks: number[] = [];
  for (let s = 0; s <= totalSeconds; s += rulerStepSec) {
    rulerTicks.push(s);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audio Studio"
        subtitle={`Project: ${activeBundle.project.name} · Multitrack PCM waveform editor, conservative stem preservation, ducked master mixer, and WAV/SRT/JSON export.`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={history.past.length === 0}
              onClick={() => setHistory((h) => undoTimeline(h))}
              aria-label="Undo timeline edit"
              className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40 text-xs font-medium text-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <Undo2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Undo ({history.past.length})</span>
            </button>

            <button
              type="button"
              disabled={history.future.length === 0}
              onClick={() => setHistory((h) => redoTimeline(h))}
              aria-label="Redo timeline edit"
              className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40 text-xs font-medium text-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <Redo2 className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Redo ({history.future.length})</span>
            </button>

            <button
              type="button"
              onClick={() => void handleSave()}
              className="min-h-[38px] px-3.5 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-900 text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <Save className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{history.dirty ? 'Save Timeline*' : 'Saved'}</span>
            </button>

            <button
              type="button"
              disabled={mixBusy}
              onClick={() => void handleMixMaster()}
              className="min-h-[38px] px-4 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-50 text-white text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <Layers className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{mixBusy ? 'Rendering Mix…' : 'Render Final Dub Mix'}</span>
            </button>
          </div>
        }
      />

      {actionNotice ? (
        <NoticeBanner
          tone={actionNotice.tone}
          title={actionNotice.title}
          description={actionNotice.description}
        />
      ) : null}

      {/* A/B Stem Monitoring, Playhead, Character Filter & Zoom Bar */}
      <Surface className="!p-4 space-y-4">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleTogglePlayKey(originalVaultKey, 'Original Audio')}
              disabled={!originalVaultKey}
              className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 border transition-colors ${
                playingVaultKey && playingVaultKey === originalVaultKey
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-800 border-slate-300 hover:bg-slate-50 disabled:opacity-40'
              }`}
            >
              {playingVaultKey && playingVaultKey === originalVaultKey ? (
                <Square className="w-3.5 h-3.5" aria-hidden="true" />
              ) : (
                <Play className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>Original Audio</span>
            </button>

            <button
              type="button"
              onClick={() =>
                void handleTogglePlayKey(backgroundStem?.vaultKey ?? null, 'Background / M&E Stem')
              }
              disabled={!backgroundStem}
              className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 border transition-colors ${
                playingVaultKey && playingVaultKey === backgroundStem?.vaultKey
                  ? 'bg-emerald-700 text-white border-emerald-700'
                  : 'bg-white text-slate-800 border-slate-300 hover:bg-slate-50 disabled:opacity-40'
              }`}
            >
              {playingVaultKey && playingVaultKey === backgroundStem?.vaultKey ? (
                <Square className="w-3.5 h-3.5" aria-hidden="true" />
              ) : (
                <Play className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>
                {externalMeStem
                  ? `Clean M&E (${Math.round(externalMeStem.sampleRate / 100) / 10} kHz ${
                      (externalMeStem.channels ?? 2) >= 2 ? 'Stereo' : 'Mono'
                    })`
                  : backgroundStem
                  ? `Background M&E (${Math.round(backgroundStem.sampleRate / 100) / 10} kHz ${
                      (backgroundStem.channels ?? 2) >= 2 ? 'Stereo' : 'Mono'
                    })`
                  : 'Background M&E Stem'}
              </span>
            </button>

            <label className="min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 cursor-pointer whitespace-nowrap">
              <Upload className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{externalMeStem ? 'Replace Clean M&E' : 'Import Clean M&E'}</span>
              <input
                type="file"
                accept=".wav,.mp3,.m4a,.ogg,.flac,audio/*"
                onChange={(e) => void handleImportCleanMe(e)}
                className="sr-only"
              />
            </label>

            <button
              type="button"
              onClick={() =>
                void handleTogglePlayKey(finalMixStem?.vaultKey ?? null, 'Final Dub Master')
              }
              disabled={!finalMixStem}
              className={`min-h-[36px] px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 border transition-colors ${
                playingVaultKey && playingVaultKey === finalMixStem?.vaultKey
                  ? 'bg-blue-700 text-white border-blue-700'
                  : 'bg-white text-slate-800 border-slate-300 hover:bg-slate-50 disabled:opacity-40'
              }`}
            >
              {playingVaultKey && playingVaultKey === finalMixStem?.vaultKey ? (
                <Square className="w-3.5 h-3.5" aria-hidden="true" />
              ) : (
                <Volume2 className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>
                {finalMixStem
                  ? `Final Dub Master (${Math.round(finalMixStem.sampleRate / 100) / 10} kHz ${
                      (finalMixStem.channels ?? 2) >= 2 ? 'Stereo' : 'Mono'
                    })`
                  : 'Final Dub Master'}
              </span>
            </button>

            <div
              role="group"
              aria-label="A/B comparison toggle"
              className="inline-flex items-center rounded-lg border border-slate-300 bg-slate-50 p-0.5 text-xs"
            >
              <button
                type="button"
                onClick={() => void handleAbSwitch('original')}
                className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                  abMode === 'original'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                A: Original
              </button>
              <button
                type="button"
                onClick={() => void handleAbSwitch('final')}
                className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                  abMode === 'final'
                    ? 'bg-white text-blue-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                B: Hindi Dub
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <label htmlFor="audio-char-filter" className="text-xs text-slate-500">
                Character Track:
              </label>
              <select
                id="audio-char-filter"
                value={characterFilterId}
                onChange={(e) => setCharacterFilterId(e.target.value)}
                className="h-9 px-2.5 rounded-lg border border-slate-300 bg-white text-xs text-slate-800"
              >
                <option value="all">All Tracks ({tracks.length})</option>
                {characters.map((c) => (
                  <option key={c.characterId} value={c.characterId}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </div>

            {characterFilterId !== 'all' ? (
              <button
                type="button"
                disabled={regenBusy}
                onClick={() => void handleRegenerateCharacter()}
                className="min-h-[36px] px-3 py-1.5 rounded-lg border border-blue-200 bg-blue-50 hover:bg-blue-100 text-blue-800 text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{regenBusy ? 'Regenerating…' : 'Regenerate Character Dialogues'}</span>
              </button>
            ) : null}
          </div>
        </div>

        <div className="pt-3 border-t border-slate-100 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-4">
            <div>
              <p className="text-[11px] font-medium text-slate-500">Playhead Position</p>
              <p className="text-lg font-semibold font-mono tabular-nums text-slate-900">
                {formatTimecode(playheadMs)}
              </p>
            </div>

            <div className="flex items-center gap-2 min-w-[200px] sm:min-w-[280px]">
              <label htmlFor="timeline-playhead-slider" className="sr-only">
                Scrub timeline playhead
              </label>
              <input
                id="timeline-playhead-slider"
                type="range"
                min={0}
                max={totalDurationMs}
                step={50}
                value={playheadMs}
                onChange={(e) =>
                  setHistory((prev) => ({
                    ...prev,
                    present: {
                      ...prev.present,
                      playheadMs: clampPlayhead(Number(e.target.value), totalDurationMs),
                    },
                  }))
                }
                className="w-full"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-500 font-mono tabular-nums mr-1">
              Zoom: {zoomPxPerSec} px/s
            </span>
            <button
              type="button"
              aria-label="Zoom out timeline"
              onClick={() =>
                setHistory((prev) => ({
                  ...prev,
                  present: {
                    ...prev.present,
                    zoomPxPerSec: clampZoom(prev.present.zoomPxPerSec - 16),
                  },
                }))
              }
              className="min-h-[36px] min-w-[36px] rounded-lg border border-slate-200 hover:bg-slate-50 flex items-center justify-center text-slate-700"
            >
              <ZoomOut className="w-4 h-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Zoom in timeline"
              onClick={() =>
                setHistory((prev) => ({
                  ...prev,
                  present: {
                    ...prev.present,
                    zoomPxPerSec: clampZoom(prev.present.zoomPxPerSec + 16),
                  },
                }))
              }
              className="min-h-[36px] min-w-[36px] rounded-lg border border-slate-200 hover:bg-slate-50 flex items-center justify-center text-slate-700"
            >
              <ZoomIn className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </div>
      </Surface>

      {/* Multitrack Timeline Workspace */}
      <Surface className="!p-0 overflow-hidden">
        <div className="flex flex-col lg:flex-row">
          {/* Track Headers Column */}
          <div className="lg:w-72 shrink-0 border-b lg:border-b-0 lg:border-r border-slate-200 bg-slate-50">
            <div className="h-9 px-4 border-b border-slate-200 flex items-center justify-between text-[11px] font-medium text-slate-500">
              <span>Tracks ({visibleTracks.length})</span>
              <span>Gain · M / S</span>
            </div>
            {activeBundle.soundEvents.length > 0 ? (
              <div className="h-8 px-4 border-b border-slate-200 flex items-center justify-between text-[11px] text-slate-600 bg-slate-100/70">
                <span className="font-medium">Sound Preservation Map</span>
                <span className="font-mono tabular-nums">
                  {activeBundle.soundEvents.filter((e) => e.preserveOriginal).length} protected
                </span>
              </div>
            ) : null}
            <div className="divide-y divide-slate-200">
              {visibleTracks.map((track) => {
                const audible = isTrackAudible(track, tracks);
                return (
                  <div
                    key={track.trackId}
                    className="h-24 px-4 py-2.5 flex flex-col justify-between"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-900 truncate">
                        {track.name}
                      </span>
                      <span className="text-[11px] font-mono text-slate-500 shrink-0 tabular-nums">
                        {track.gainDb >= 0 ? `+${track.gainDb}` : track.gainDb} dB ·{' '}
                        {audible ? 'Active' : 'Muted'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 flex-1 min-w-0">
                        <label
                          htmlFor={`track-gain-${track.trackId}`}
                          className="sr-only"
                        >
                          Gain dB for {track.name}
                        </label>
                        <input
                          id={`track-gain-${track.trackId}`}
                          type="range"
                          min={-12}
                          max={6}
                          step={0.5}
                          value={track.gainDb}
                          onChange={(e) =>
                            setHistory((h) =>
                              updateTrackGainDb(h, track.trackId, Number(e.target.value))
                            )
                          }
                          className="w-24"
                        />
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          aria-label={`Mute ${track.name}`}
                          aria-pressed={track.muted}
                          onClick={() => setHistory((h) => toggleTrackMute(h, track.trackId))}
                          className={`min-h-[34px] min-w-[34px] rounded-md text-xs font-mono font-semibold border transition-colors ${
                            track.muted
                              ? 'bg-red-700 text-white border-red-700'
                              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                          }`}
                        >
                          M
                        </button>
                        <button
                          type="button"
                          aria-label={`Solo ${track.name}`}
                          aria-pressed={track.solo}
                          onClick={() => setHistory((h) => toggleTrackSolo(h, track.trackId))}
                          className={`min-h-[34px] min-w-[34px] rounded-md text-xs font-mono font-semibold border transition-colors ${
                            track.solo
                              ? 'bg-amber-600 text-white border-amber-600'
                              : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
                          }`}
                        >
                          S
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Scrollable Ruler + Sound Preservation Strip + Track Lanes */}
          <div className="flex-1 overflow-x-auto bg-[#0F172A] text-slate-200 relative">
            <div style={{ width: `${timelineWidthPx}px` }} className="relative">
              {/* Time Ruler */}
              <div className="h-9 border-b border-slate-700 bg-slate-900 relative select-none">
                {rulerTicks.map((sec) => {
                  const leftPx = Math.round(sec * zoomPxPerSec);
                  return (
                    <div
                      key={sec}
                      style={{ left: `${leftPx}px` }}
                      className="absolute top-0 bottom-0 border-l border-slate-700 pl-1.5 flex items-center text-[10px] font-mono tabular-nums text-slate-400"
                    >
                      {formatTimecode(sec * 1000).slice(0, 5)}
                    </div>
                  );
                })}
              </div>

              {/* Sound Preservation Markers Strip (Agent #21) */}
              {activeBundle.soundEvents.length > 0 ? (
                <div className="h-8 border-b border-slate-800 bg-slate-950/90 relative">
                  {activeBundle.soundEvents.map((ev) => {
                    const leftPx = Math.round((ev.startMs / 1000) * zoomPxPerSec);
                    const widthPx = Math.max(
                      18,
                      Math.round(((ev.endMs - ev.startMs) / 1000) * zoomPxPerSec)
                    );
                    return (
                      <div
                        key={ev.id}
                        title={`${ev.label} (${formatTimecode(ev.startMs)}–${formatTimecode(ev.endMs)}, ${Math.round(
                          ev.confidence * 100
                        )}% conf)`}
                        style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                        className={`absolute top-1 bottom-1 rounded-xs px-1.5 flex items-center text-[10px] font-mono truncate border ${
                          ev.category === 'song'
                            ? 'bg-emerald-900/80 border-emerald-500/70 text-emerald-200'
                            : ev.preserveOriginal
                            ? 'bg-amber-900/70 border-amber-500/60 text-amber-200'
                            : 'bg-slate-800/80 border-slate-600 text-slate-300'
                        }`}
                      >
                        {ev.category}
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {/* Vertical Playhead Line */}
              <div
                aria-hidden="true"
                style={{ left: `${Math.round((playheadMs / 1000) * zoomPxPerSec)}px` }}
                className="absolute top-0 bottom-0 w-px bg-blue-400 z-20 pointer-events-none"
              />

              {/* Track Lanes */}
              <div className="divide-y divide-slate-800">
                {visibleTracks.map((track) => {
                  const trackClips = clips.filter((c) => c.trackId === track.trackId);
                  const audible = isTrackAudible(track, tracks);
                  const accent =
                    track.kind === 'original'
                      ? 'original'
                      : track.kind === 'music_sfx'
                      ? 'music'
                      : 'dialogue';

                  return (
                    <div
                      key={track.trackId}
                      className={`h-24 relative ${audible ? 'opacity-100' : 'opacity-45'}`}
                    >
                      {trackClips.length === 0 ? (
                        <div className="h-full flex items-center px-4 text-xs text-slate-500">
                          Empty timeline lane — silence remains empty intervals (never silent dummy audio)
                        </div>
                      ) : (
                        trackClips.map((clip) => {
                          const leftPx = Math.round((clip.startMs / 1000) * zoomPxPerSec);
                          const widthPx = Math.max(
                            56,
                            Math.round((clip.durationMs / 1000) * zoomPxPerSec)
                          );
                          const isSelected = clip.clipId === selectedClipId;
                          const hasRealPeaks =
                            Array.isArray(clip.waveformPeaks) && clip.waveformPeaks.length > 0;

                          return (
                            <button
                              key={clip.clipId}
                              type="button"
                              onClick={() =>
                                setHistory((prev) => ({
                                  ...prev,
                                  present: {
                                    ...prev.present,
                                    selectedClipId: clip.clipId,
                                    playheadMs: clip.startMs,
                                  },
                                }))
                              }
                              style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
                              className={`absolute top-2 bottom-2 rounded-md px-2.5 py-1.5 text-left border transition-colors overflow-hidden flex flex-col justify-between ${
                                isSelected
                                  ? 'bg-blue-700 border-blue-300 text-white z-10'
                                  : track.kind === 'music_sfx'
                                  ? 'bg-emerald-950/90 border-emerald-700/80 text-emerald-100 hover:border-emerald-400'
                                  : track.kind === 'original'
                                  ? 'bg-slate-800 border-slate-600 text-slate-200 hover:border-slate-400'
                                  : 'bg-slate-800/95 border-slate-600 text-slate-100 hover:border-blue-400'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2 w-full">
                                <span className="text-[11px] font-medium truncate block">
                                  {clip.label}
                                </span>
                                <span className="text-[10px] font-mono tabular-nums opacity-75 shrink-0">
                                  {(clip.durationMs / 1000).toFixed(2)}s
                                </span>
                              </div>

                              {hasRealPeaks ? (
                                <RealWaveformSvg
                                  peaks={clip.waveformPeaks!}
                                  selected={isSelected}
                                  accent={accent}
                                />
                              ) : (
                                <span className="text-[10px] font-mono tabular-nums opacity-75 truncate block">
                                  {clip.hasRealAudio
                                    ? 'Audio stored · PCM waveform unavailable'
                                    : 'No synthesized WAV yet'}
                                </span>
                              )}
                            </button>
                          );
                        })
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </Surface>

      {/* Selected Clip Precision Editor + Export Studio */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <Surface className="lg:col-span-7 space-y-4">
          <SectionTitle
            title="Selected Clip Precision Editor"
            meta="Nudge, trim boundaries, split at playhead, merge adjacent clips, clip volume & fade envelopes"
          />

          {selectedClip ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <p className="text-slate-500">Start Timestamp</p>
                  <p className="mt-1 font-mono font-semibold text-slate-900 tabular-nums">
                    {formatTimecode(selectedClip.startMs)}
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <p className="text-slate-500">End Timestamp</p>
                  <p className="mt-1 font-mono font-semibold text-slate-900 tabular-nums">
                    {formatTimecode(selectedClip.endMs)}
                  </p>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <p className="text-slate-500">Clip Duration</p>
                  <p className="mt-1 font-mono font-semibold text-slate-900 tabular-nums">
                    {(selectedClip.durationMs / 1000).toFixed(2)}s
                  </p>
                </div>
              </div>

              {linkedSegment ? (
                <div className="space-y-1 text-xs text-slate-600">
                  <p>
                    Sync tolerance:{' '}
                    <span className="font-medium text-slate-900">
                      {
                        evaluateTimingAdjustment(
                          linkedSegment.originalStartMs,
                          selectedClip.startMs,
                          linkedSegment.preferredShiftLimitMs
                        ).label
                      }
                    </span>
                    {linkedSegment.timingMatchLabel ? (
                      <span className="ml-2 font-mono text-blue-700">
                        ({linkedSegment.timingMatchLabel})
                      </span>
                    ) : null}
                  </p>
                  {linkedSegment.actualGeneratedDurationMs !== null ? (
                    <p className="font-mono tabular-nums text-slate-500">
                      Measured Hindi WAV: {(linkedSegment.actualGeneratedDurationMs / 1000).toFixed(2)}s
                      {linkedSegment.syncDeltaMs !== undefined && linkedSegment.syncDeltaMs !== null
                        ? ` · Sync delta ${linkedSegment.syncDeltaMs >= 0 ? '+' : ''}${linkedSegment.syncDeltaMs}ms`
                        : ''}
                      {linkedSegment.appliedSpeedMultiplier !== undefined &&
                      linkedSegment.appliedSpeedMultiplier !== null
                        ? ` · Rate ${linkedSegment.appliedSpeedMultiplier}×`
                        : ''}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {/* Clip Volume & Fade Envelopes */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs">
                <div>
                  <label
                    htmlFor="clip-vol-slider"
                    className="flex items-center justify-between text-slate-600 mb-1"
                  >
                    <span className="inline-flex items-center gap-1">
                      <Sliders className="w-3 h-3" aria-hidden="true" />
                      Clip Gain
                    </span>
                    <span className="font-mono font-semibold text-slate-900 tabular-nums">
                      {(selectedClip.volumeDb ?? 0) >= 0
                        ? `+${selectedClip.volumeDb ?? 0}`
                        : selectedClip.volumeDb ?? 0}{' '}
                      dB
                    </span>
                  </label>
                  <input
                    id="clip-vol-slider"
                    type="range"
                    min={-12}
                    max={6}
                    step={0.5}
                    value={selectedClip.volumeDb ?? 0}
                    onChange={(e) =>
                      setHistory((h) =>
                        updateClipAudioParams(h, selectedClip.clipId, {
                          volumeDb: Number(e.target.value),
                        })
                      )
                    }
                    className="w-full"
                  />
                </div>

                <div>
                  <label
                    htmlFor="clip-fadein-input"
                    className="flex items-center justify-between text-slate-600 mb-1"
                  >
                    <span>Fade In (ms)</span>
                    <span className="font-mono font-semibold text-slate-900 tabular-nums">
                      {selectedClip.fadeInMs ?? 0} ms
                    </span>
                  </label>
                  <input
                    id="clip-fadein-input"
                    type="range"
                    min={0}
                    max={Math.min(1000, Math.floor(selectedClip.durationMs / 2))}
                    step={10}
                    value={selectedClip.fadeInMs ?? 0}
                    onChange={(e) =>
                      setHistory((h) =>
                        updateClipAudioParams(h, selectedClip.clipId, {
                          fadeInMs: Number(e.target.value),
                        })
                      )
                    }
                    className="w-full"
                  />
                </div>

                <div>
                  <label
                    htmlFor="clip-fadeout-input"
                    className="flex items-center justify-between text-slate-600 mb-1"
                  >
                    <span>Fade Out (ms)</span>
                    <span className="font-mono font-semibold text-slate-900 tabular-nums">
                      {selectedClip.fadeOutMs ?? 0} ms
                    </span>
                  </label>
                  <input
                    id="clip-fadeout-input"
                    type="range"
                    min={0}
                    max={Math.min(1000, Math.floor(selectedClip.durationMs / 2))}
                    step={10}
                    value={selectedClip.fadeOutMs ?? 0}
                    onChange={(e) =>
                      setHistory((h) =>
                        updateClipAudioParams(h, selectedClip.clipId, {
                          fadeOutMs: Number(e.target.value),
                        })
                      )
                    }
                    className="w-full"
                  />
                </div>
              </div>

              {/* Action Controls */}
              <div className="flex flex-wrap items-center gap-2">
                {selectedClip.sourceRef && selectedClip.hasRealAudio ? (
                  <button
                    type="button"
                    onClick={() =>
                      void handleTogglePlayKey(selectedClip.sourceRef, 'Selected Clip')
                    }
                    className="min-h-[36px] px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap"
                  >
                    {playingVaultKey === selectedClip.sourceRef ? (
                      <>
                        <Square className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Stop Clip</span>
                      </>
                    ) : (
                      <>
                        <Play className="w-3.5 h-3.5" aria-hidden="true" />
                        <span>Play Selected Clip</span>
                      </>
                    )}
                  </button>
                ) : null}

                <button
                  type="button"
                  onClick={() =>
                    setHistory((h) => nudgeClipTiming(h, selectedClip.clipId, -100))
                  }
                  className="min-h-[36px] px-2.5 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-medium text-slate-800 inline-flex items-center gap-1 whitespace-nowrap"
                >
                  <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Nudge -100ms</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setHistory((h) => nudgeClipTiming(h, selectedClip.clipId, 100))
                  }
                  className="min-h-[36px] px-2.5 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-medium text-slate-800 inline-flex items-center gap-1 whitespace-nowrap"
                >
                  <span>Nudge +100ms</span>
                  <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                </button>

                <button
                  type="button"
                  onClick={() =>
                    setHistory((h) => trimClipTiming(h, selectedClip.clipId, 100, 0))
                  }
                  className="min-h-[36px] px-2.5 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-medium text-slate-800 whitespace-nowrap"
                >
                  Trim Start +100ms
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setHistory((h) => trimClipTiming(h, selectedClip.clipId, 0, -100))
                  }
                  className="min-h-[36px] px-2.5 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 text-xs font-medium text-slate-800 whitespace-nowrap"
                >
                  Trim End -100ms
                </button>

                <button
                  type="button"
                  disabled={!canSplitSelected}
                  title={
                    canSplitSelected
                      ? `Split clip at playhead (${formatTimecode(playheadMs)})`
                      : 'Move playhead inside the selected clip (>150ms from edges) to split'
                  }
                  onClick={() =>
                    setHistory((h) => splitClipAtPlayhead(h, selectedClip.clipId, playheadMs))
                  }
                  className="min-h-[36px] px-2.5 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-40 text-xs font-medium text-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap"
                >
                  <Scissors className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Split at Playhead</span>
                </button>

                <button
                  type="button"
                  disabled={!hasAdjacentMergeTarget}
                  onClick={() =>
                    setHistory((h) => mergeAdjacentClips(h, selectedClip.clipId))
                  }
                  className="min-h-[36px] px-2.5 py-1.5 rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-40 text-xs font-medium text-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap"
                >
                  <Merge className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Merge Next</span>
                </button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-500">
              Select any clip on the timeline to inspect its waveform, adjust gain/fades, trim boundaries, or split at the playhead.
            </p>
          )}
        </Surface>

        {/* Export Studio & Diagnostics */}
        <div className="lg:col-span-5 space-y-6">
          <Surface>
            <SectionTitle
              title="Export Production Deliverables"
              meta="Real mixed 16-bit PCM WAV, synchronized SRT subtitles, and complete JSON package"
            />
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs pb-2 border-b border-slate-100">
                <span className="text-slate-500">Final Dub WAV Status</span>
                <StatusText
                  label={
                    finalMixStem
                      ? `Ready (${(finalMixStem.sizeBytes / 1024).toFixed(0)} KB)`
                      : 'Not Rendered Yet'
                  }
                  tone={finalMixStem ? 'nominal' : 'warning'}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => void handleExport('final_wav')}
                  className="min-h-[38px] px-3 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-medium inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Download Final WAV</span>
                </button>

                <button
                  type="button"
                  onClick={() => void handleExport('hindi_srt')}
                  className="min-h-[38px] px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-xs font-medium inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Export Hindi SRT</span>
                </button>

                <button
                  type="button"
                  onClick={() => void handleExport('japanese_srt')}
                  className="min-h-[38px] px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-xs font-medium inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Export Japanese SRT</span>
                </button>

                <button
                  type="button"
                  onClick={() => void handleExport('production_json')}
                  className="min-h-[38px] px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-xs font-medium inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>Production JSON</span>
                </button>
              </div>
            </div>
          </Surface>

          <Surface>
            <SectionTitle
              title="Timeline & Stem Diagnostics"
              meta="Real PCM stems, protected sound regions, and timeline structure"
            />
            <dl className="divide-y divide-slate-100 text-xs">
              <div className="py-2 flex items-center justify-between">
                <dt className="text-slate-500">Tracks / Clips</dt>
                <dd className="font-mono font-semibold text-slate-900 tabular-nums">
                  {tracks.length} / {clips.length}
                </dd>
              </div>
              <div className="py-2 flex items-center justify-between">
                <dt className="text-slate-500">Audio Stems Generated</dt>
                <dd className="font-mono font-semibold text-slate-900 tabular-nums">
                  {activeBundle.audioStems.length} ({activeBundle.audioStems.map((s) => s.stemType.replace('_stem', '')).join(', ') || 'none'})
                </dd>
              </div>
              <div className="py-2 flex items-center justify-between">
                <dt className="text-slate-500">Protected Sound Regions</dt>
                <dd className="font-mono font-semibold text-slate-900 tabular-nums">
                  {activeBundle.soundEvents.filter((e) => e.preserveOriginal).length} / {activeBundle.soundEvents.length}
                </dd>
              </div>
              <div className="py-2 flex items-center justify-between">
                <dt className="text-slate-500">Empty Silence Intervals</dt>
                <dd className="font-mono font-semibold text-slate-900 tabular-nums">
                  {silenceIntervals.length}
                </dd>
              </div>
              <div className="py-2 flex items-center justify-between">
                <dt className="text-slate-500">Overlapping Dialogue Pairs</dt>
                <dd className="font-mono font-semibold text-slate-900 tabular-nums">
                  {overlaps.length}
                </dd>
              </div>
            </dl>
            {backgroundStem?.artifactWarning ? (
              <p className="mt-3 pt-3 border-t border-slate-100 text-[11px] text-amber-800 leading-relaxed">
                Separation note: {backgroundStem.artifactWarning}
              </p>
            ) : null}
          </Surface>
        </div>
      </div>
    </div>
  );
}
