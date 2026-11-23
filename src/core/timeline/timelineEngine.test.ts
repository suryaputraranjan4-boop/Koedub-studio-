import test from 'node:test';
import assert from 'node:assert/strict';
import type { AudioClip, TimelineTrack } from '../../types/domain';
import {
  computeSilenceIntervals,
  createInitialTimelineHistory,
  evaluateTimingAdjustment,
  findOverlappingClips,
  isTrackAudible,
  nudgeClipTiming,
  redoTimeline,
  toggleTrackMute,
  toggleTrackSolo,
  undoTimeline,
} from './timelineEngine';

const sampleTracks: TimelineTrack[] = [
  {
    trackId: 't1',
    projectId: 'p1',
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
    trackId: 't2',
    projectId: 'p1',
    name: 'Dialogue Master',
    kind: 'dialogue',
    characterId: null,
    orderIndex: 1,
    muted: false,
    solo: false,
    gainDb: 0,
    locked: false,
  },
];

const sampleClips: AudioClip[] = [
  {
    clipId: 'c1',
    projectId: 'p1',
    trackId: 't2',
    segmentId: 's1',
    label: 'Line 1',
    startMs: 1000,
    endMs: 3000,
    durationMs: 2000,
    sourceNamespace: null,
    sourceRef: null,
    hasRealAudio: false,
    waveformPeaks: null,
  },
  {
    clipId: 'c2',
    projectId: 'p1',
    trackId: 't2',
    segmentId: 's2',
    label: 'Line 2 (overlap)',
    startMs: 2500,
    endMs: 4500,
    durationMs: 2000,
    sourceNamespace: null,
    sourceRef: null,
    hasRealAudio: false,
    waveformPeaks: null,
  },
  {
    clipId: 'c3',
    projectId: 'p1',
    trackId: 't2',
    segmentId: 's3',
    label: 'Line 3',
    startMs: 7000,
    endMs: 9000,
    durationMs: 2000,
    sourceNamespace: null,
    sourceRef: null,
    hasRealAudio: false,
    waveformPeaks: null,
  },
];

test('timeline undo/redo stack reverts and reapplies clip timing and track states', () => {
  let state = createInitialTimelineHistory(sampleTracks, sampleClips);
  state = nudgeClipTiming(state, 'c1', 250);
  assert.equal(state.present.clips[0].startMs, 1250);
  assert.equal(state.present.clips[0].endMs, 3250);
  assert.equal(state.dirty, true);

  state = toggleTrackMute(state, 't1');
  assert.equal(state.present.tracks[0].muted, true);

  state = undoTimeline(state);
  assert.equal(state.present.tracks[0].muted, false);
  assert.equal(state.present.clips[0].startMs, 1250);

  state = undoTimeline(state);
  assert.equal(state.present.clips[0].startMs, 1000);

  state = redoTimeline(state);
  assert.equal(state.present.clips[0].startMs, 1250);
});

test('track solo overrides non-solo tracks while mute silences track', () => {
  let state = createInitialTimelineHistory(sampleTracks, sampleClips);
  state = toggleTrackSolo(state, 't2');
  const tracks = state.present.tracks;

  assert.equal(isTrackAudible(tracks[0], tracks), false);
  assert.equal(isTrackAudible(tracks[1], tracks), true);
});

test('silence intervals represent empty gaps without creating audio files', () => {
  const silences = computeSilenceIntervals(sampleClips, 10000);
  assert.deepEqual(silences, [
    { startMs: 0, endMs: 1000, durationMs: 1000 },
    { startMs: 4500, endMs: 7000, durationMs: 2500 },
    { startMs: 9000, endMs: 10000, durationMs: 1000 },
  ]);
});

test('overlapping dialogue detection identifies concurrent clips accurately', () => {
  const overlaps = findOverlappingClips(sampleClips);
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0][0].clipId, 'c1');
  assert.equal(overlaps[0][1].clipId, 'c2');
});

test('timing adjustment evaluation checks preferred ±200-400ms tolerance', () => {
  const ok = evaluateTimingAdjustment(1000, 1300, 400);
  assert.equal(ok.withinPreferredRange, true);
  assert.equal(ok.requiresReview, false);

  const drift = evaluateTimingAdjustment(1000, 1650, 400);
  assert.equal(drift.withinPreferredRange, false);
  assert.equal(drift.requiresReview, true);
});
