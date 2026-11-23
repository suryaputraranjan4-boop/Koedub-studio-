import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAudioSoundEvents,
  computeRealWaveformPeaks,
  measureAcousticQAMetrics,
  mixFinalDubAudio,
  separateAudioStemsConservative,
} from './audioProduction';
import { buildSrtSubtitles } from './exportManager';
import { classifyDialogueComplexity } from './intelligenceRouter';
import {
  createInitialTimelineHistory,
  mergeAdjacentClips,
  redoTimeline,
  splitClipAtPlayhead,
  trimClipTiming,
  undoTimeline,
  updateClipAudioParams,
  updateTrackGainDb,
} from '../timeline/timelineEngine';
import type { AudioClip, DialogueSegment, TimelineTrack } from '../../types/domain';

function makeSine(freqHz: number, durationSec: number, sampleRate: number, amp: number): Float32Array {
  const len = Math.round(durationSec * sampleRate);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i += 1) {
    out[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * amp;
  }
  return out;
}

test('computeRealWaveformPeaks returns all zeros for silence and accurate peaks for 440 Hz sine', () => {
  const silent = new Float32Array(1600);
  const silentPeaks = computeRealWaveformPeaks(silent, 16);
  assert.equal(silentPeaks.length, 16);
  assert.ok(silentPeaks.every((p) => p === 0));

  const tone = makeSine(440, 0.5, 16000, 0.8);
  const tonePeaks = computeRealWaveformPeaks(tone, 20);
  assert.equal(tonePeaks.length, 20);
  assert.ok(tonePeaks.every((p) => p >= 0.78 && p <= 0.81));
});

test('classifyAudioSoundEvents distinguishes speech vs harmonic song/music and marks songs preserveOriginal', () => {
  const sr = 16000;
  // 2 seconds total: 0..1s pure 1100 Hz mid vocal speech; 1..2s heavy 110 Hz bass + 450 Hz melody (song)
  const samples = new Float32Array(sr * 2);
  for (let i = 0; i < sr; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * 1100 * i) / sr) * 0.35;
  }
  for (let i = sr; i < sr * 2; i += 1) {
    samples[i] =
      Math.sin((2 * Math.PI * 110 * i) / sr) * 0.45 +
      Math.sin((2 * Math.PI * 450 * i) / sr) * 0.4;
  }

  const events = classifyAudioSoundEvents('prj_test', samples, sr, [
    { startMs: 0, endMs: 950 },
  ]);
  assert.ok(events.length >= 2);
  const speechEvt = events.find((e) => e.category === 'speech');
  const songOrMusicEvt = events.find((e) => e.category === 'song' || e.category === 'music');
  assert.ok(speechEvt, 'Expected speech event in first second');
  assert.equal(speechEvt.preserveOriginal, false);
  assert.ok(songOrMusicEvt, 'Expected song or music event in second half');
  assert.equal(songOrMusicEvt.preserveOriginal, true);
});

test('separateAudioStemsConservative preserves protected song regions and reports honest artifactWarning', () => {
  const sr = 16000;
  const mono = makeSine(600, 1.5, sr, 0.4);
  const soundEvents = [
    {
      id: 'snd_1',
      projectId: 'prj_test',
      startMs: 800,
      endMs: 1500,
      category: 'song' as const,
      preserveOriginal: true,
      confidence: 0.85,
      label: 'Song',
      spectralCentroidHz: 420,
      energyDb: -12,
    },
  ];

  const stems = separateAudioStemsConservative({
    monoSamples: mono,
    sampleRate: sr,
    soundEvents,
    dialogueWindows: [{ startMs: 0, endMs: 700 }],
  });

  assert.equal(stems.dialogueSamples.length, mono.length);
  assert.equal(stems.backgroundSamples.length, mono.length);
  assert.equal(stems.durationMs, 1500);
  assert.ok(stems.artifactWarning.length > 20);

  // Inside the protected song window (1.1s..1.4s), background must closely match original mono
  let maxSongDiff = 0;
  for (let i = Math.round(1.1 * sr); i < Math.round(1.4 * sr); i += 1) {
    maxSongDiff = Math.max(maxSongDiff, Math.abs(stems.backgroundSamples[i] - mono[i]));
  }
  assert.ok(maxSongDiff < 0.02, `Expected protected song intact, max diff=${maxSongDiff}`);
});

test('mixFinalDubAudio mixes loud dialogue onto background with ducking and zero digital clipping', () => {
  const sr = 16000;
  const bg = makeSine(220, 2.0, sr, 0.7);
  const loudDialogue = makeSine(880, 1.0, sr, 0.95);

  const tracks: TimelineTrack[] = [
    {
      trackId: 'trk_music',
      projectId: 'prj_test',
      name: 'Music & SFX',
      kind: 'music_sfx',
      characterId: null,
      orderIndex: 0,
      muted: false,
      solo: false,
      gainDb: 0,
      locked: false,
    },
    {
      trackId: 'trk_dlg',
      projectId: 'prj_test',
      name: 'Hindi Dialogue',
      kind: 'dialogue',
      characterId: null,
      orderIndex: 1,
      muted: false,
      solo: false,
      gainDb: 3, // Deliberately hot to test soft-knee limiter!
      locked: false,
    },
  ];

  const clip: AudioClip = {
    clipId: 'clip_1',
    projectId: 'prj_test',
    trackId: 'trk_dlg',
    segmentId: 'SEG-1',
    label: 'Line 1',
    startMs: 400,
    endMs: 1400,
    durationMs: 1000,
    sourceNamespace: 'generated_audio',
    sourceRef: 'generated_audio/prj_test/SEG-1.wav',
    hasRealAudio: true,
    waveformPeaks: null,
    volumeDb: 3,
    fadeInMs: 25,
    fadeOutMs: 25,
  };

  const mixed = mixFinalDubAudio({
    tracks,
    backgroundSamples: bg,
    backgroundSampleRate: sr,
    dialogueInputs: [{ clip, track: tracks[1], samples: loudDialogue, sampleRate: sr }],
    soundEvents: [],
    totalDurationMs: 2000,
    targetSampleRate: sr,
  });

  assert.equal(mixed.metrics.clippingSampleCount, 0);
  assert.ok(mixed.metrics.peakDbfs <= -0.9, `Expected peak <= -0.9 dBFS, got ${mixed.metrics.peakDbfs}`);
  assert.equal(mixed.metrics.exportIntegrityVerified, true);
  assert.ok(mixed.wavBlob.size > 44);
  assert.ok(mixed.waveformPeaks.length > 0);
});

test('measureAcousticQAMetrics accurately counts intentional clipping vs clean -6 dBFS audio', () => {
  const sr = 16000;
  const clean = makeSine(440, 0.5, sr, 0.5); // -6 dBFS
  const cleanMetrics = measureAcousticQAMetrics(clean, sr);
  assert.equal(cleanMetrics.clippingSampleCount, 0);
  assert.ok(cleanMetrics.peakDbfs >= -6.2 && cleanMetrics.peakDbfs <= -5.8);

  const clipped = new Float32Array(clean);
  clipped[100] = 1.0;
  clipped[101] = -0.999;
  clipped[102] = 0.996;
  const clippedMetrics = measureAcousticQAMetrics(clipped, sr);
  assert.equal(clippedMetrics.clippingSampleCount, 3);
});

test('buildSrtSubtitles formats Hindi and Japanese SubRip timestamps accurately', () => {
  const segs: DialogueSegment[] = [
    {
      segmentId: 'SEG-1',
      projectId: 'prj_1',
      sourceSpeakerId: 'SPK_01',
      characterId: null,
      originalStartMs: 1000,
      originalEndMs: 3500,
      originalDurationMs: 2500,
      japaneseText: 'ここから先は俺が引き受ける。',
      hindiText: 'यहाँ से आगे की ज़िम्मेदारी मेरी है।',
      emotion: { primaryEmotion: 'Confident', intensity: 0.8, deliveryNotes: '', source: 'manual' },
      assignedHindiVoiceId: null,
      generatedAudioRef: null,
      actualGeneratedDurationMs: null,
      finalStartMs: 1050,
      finalEndMs: 3600,
      preferredShiftLimitMs: 300,
      overlapGroupId: null,
      syncStatus: 'in_tolerance',
      qaStatus: 'passed',
      reviewStatus: 'approved',
      updatedAt: new Date().toISOString(),
    },
  ];

  const hiSrt = buildSrtSubtitles(segs, 'hi');
  assert.ok(hiSrt.includes('00:00:01,050 --> 00:00:03,600'));
  assert.ok(hiSrt.includes('यहाँ से आगे की ज़िम्मेदारी मेरी है।'));

  const jaSrt = buildSrtSubtitles(segs, 'ja');
  assert.ok(jaSrt.includes('00:00:01,000 --> 00:00:03,500'));
  assert.ok(jaSrt.includes('ここから先は俺が引き受ける。'));
});

test('timelineEngine Prompt 3 operations (trim, split, merge, volume/fades, track gain, undo/redo)', () => {
  const tracks: TimelineTrack[] = [
    {
      trackId: 'trk_1',
      projectId: 'prj_1',
      name: 'Dialogue',
      kind: 'dialogue',
      characterId: null,
      orderIndex: 0,
      muted: false,
      solo: false,
      gainDb: 0,
      locked: false,
    },
  ];
  const clips: AudioClip[] = [
    {
      clipId: 'clip_a',
      projectId: 'prj_1',
      trackId: 'trk_1',
      segmentId: 'SEG-1',
      label: 'Hero Line',
      startMs: 1000,
      endMs: 3000,
      durationMs: 2000,
      sourceNamespace: 'generated_audio',
      sourceRef: 'generated_audio/prj_1/SEG-1.wav',
      hasRealAudio: true,
      waveformPeaks: [0.2, 0.5, 0.8, 0.4, 0.6, 0.3],
      volumeDb: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
    },
  ];

  let h = createInitialTimelineHistory(tracks, clips);

  // Trim start +200ms, end -200ms
  h = trimClipTiming(h, 'clip_a', 200, -200);
  assert.equal(h.present.clips[0].startMs, 1200);
  assert.equal(h.present.clips[0].endMs, 2800);
  assert.equal(h.present.clips[0].durationMs, 1600);

  // Split at 2000ms
  h = splitClipAtPlayhead(h, 'clip_a', 2000);
  assert.equal(h.present.clips.length, 2);
  assert.equal(h.present.clips[0].endMs, 2000);
  assert.equal(h.present.clips[1].startMs, 2000);

  // Merge adjacent clips back
  h = mergeAdjacentClips(h, h.present.clips[0].clipId);
  assert.equal(h.present.clips.length, 1);
  assert.equal(h.present.clips[0].durationMs, 1600);

  // Update volume & fades + track gain
  h = updateClipAudioParams(h, 'clip_a', { volumeDb: 2.5, fadeInMs: 100, fadeOutMs: 120 });
  assert.equal(h.present.clips[0].volumeDb, 2.5);
  assert.equal(h.present.clips[0].fadeInMs, 100);
  assert.equal(h.present.clips[0].fadeOutMs, 120);

  h = updateTrackGainDb(h, 'trk_1', -3.5);
  assert.equal(h.present.tracks[0].gainDb, -3.5);

  // Undo & redo
  h = undoTimeline(h);
  assert.equal(h.present.tracks[0].gainDb, 0);
  h = redoTimeline(h);
  assert.equal(h.present.tracks[0].gainDb, -3.5);
});

test('classifyDialogueComplexity separates simple greetings from idiomatic or tight-timing lines', () => {
  assert.equal(classifyDialogueComplexity('ありがとう', 2500), 'simple');
  assert.equal(
    classifyDialogueComplexity('やっぱり先輩には敵わないよ、冗談じゃない！', 2200),
    'complex'
  );
});
