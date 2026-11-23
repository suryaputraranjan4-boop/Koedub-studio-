import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeVoiceAcoustics,
  applyPostSynthesisDsp,
  clusterSpeakerIntervals,
  decodePcmWavBuffer,
  decodePcmWavBufferStereo,
  detectVoiceActivitySegments,
  encodeFloat32ToWavBuffer,
  encodeStereoToWavBuffer,
  extractMono16kChunkFromStereo,
  measureSamplesDurationMs,
  timeStretchPcmWSOLA,
} from './audioDsp';

function generateSine(
  freqHz: number,
  durationSec: number,
  sampleRate: number,
  amplitude: number = 0.45
): Float32Array {
  const len = Math.round(durationSec * sampleRate);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i += 1) {
    // Include light second harmonic so spectral centroid differs realistically
    out[i] =
      amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate) +
      amplitude * 0.25 * Math.sin((2 * Math.PI * freqHz * 2 * i) / sampleRate);
  }
  return out;
}

describe('Audio DSP & Speaker Diarization Engine', () => {
  it('encodes and decodes 16-bit PCM WAV preserving exact sample rate and duration', () => {
    const sampleRate = 16000;
    const tone = generateSine(220, 1.5, sampleRate, 0.5);
    const wavBuf = encodeFloat32ToWavBuffer(tone, sampleRate);
    const decoded = decodePcmWavBuffer(wavBuf);

    assert.ok(decoded, 'Decoded WAV should not be null');
    assert.equal(decoded.sampleRate, 16000);
    assert.equal(decoded.samples.length, 24000);
    assert.equal(decoded.durationMs, 1500);
    assert.equal(measureSamplesDurationMs(decoded.samples.length, decoded.sampleRate), 1500);
  });

  it('encodes and decodes native 48 kHz stereo PCM WAV without collapsing stereo width', () => {
    const sr = 48000;
    const left = generateSine(220, 0.5, sr, 0.4);
    const right = generateSine(440, 0.5, sr, 0.4);
    const buf = encodeStereoToWavBuffer(left, right, sr);
    const decoded = decodePcmWavBufferStereo(buf);

    assert.ok(decoded, 'Stereo WAV decode should succeed');
    assert.equal(decoded.sampleRate, 48000);
    assert.equal(decoded.channels, 2);
    assert.equal(decoded.durationMs, 500);
    assert.equal(decoded.left.length, 24000);
    assert.equal(decoded.right.length, 24000);

    // Stereo channels must stay distinct (not collapsed to mono)
    let lrDiff = 0;
    for (let i = 0; i < 1000; i += 1) {
      lrDiff += Math.abs(decoded.left[i] - decoded.right[i]);
    }
    assert.ok(lrDiff > 50, 'Expected distinct L/R stereo channels');

    // 16 kHz mono chunk slice extracts exact requested window cleanly
    const mono16k = extractMono16kChunkFromStereo(decoded, 100, 350);
    assert.equal(mono16k.sampleRate, 16000);
    assert.ok(Math.abs(mono16k.samples.length - 4000) <= 16);
  });

  it('physically stretches PCM duration with pitch-preserving WSOLA bounded to [0.88, 1.15]', () => {
    const sr = 24000;
    const input = generateSine(200, 1.5, sr, 0.45);
    const faster = timeStretchPcmWSOLA(input, sr, 1.12);
    const expectedLen = Math.round(input.length / 1.12);
    assert.ok(
      Math.abs(faster.samples.length - expectedLen) <= Math.round(sr * 0.04),
      `Expected ~${expectedLen} samples for 1.12x WSOLA, got ${faster.samples.length}`
    );

    // Ensure no digital clipping introduced by WSOLA overlap-add
    let peak = 0;
    for (let i = 0; i < faster.samples.length; i += 1) {
      peak = Math.max(peak, Math.abs(faster.samples[i]));
    }
    assert.ok(peak <= 0.99, `Expected WSOLA peak <= 0.99, got ${peak}`);
  });

  it('detects real speech intervals via VAD and returns empty array on silence', () => {
    const sr = 16000;
    const silent = new Float32Array(sr * 2);
    assert.equal(detectVoiceActivitySegments(silent, sr).length, 0);

    // Build 3s signal: 0.4s silence -> 0.8s tone -> 0.6s silence -> 0.8s tone -> 0.4s silence
    const combined = new Float32Array(sr * 3);
    const toneA = generateSine(135, 0.8, sr, 0.5);
    const toneB = generateSine(260, 0.8, sr, 0.5);
    combined.set(toneA, Math.round(0.4 * sr));
    combined.set(toneB, Math.round(1.8 * sr));

    const intervals = detectVoiceActivitySegments(combined, sr);
    assert.equal(intervals.length, 2);
    assert.ok(intervals[0].startMs >= 300 && intervals[0].startMs <= 500);
    assert.ok(intervals[1].startMs >= 1700 && intervals[1].startMs <= 1900);
  });

  it('measures real F0 pitch and cautious vocal presentation in Voice Analysis Agent (#8)', () => {
    const sr = 16000;
    const deepTone = generateSine(125, 1.0, sr, 0.4);
    const highTone = generateSine(250, 1.0, sr, 0.4);

    const deepStats = analyzeVoiceAcoustics(deepTone, sr, 10);
    const highStats = analyzeVoiceAcoustics(highTone, sr, 10);

    assert.equal(deepStats.acousticMeasurementSource, 'web_audio_dsp');
    assert.ok(
      typeof deepStats.pitchMeanHz === 'number' &&
        deepStats.pitchMeanHz >= 110 &&
        deepStats.pitchMeanHz <= 140
    );
    assert.ok(
      typeof highStats.pitchMeanHz === 'number' &&
        highStats.pitchMeanHz >= 230 &&
        highStats.pitchMeanHz <= 270
    );
    assert.ok(deepStats.genderPresentation.toLowerCase().includes('masculine-leaning'));
    assert.ok(highStats.genderPresentation.toLowerCase().includes('feminine-leaning'));
  });

  it('clusters recurring speaker turns onto the same Speaker ID and separates distinct speakers', () => {
    const sr = 16000;
    // 5 seconds: SPK A (125Hz) at 0.2-1.0s, SPK B (280Hz) at 1.6-2.4s, SPK A (125Hz) again at 3.0-3.8s
    const total = new Float32Array(sr * 4.5);
    total.set(generateSine(125, 0.8, sr, 0.45), Math.round(0.2 * sr));
    total.set(generateSine(280, 0.8, sr, 0.45), Math.round(1.6 * sr));
    total.set(generateSine(125, 0.8, sr, 0.45), Math.round(3.0 * sr));

    const intervals = [
      { startMs: 200, endMs: 1000, energyDb: -12, overlapping: false },
      { startMs: 1600, endMs: 2400, energyDb: -12, overlapping: false },
      { startMs: 3000, endMs: 3800, energyDb: -12, overlapping: false },
    ];

    const clustered = clusterSpeakerIntervals(total, sr, intervals, 0.92);
    assert.equal(clustered.length, 3);
    assert.equal(clustered[0].speakerLabel, 'SPK_01');
    assert.equal(clustered[1].speakerLabel, 'SPK_02');
    assert.equal(clustered[2].speakerLabel, 'SPK_01');
  });

  it('keeps post-synthesis DSP rate adjustments bounded for natural speech', () => {
    const sr = 16000;
    const tone = generateSine(180, 1.0, sr, 0.35);
    const adjusted = applyPostSynthesisDsp(tone, sr, {
      rateMultiplier: 2.5, // intentionally extreme request
      pitchSemitones: 0,
      gainDb: 0,
    });
    // Must clamp strictly below unnatural 2.5x speed (<= 1.18x => >= ~847ms)
    assert.ok(adjusted.durationMs >= 800, `Expected bounded duration >= 800ms, got ${adjusted.durationMs}ms`);
  });
});
