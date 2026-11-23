import type { AudioClip, TimelineTrack } from '../../types/domain';

export interface TimelineSnapshot {
  tracks: TimelineTrack[];
  clips: AudioClip[];
  selectedClipId: string | null;
  playheadMs: number;
  zoomPxPerSec: number;
}

export interface TimelineHistoryState {
  past: TimelineSnapshot[];
  present: TimelineSnapshot;
  future: TimelineSnapshot[];
  dirty: boolean;
}

export interface SilenceInterval {
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface TimingAdjustmentEvaluation {
  deltaMs: number;
  withinPreferredRange: boolean;
  requiresReview: boolean;
  label: string;
}

export const MIN_ZOOM_PX_PER_SEC = 10;
export const MAX_ZOOM_PX_PER_SEC = 240;
export const DEFAULT_PREFERRED_SHIFT_MIN_MS = 200;
export const DEFAULT_PREFERRED_SHIFT_MAX_MS = 400;

export function createInitialTimelineHistory(
  tracks: TimelineTrack[],
  clips: AudioClip[]
): TimelineHistoryState {
  return {
    past: [],
    present: {
      tracks,
      clips,
      selectedClipId: clips[0]?.clipId ?? null,
      playheadMs: 0,
      zoomPxPerSec: 48,
    },
    future: [],
    dirty: false,
  };
}

export function pushTimelineMutation(
  state: TimelineHistoryState,
  updater: (snapshot: TimelineSnapshot) => TimelineSnapshot
): TimelineHistoryState {
  const nextPresent = updater(state.present);
  const trimmedPast = [...state.past.slice(-29), state.present];
  return {
    past: trimmedPast,
    present: nextPresent,
    future: [],
    dirty: true,
  };
}

export function undoTimeline(state: TimelineHistoryState): TimelineHistoryState {
  if (state.past.length === 0) return state;
  const previous = state.past[state.past.length - 1];
  const remainingPast = state.past.slice(0, -1);
  return {
    past: remainingPast,
    present: previous,
    future: [state.present, ...state.future],
    dirty: true,
  };
}

export function redoTimeline(state: TimelineHistoryState): TimelineHistoryState {
  if (state.future.length === 0) return state;
  const next = state.future[0];
  const remainingFuture = state.future.slice(1);
  return {
    past: [...state.past, state.present],
    present: next,
    future: remainingFuture,
    dirty: true,
  };
}

export function toggleTrackMute(
  state: TimelineHistoryState,
  trackId: string
): TimelineHistoryState {
  return pushTimelineMutation(state, (snap) => ({
    ...snap,
    tracks: snap.tracks.map((track) =>
      track.trackId === trackId ? { ...track, muted: !track.muted } : track
    ),
  }));
}

export function toggleTrackSolo(
  state: TimelineHistoryState,
  trackId: string
): TimelineHistoryState {
  return pushTimelineMutation(state, (snap) => ({
    ...snap,
    tracks: snap.tracks.map((track) =>
      track.trackId === trackId ? { ...track, solo: !track.solo } : track
    ),
  }));
}

/**
 * Resolves whether a track is effectively audible given Mute and Solo states across all tracks.
 */
export function isTrackAudible(
  track: TimelineTrack,
  allTracks: TimelineTrack[]
): boolean {
  const anySolo = allTracks.some((t) => t.solo);
  if (anySolo) {
    return track.solo && !track.muted;
  }
  return !track.muted;
}

export function nudgeClipTiming(
  state: TimelineHistoryState,
  clipId: string,
  deltaMs: number
): TimelineHistoryState {
  return pushTimelineMutation(state, (snap) => ({
    ...snap,
    clips: snap.clips.map((clip) => {
      if (clip.clipId !== clipId) return clip;
      const nextStart = Math.max(0, clip.startMs + deltaMs);
      const nextEnd = nextStart + clip.durationMs;
      return {
        ...clip,
        startMs: nextStart,
        endMs: nextEnd,
      };
    }),
  }));
}

export function trimClipTiming(
  state: TimelineHistoryState,
  clipId: string,
  deltaStartMs: number,
  deltaEndMs: number
): TimelineHistoryState {
  return pushTimelineMutation(state, (snap) => ({
    ...snap,
    clips: snap.clips.map((clip) => {
      if (clip.clipId !== clipId) return clip;
      const nextStart = Math.max(0, clip.startMs + deltaStartMs);
      const nextEnd = Math.max(nextStart + 150, clip.endMs + deltaEndMs);
      const nextTrimStart = Math.max(0, (clip.trimStartMs ?? 0) + Math.max(0, deltaStartMs));
      const nextTrimEnd = Math.max(0, (clip.trimEndMs ?? 0) + Math.max(0, -deltaEndMs));
      return {
        ...clip,
        startMs: nextStart,
        endMs: nextEnd,
        durationMs: nextEnd - nextStart,
        trimStartMs: nextTrimStart,
        trimEndMs: nextTrimEnd,
      };
    }),
  }));
}

export function splitClipAtPlayhead(
  state: TimelineHistoryState,
  clipId: string,
  splitMs: number
): TimelineHistoryState {
  const target = state.present.clips.find((c) => c.clipId === clipId);
  if (!target) return state;
  const clampedSplit = Math.round(splitMs);
  if (clampedSplit <= target.startMs + 150 || clampedSplit >= target.endMs - 150) {
    return state;
  }

  return pushTimelineMutation(state, (snap) => {
    const leftDuration = clampedSplit - target.startMs;
    const rightDuration = target.endMs - clampedSplit;
    const splitRatio = leftDuration / Math.max(1, target.durationMs);
    const peaks = target.waveformPeaks;
    const peakSplitIdx = peaks ? Math.max(1, Math.floor(peaks.length * splitRatio)) : 0;

    const leftClip: AudioClip = {
      ...target,
      endMs: clampedSplit,
      durationMs: leftDuration,
      label: `${target.label} (A)`,
      waveformPeaks: peaks ? peaks.slice(0, peakSplitIdx) : null,
      fadeOutMs: Math.min(target.fadeOutMs ?? 0, 50),
    };
    const rightClip: AudioClip = {
      ...target,
      clipId: `${target.clipId}_part2_${Date.now().toString(36)}`,
      startMs: clampedSplit,
      endMs: target.endMs,
      durationMs: rightDuration,
      trimStartMs: (target.trimStartMs ?? 0) + leftDuration,
      label: `${target.label} (B)`,
      waveformPeaks: peaks ? peaks.slice(peakSplitIdx) : null,
      fadeInMs: Math.min(target.fadeInMs ?? 0, 50),
    };

    const nextClips: AudioClip[] = [];
    for (const c of snap.clips) {
      if (c.clipId === clipId) {
        nextClips.push(leftClip, rightClip);
      } else {
        nextClips.push(c);
      }
    }
    return {
      ...snap,
      clips: nextClips,
      selectedClipId: rightClip.clipId,
    };
  });
}

export function mergeAdjacentClips(
  state: TimelineHistoryState,
  firstClipId: string
): TimelineHistoryState {
  const first = state.present.clips.find((c) => c.clipId === firstClipId);
  if (!first) return state;

  const sameTrackSorted = state.present.clips
    .filter((c) => c.trackId === first.trackId)
    .sort((a, b) => a.startMs - b.startMs);
  const idx = sameTrackSorted.findIndex((c) => c.clipId === firstClipId);
  const second = idx >= 0 ? sameTrackSorted[idx + 1] : undefined;
  if (!second) return state;

  return pushTimelineMutation(state, (snap) => {
    const mergedEnd = Math.max(first.endMs, second.endMs);
    const mergedDuration = Math.max(150, mergedEnd - first.startMs);
    const mergedPeaks =
      first.waveformPeaks && second.waveformPeaks
        ? [...first.waveformPeaks, ...second.waveformPeaks].slice(0, 180)
        : first.waveformPeaks ?? second.waveformPeaks ?? null;

    const merged: AudioClip = {
      ...first,
      endMs: mergedEnd,
      durationMs: mergedDuration,
      label: first.label.replace(/\s*\(A\)$/, ''),
      waveformPeaks: mergedPeaks,
      fadeOutMs: second.fadeOutMs ?? first.fadeOutMs ?? 0,
    };

    return {
      ...snap,
      clips: snap.clips
        .filter((c) => c.clipId !== second.clipId)
        .map((c) => (c.clipId === first.clipId ? merged : c)),
      selectedClipId: merged.clipId,
    };
  });
}

export function updateClipAudioParams(
  state: TimelineHistoryState,
  clipId: string,
  params: { volumeDb?: number; fadeInMs?: number; fadeOutMs?: number }
): TimelineHistoryState {
  return pushTimelineMutation(state, (snap) => ({
    ...snap,
    clips: snap.clips.map((clip) => {
      if (clip.clipId !== clipId) return clip;
      return {
        ...clip,
        volumeDb:
          params.volumeDb !== undefined
            ? Math.max(-24, Math.min(12, params.volumeDb))
            : clip.volumeDb ?? 0,
        fadeInMs:
          params.fadeInMs !== undefined
            ? Math.max(0, Math.min(Math.floor(clip.durationMs / 2), params.fadeInMs))
            : clip.fadeInMs ?? 0,
        fadeOutMs:
          params.fadeOutMs !== undefined
            ? Math.max(0, Math.min(Math.floor(clip.durationMs / 2), params.fadeOutMs))
            : clip.fadeOutMs ?? 0,
      };
    }),
  }));
}

export function updateTrackGainDb(
  state: TimelineHistoryState,
  trackId: string,
  gainDb: number
): TimelineHistoryState {
  return pushTimelineMutation(state, (snap) => ({
    ...snap,
    tracks: snap.tracks.map((track) =>
      track.trackId === trackId
        ? { ...track, gainDb: Math.max(-24, Math.min(12, Math.round(gainDb * 10) / 10)) }
        : track
    ),
  }));
}

export function clampZoom(zoomPxPerSec: number): number {
  return Math.min(MAX_ZOOM_PX_PER_SEC, Math.max(MIN_ZOOM_PX_PER_SEC, zoomPxPerSec));
}

export function clampPlayhead(playheadMs: number, totalDurationMs: number): number {
  const upper = Math.max(0, totalDurationMs);
  return Math.min(upper, Math.max(0, Math.round(playheadMs)));
}

/**
 * Computes empty silence intervals between clips on a track.
 * Silence is strictly represented as empty timeline intervals, never silent audio files.
 */
export function computeSilenceIntervals(
  clips: AudioClip[],
  totalDurationMs: number
): SilenceInterval[] {
  if (totalDurationMs <= 0) return [];
  const sorted = [...clips].sort((a, b) => a.startMs - b.startMs);
  const intervals: SilenceInterval[] = [];
  let cursor = 0;

  for (const clip of sorted) {
    if (clip.startMs > cursor) {
      intervals.push({
        startMs: cursor,
        endMs: clip.startMs,
        durationMs: clip.startMs - cursor,
      });
    }
    cursor = Math.max(cursor, clip.endMs);
  }

  if (cursor < totalDurationMs) {
    intervals.push({
      startMs: cursor,
      endMs: totalDurationMs,
      durationMs: totalDurationMs - cursor,
    });
  }

  return intervals;
}

/**
 * Finds overlapping clip pairs (supported explicitly for overlapping anime dialogue).
 */
export function findOverlappingClips(
  clips: AudioClip[]
): Array<[AudioClip, AudioClip]> {
  const sorted = [...clips].sort((a, b) => a.startMs - b.startMs);
  const overlaps: Array<[AudioClip, AudioClip]> = [];

  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      if (sorted[j].startMs < sorted[i].endMs) {
        overlaps.push([sorted[i], sorted[j]]);
      } else {
        break;
      }
    }
  }

  return overlaps;
}

/**
 * Evaluates whether a timing shift stays within the preferred ±0.2–0.4s adjustment window.
 */
export function evaluateTimingAdjustment(
  originalStartMs: number,
  finalStartMs: number,
  preferredLimitMs: number = DEFAULT_PREFERRED_SHIFT_MAX_MS
): TimingAdjustmentEvaluation {
  const deltaMs = finalStartMs - originalStartMs;
  const absDelta = Math.abs(deltaMs);

  if (absDelta <= preferredLimitMs) {
    return {
      deltaMs,
      withinPreferredRange: true,
      requiresReview: false,
      label:
        absDelta === 0
          ? 'Exact alignment (0 ms)'
          : `Within target (${deltaMs > 0 ? '+' : ''}${deltaMs} ms)`,
    };
  }

  return {
    deltaMs,
    withinPreferredRange: false,
    requiresReview: true,
    label: `Exceeds ±${preferredLimitMs} ms preference (${deltaMs > 0 ? '+' : ''}${deltaMs} ms)`,
  };
}

export function formatTimecode(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '--:--.---';
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3600000);
  const minutes = Math.floor((clamped % 3600000) / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  const millis = clamped % 1000;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  const mmm = String(millis).padStart(3, '0');

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${mm}:${ss}.${mmm}`;
  }
  return `${mm}:${ss}.${mmm}`;
}
