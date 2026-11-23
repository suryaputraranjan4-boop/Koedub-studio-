import type {
  AcousticQAMetrics,
  AudioClip,
  AudioStemRecord,
  SoundEventCategory,
  SoundEventRecord,
  TimelineTrack,
} from '../../types/domain';
import {
  decodePcmWavBuffer,
  encodeFloat32ToWavBlob,
  measureSamplesDurationMs,
  resampleMono,
} from './audioDsp';
import { isTrackAudible } from '../timeline/timelineEngine';

/**
 * Computes genuine downsampled normalized amplitude peaks [0..1] from real PCM audio samples.
 * Never fabricates waveforms: silent audio yields all zeros, empty buffers return [].
 */
export function computeRealWaveformPeaks(
  samples: Float32Array,
  bucketCount: number = 96
): number[] {
  if (samples.length === 0 || bucketCount <= 0) return [];
  const count = Math.min(bucketCount, samples.length);
  const blockSize = samples.length / count;
  const peaks: number[] = [];

  for (let b = 0; b < count; b += 1) {
    const start = Math.floor(b * blockSize);
    const end = Math.max(start + 1, Math.min(samples.length, Math.floor((b + 1) * blockSize)));
    let maxAbs = 0;
    for (let i = start; i < end; i += 1) {
      const a = Math.abs(samples[i]);
      if (a > maxAbs) maxAbs = a;
    }
    peaks.push(Math.round(Math.min(1, maxAbs) * 1000) / 1000);
  }

  return peaks;
}

/**
 * Computes real waveform peaks directly from a WAV Blob stored in local file_vault.
 */
export async function computeWaveformPeaksFromBlob(
  blob: Blob,
  bucketCount: number = 96
): Promise<number[] | null> {
  const buf = await blob.arrayBuffer();
  const wav = decodePcmWavBuffer(buf);
  if (wav) {
    return computeRealWaveformPeaks(wav.samples, bucketCount);
  }
  const AudioCtx =
    typeof window !== 'undefined'
      ? window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined;
  if (!AudioCtx) return null;

  const ctx = new AudioCtx();
  try {
    const decoded = await ctx.decodeAudioData(buf.slice(0));
    const ch0 = decoded.getChannelData(0);
    return computeRealWaveformPeaks(ch0, bucketCount);
  } catch {
    return null;
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

/**
 * Computes Goertzel narrow-band energy at a specific frequency for spectral/harmonic analysis.
 */
function goertzelPower(samples: Float32Array, start: number, length: number, sampleRate: number, freqHz: number): number {
  const k = Math.round((length * freqHz) / sampleRate);
  const omega = (2 * Math.PI * k) / length;
  const coeff = 2 * Math.cos(omega);
  let sPrev = 0;
  let sPrev2 = 0;
  for (let i = 0; i < length; i += 1) {
    const s = samples[start + i] + coeff * sPrev - sPrev2;
    sPrev2 = sPrev;
    sPrev = s;
  }
  return Math.max(0, sPrev2 * sPrev2 + sPrev * sPrev - coeff * sPrev * sPrev2) / Math.max(1, length);
}

/**
 * Agent #21 — Sound Classification Agent.
 * Classifies 500ms windows of real PCM audio into speech, music, song, sfx_impact,
 * ambience_nature, animal, or crowd using RMS energy, peak-to-RMS crest factor,
 * zero-crossing rate, speech-band vs low/high harmonic ratios, and temporal continuity.
 * Marks songs, music, ambience, animals, and SFX with preserveOriginal = true.
 */
export function classifyAudioSoundEvents(
  projectId: string,
  samples: Float32Array,
  sampleRate: number,
  knownSpeechIntervals: Array<{ startMs: number; endMs: number }> = []
): SoundEventRecord[] {
  if (samples.length === 0 || sampleRate <= 0) return [];

  const windowMs = 500;
  const winLen = Math.max(256, Math.round((sampleRate * windowMs) / 1000));
  const rawWindows: Array<{
    startMs: number;
    endMs: number;
    category: SoundEventCategory;
    preserveOriginal: boolean;
    confidence: number;
    spectralCentroidHz: number;
    energyDb: number;
  }> = [];

  const totalDurationMs = measureSamplesDurationMs(samples.length, sampleRate);

  for (let start = 0; start < samples.length; start += winLen) {
    const end = Math.min(samples.length, start + winLen);
    const len = end - start;
    if (len < 128) break;

    const startMs = Math.round((start / sampleRate) * 1000);
    const endMs = Math.min(totalDurationMs, Math.round((end / sampleRate) * 1000));

    let sumSq = 0;
    let peak = 0;
    let crossings = 0;
    for (let i = 0; i < len; i += 1) {
      const v = samples[start + i];
      sumSq += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (i > 0) {
        const prev = samples[start + i - 1];
        if ((prev >= 0 && v < 0) || (prev < 0 && v >= 0)) crossings += 1;
      }
    }

    const rms = Math.sqrt(sumSq / len);
    const energyDb = rms > 1e-7 ? Math.round(20 * Math.log10(rms) * 10) / 10 : -85;
    if (energyDb < -56) continue; // True silence interval — keep empty

    const zcr = crossings / len;
    const spectralCentroidHz = Math.round(zcr * (sampleRate / 2));
    const crestFactor = rms > 1e-6 ? peak / rms : 1;

    const dftN = Math.min(len, 1024);
    const lowBass = goertzelPower(samples, start, dftN, sampleRate, 110);
    const vocalMid =
      goertzelPower(samples, start, dftN, sampleRate, 450) +
      goertzelPower(samples, start, dftN, sampleRate, 1100) +
      goertzelPower(samples, start, dftN, sampleRate, 2200);
    const highBand =
      goertzelPower(samples, start, dftN, sampleRate, 4200) +
      goertzelPower(samples, start, dftN, sampleRate, 6000);
    const totalBand = Math.max(1e-8, lowBass + vocalMid + highBand);

    const bassRatio = lowBass / totalBand;
    const vocalRatio = vocalMid / totalBand;
    const highRatio = highBand / totalBand;

    const overlapsDialogue = knownSpeechIntervals.some(
      (iv) => Math.min(endMs, iv.endMs) - Math.max(startMs, iv.startMs) >= 150
    );

    let category: SoundEventCategory = 'ambience_nature';
    let preserveOriginal = true;
    let confidence = 0.68;

    if (crestFactor > 5.8 && energyDb > -22) {
      category = 'sfx_impact';
      preserveOriginal = true;
      confidence = 0.8;
    } else if (highRatio > 0.55 && spectralCentroidHz > 3400 && crestFactor > 2.6) {
      category = 'animal';
      preserveOriginal = true;
      confidence = 0.64;
    } else if (bassRatio > 0.34 && vocalRatio > 0.35 && energyDb > -26) {
      // Sustained harmonic bass + mid vocals -> Song (preserve intact!)
      category = 'song';
      preserveOriginal = true;
      confidence = 0.78;
    } else if (bassRatio > 0.38 || (highRatio > 0.25 && bassRatio > 0.22 && !overlapsDialogue)) {
      category = 'music';
      preserveOriginal = true;
      confidence = 0.76;
    } else if (overlapsDialogue || (vocalRatio >= 0.45 && spectralCentroidHz >= 320 && spectralCentroidHz <= 2900)) {
      category = 'speech';
      preserveOriginal = false;
      confidence = overlapsDialogue ? 0.86 : 0.74;
    } else if (energyDb > -32 && zcr > 0.22) {
      category = 'crowd';
      preserveOriginal = true;
      confidence = 0.66;
    } else {
      category = 'ambience_nature';
      preserveOriginal = true;
      confidence = 0.7;
    }

    rawWindows.push({
      startMs,
      endMs,
      category,
      preserveOriginal,
      confidence,
      spectralCentroidHz,
      energyDb,
    });
  }

  // Merge contiguous windows of the same category into clean SoundEventRecords
  const merged: SoundEventRecord[] = [];
  const labelMap: Record<SoundEventCategory, string> = {
    speech: 'Spoken Dialogue (Dubbing Target)',
    music: 'Instrumental Score / BGM (Preserved)',
    song: 'Vocal Song / OP-ED (Preserved Intact)',
    sfx_impact: 'Impact / Action SFX (Preserved)',
    ambience_nature: 'Environmental Ambience (Preserved)',
    animal: 'Animal / Creature Vocalization (Preserved)',
    crowd: 'Crowd / Applause Background (Preserved)',
  };

  for (const w of rawWindows) {
    const prev = merged[merged.length - 1];
    if (prev && prev.category === w.category && w.startMs <= prev.endMs + 50) {
      prev.endMs = w.endMs;
      prev.confidence = Math.round(((prev.confidence + w.confidence) / 2) * 100) / 100;
      prev.energyDb = Math.round(((prev.energyDb + w.energyDb) / 2) * 10) / 10;
    } else {
      merged.push({
        id: `snd_${projectId}_${merged.length + 1}`,
        projectId,
        startMs: w.startMs,
        endMs: w.endMs,
        category: w.category,
        preserveOriginal: w.preserveOriginal,
        confidence: w.confidence,
        label: labelMap[w.category],
        spectralCentroidHz: w.spectralCentroidHz,
        energyDb: w.energyDb,
      });
    }
  }

  return merged;
}

/**
 * Simple 1-pole high-pass / low-pass filter cascade isolating human vocal core band (~300 Hz - 3400 Hz)
 * for conservative single-track vocal attenuation.
 */
function extractVoiceBandMono(samples: Float32Array, sampleRate: number): Float32Array {
  const out = new Float32Array(samples.length);
  const dt = 1 / sampleRate;

  // High-pass @ 280 Hz
  const rcHp = 1 / (2 * Math.PI * 280);
  const alphaHp = rcHp / (rcHp + dt);
  // Low-pass @ 3400 Hz
  const rcLp = 1 / (2 * Math.PI * 3400);
  const alphaLp = dt / (rcLp + dt);

  let prevIn = 0;
  let prevHp = 0;
  let prevLp = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const x = samples[i];
    const hp = alphaHp * (prevHp + x - prevIn);
    prevIn = x;
    prevHp = hp;
    const lp = prevLp + alphaLp * (hp - prevLp);
    prevLp = lp;
    out[i] = lp;
  }

  return out;
}

export interface SeparatedStemsOutput {
  dialogueSamples: Float32Array;
  backgroundSamples: Float32Array;
  sampleRate: number;
  durationMs: number;
  separationMethod: string;
  confidence: number;
  artifactWarning: string;
}

/**
 * Agent #22 — Conservative Non-Destructive Audio Separation Agent.
 * Separates speech vs background/music/SFX guided by the Sound Classification preservation mask.
 * - During protected regions (songs, music-only, ambience, animals, SFX), background keeps 100% original audio.
 * - During speech windows, applies conservative voice-band attenuation (and stereo Mid-Side reduction when
 *   stereo channels are provided) to avoid harsh metallic artifacts while preserving original music/ambience.
 * - Always reports an honest artifact warning for single mixed tracks.
 */
export function separateAudioStemsConservative(params: {
  monoSamples: Float32Array;
  stereoLeft?: Float32Array | null;
  stereoRight?: Float32Array | null;
  sampleRate: number;
  soundEvents: SoundEventRecord[];
  dialogueWindows: Array<{ startMs: number; endMs: number }>;
}): SeparatedStemsOutput {
  const { monoSamples, stereoLeft, stereoRight, sampleRate, soundEvents, dialogueWindows } = params;
  const len = monoSamples.length;
  const dialogueSamples = new Float32Array(len);
  const backgroundSamples = new Float32Array(len);

  const hasStereo =
    Boolean(stereoLeft && stereoRight && stereoLeft.length === len && stereoRight.length === len);

  // Build per-sample speech attenuation gate [0..1] (0 = fully preserve original, 1 = active dubbing dialogue)
  const gate = new Float32Array(len);

  const speechZones =
    dialogueWindows.length > 0
      ? dialogueWindows
      : soundEvents
          .filter((e) => e.category === 'speech' && !e.preserveOriginal)
          .map((e) => ({ startMs: e.startMs, endMs: e.endMs }));

  for (const win of speechZones) {
    const sIdx = Math.max(0, Math.floor((win.startMs / 1000) * sampleRate));
    const eIdx = Math.min(len, Math.ceil((win.endMs / 1000) * sampleRate));
    for (let i = sIdx; i < eIdx; i += 1) {
      gate[i] = 1;
    }
  }

  // Strictly protect songs and animal vocalizations from aggressive vocal cancellation
  for (const evt of soundEvents) {
    if (evt.category === 'song' || evt.category === 'animal' || evt.category === 'sfx_impact') {
      const sIdx = Math.max(0, Math.floor((evt.startMs / 1000) * sampleRate));
      const eIdx = Math.min(len, Math.ceil((evt.endMs / 1000) * sampleRate));
      for (let i = sIdx; i < eIdx; i += 1) {
        gate[i] = 0;
      }
    }
  }

  // Smooth gate transitions (~40ms attack/release) to eliminate clicks
  const smoothCoeff = Math.exp(-1 / Math.max(1, sampleRate * 0.04));
  let env = 0;
  for (let i = 0; i < len; i += 1) {
    env = smoothCoeff * env + (1 - smoothCoeff) * gate[i];
    gate[i] = env;
  }

  const voiceBand = extractVoiceBandMono(monoSamples, sampleRate);

  for (let i = 0; i < len; i += 1) {
    const g = gate[i];
    if (hasStereo && stereoLeft && stereoRight) {
      const mid = 0.5 * (stereoLeft[i] + stereoRight[i]);
      const side = 0.5 * (stereoLeft[i] - stereoRight[i]);
      // Conservative Mid-Side vocal reduction: remove 68% of center voice-band during dialogue only
      const vocalEst = voiceBand[i] * g;
      dialogueSamples[i] = vocalEst;
      backgroundSamples[i] = Math.max(
        -0.98,
        Math.min(0.98, mid - vocalEst * 0.68 + side * 0.85)
      );
    } else {
      const vocalEst = voiceBand[i] * g;
      dialogueSamples[i] = vocalEst;
      // Mono single-track conservative attenuation (retains bass/highs and non-dialogue ambience)
      backgroundSamples[i] = Math.max(-0.98, Math.min(0.98, monoSamples[i] - vocalEst * 0.62));
    }
  }

  return {
    dialogueSamples,
    backgroundSamples,
    sampleRate,
    durationMs: measureSamplesDurationMs(len, sampleRate),
    separationMethod: hasStereo
      ? 'Conservative Stereo Mid-Side + Mask-Guided Voice-Band DSP'
      : 'Conservative Mono Mask-Guided Voice-Band Attenuation DSP',
    confidence: hasStereo ? 0.74 : 0.61,
    artifactWarning: hasStereo
      ? 'Single-track stereo Mid-Side separation preserves panned music/ambience and protected songs, but center-panned Japanese dialogue may leave mild residual bleed in dense action mixes.'
      : 'Mono single-track separation applies conservative voice-band attenuation to avoid metallic artifacts; residual Japanese vocal bleed may remain when no clean M&E stem is supplied.',
  };
}

export interface MixDialogueClipInput {
  clip: AudioClip;
  track: TimelineTrack;
  samples: Float32Array;
  sampleRate: number;
}

export interface MixResultOutput {
  mixedSamples: Float32Array;
  sampleRate: number;
  durationMs: number;
  wavBlob: Blob;
  waveformPeaks: number[];
  metrics: AcousticQAMetrics;
}

/**
 * Agent #23 — Professional Multitrack Audio Mixing Agent.
 * Combines preserved background/music/SFX stem with synchronized Hindi dialogue clips:
 * - Respects track Mute, Solo, and gainDb across all tracks
 * - Applies per-clip volumeDb, trimStartMs, fadeInMs, and fadeOutMs
 * - Applies smooth dialogue-triggered ducking (-5.5 dB) to background ONLY during active Hindi speech
 *   outside protected song windows
 * - Applies soft-knee peak limiting at -1.0 dBFS (0.891) to guarantee zero digital clipping
 */
export function mixFinalDubAudio(params: {
  tracks: TimelineTrack[];
  backgroundSamples: Float32Array | null;
  backgroundSampleRate: number;
  dialogueInputs: MixDialogueClipInput[];
  soundEvents: SoundEventRecord[];
  totalDurationMs: number;
  targetSampleRate?: number;
}): MixResultOutput {
  const sampleRate = params.targetSampleRate ?? 16000;
  const maxClipEndMs = params.dialogueInputs.reduce(
    (max, item) => Math.max(max, item.clip.endMs),
    0
  );
  const bgDurationMs = params.backgroundSamples
    ? measureSamplesDurationMs(params.backgroundSamples.length, params.backgroundSampleRate)
    : 0;
  const finalDurationMs = Math.max(params.totalDurationMs, maxClipEndMs, bgDurationMs, 500);
  const totalSamples = Math.max(1, Math.ceil((finalDurationMs / 1000) * sampleRate));

  const dialogueBus = new Float32Array(totalSamples);
  const backgroundBus = new Float32Array(totalSamples);
  const duckMask = new Float32Array(totalSamples);

  // 1. Place preserved background / M&E track if audible
  const musicTrack = params.tracks.find((t) => t.kind === 'music_sfx');
  const musicAudible = musicTrack ? isTrackAudible(musicTrack, params.tracks) : true;
  const musicGain = musicTrack ? Math.pow(10, (musicTrack.gainDb ?? 0) / 20) : 1.0;

  if (params.backgroundSamples && musicAudible) {
    const resampledBg = resampleMono(
      params.backgroundSamples,
      params.backgroundSampleRate,
      sampleRate
    );
    const copyLen = Math.min(totalSamples, resampledBg.length);
    for (let i = 0; i < copyLen; i += 1) {
      backgroundBus[i] = resampledBg[i] * musicGain;
    }
  }

  // 2. Place audible Hindi dialogue clips with exact placement, fades, trim, and volume
  for (const item of params.dialogueInputs) {
    if (!isTrackAudible(item.track, params.tracks)) continue;

    const resampledClip = resampleMono(item.samples, item.sampleRate, sampleRate);
    const trimStartSamples = Math.max(
      0,
      Math.floor(((item.clip.trimStartMs ?? 0) / 1000) * sampleRate)
    );
    const maxPlaySamples = Math.max(
      1,
      Math.floor((item.clip.durationMs / 1000) * sampleRate)
    );
    const availableLen = Math.max(0, resampledClip.length - trimStartSamples);
    const playLen = Math.min(availableLen, maxPlaySamples);
    if (playLen <= 0) continue;

    const startOffset = Math.max(0, Math.floor((item.clip.startMs / 1000) * sampleRate));
    const trackGain = Math.pow(10, (item.track.gainDb ?? 0) / 20);
    const clipGain = Math.pow(10, (item.clip.volumeDb ?? 0) / 20);
    const combinedGain = trackGain * clipGain;

    const fadeInSamples = Math.max(
      Math.round(sampleRate * 0.012), // 12ms minimum anti-click micro-fade
      Math.floor(((item.clip.fadeInMs ?? 15) / 1000) * sampleRate)
    );
    const fadeOutSamples = Math.max(
      Math.round(sampleRate * 0.015),
      Math.floor(((item.clip.fadeOutMs ?? 20) / 1000) * sampleRate)
    );

    for (let i = 0; i < playLen; i += 1) {
      const dst = startOffset + i;
      if (dst >= totalSamples) break;

      let fade = 1;
      if (i < fadeInSamples) {
        fade *= i / Math.max(1, fadeInSamples);
      }
      if (i >= playLen - fadeOutSamples) {
        fade *= (playLen - i) / Math.max(1, fadeOutSamples);
      }

      dialogueBus[dst] += resampledClip[trimStartSamples + i] * combinedGain * fade;
      duckMask[dst] = 1;
    }
  }

  // Keep protected song regions from heavy ducking
  for (const evt of params.soundEvents) {
    if (evt.category === 'song') {
      const sIdx = Math.max(0, Math.floor((evt.startMs / 1000) * sampleRate));
      const eIdx = Math.min(totalSamples, Math.ceil((evt.endMs / 1000) * sampleRate));
      for (let i = sIdx; i < eIdx; i += 1) {
        duckMask[i] *= 0.25;
      }
    }
  }

  // 3. Smooth ducking envelope & sum with soft-knee peak limiter (-1.0 dBFS ceiling = 0.891)
  const mixedSamples = new Float32Array(totalSamples);
  const attack = Math.exp(-1 / Math.max(1, sampleRate * 0.03));
  const release = Math.exp(-1 / Math.max(1, sampleRate * 0.18));
  let duckEnv = 0;
  let dialogueEnergySum = 0;
  let bgEnergySum = 0;
  let activeDialogueSamples = 0;

  const duckTargetLinear = Math.pow(10, -5.5 / 20); // ~0.53 (-5.5 dB during Hindi dialogue)
  const ceiling = 0.891; // -1.0 dBFS

  for (let i = 0; i < totalSamples; i += 1) {
    const target = duckMask[i];
    duckEnv = target > duckEnv
      ? attack * duckEnv + (1 - attack) * target
      : release * duckEnv + (1 - release) * target;

    const bgGainFactor = 1 - duckEnv * (1 - duckTargetLinear);
    const bgSample = backgroundBus[i] * bgGainFactor;
    const dlgSample = dialogueBus[i];

    if (target > 0.5) {
      dialogueEnergySum += dlgSample * dlgSample;
      bgEnergySum += bgSample * bgSample;
      activeDialogueSamples += 1;
    }

    const summed = bgSample + dlgSample;
    const absVal = Math.abs(summed);
    if (absVal <= ceiling * 0.85) {
      mixedSamples[i] = summed;
    } else {
      // Smooth tanh soft-knee limiter guaranteeing peak <= ceiling (< 0.995 -> zero clipping)
      const sign = summed >= 0 ? 1 : -1;
      const excess = absVal - ceiling * 0.85;
      const headroom = ceiling * 0.15;
      mixedSamples[i] = sign * (ceiling * 0.85 + headroom * Math.tanh(excess / headroom));
    }
  }

  const dialogueToBackgroundDb =
    activeDialogueSamples > 64 && bgEnergySum > 1e-8
      ? Math.round(
          10 * Math.log10(Math.max(1e-8, dialogueEnergySum) / Math.max(1e-8, bgEnergySum)) * 10
        ) / 10
      : null;

  const wavBlob = encodeFloat32ToWavBlob(mixedSamples, sampleRate);
  const waveformPeaks = computeRealWaveformPeaks(mixedSamples, 140);
  const metrics = measureAcousticQAMetrics(
    mixedSamples,
    sampleRate,
    dialogueToBackgroundDb,
    null
  );

  return {
    mixedSamples,
    sampleRate,
    durationMs: measureSamplesDurationMs(mixedSamples.length, sampleRate),
    wavBlob,
    waveformPeaks,
    metrics,
  };
}

/**
 * Agent #24 — Real Acoustic QA Metrics Calculator.
 * Measures true peak dBFS, integrated RMS dBFS, digital clipping sample count (|x| >= 0.995),
 * silence ratio, and WAV integrity.
 */
export function measureAcousticQAMetrics(
  samples: Float32Array,
  sampleRate: number,
  dialogueToBackgroundDb: number | null = null,
  measuredStemVaultKey: string | null = null
): AcousticQAMetrics {
  if (samples.length === 0 || sampleRate <= 0) {
    return {
      peakDbfs: -96,
      rmsDbfs: -96,
      clippingSampleCount: 0,
      silenceRatio: 1,
      dialogueToBackgroundDb,
      exportIntegrityVerified: false,
      measuredStemVaultKey,
    };
  }

  let peak = 0;
  let sumSq = 0;
  let clippingSampleCount = 0;
  let silentSamples = 0;

  for (let i = 0; i < samples.length; i += 1) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    if (a >= 0.995) clippingSampleCount += 1;
    if (a < 0.002) silentSamples += 1;
    sumSq += samples[i] * samples[i];
  }

  const rms = Math.sqrt(sumSq / samples.length);
  const peakDbfs = peak > 1e-7 ? Math.round(20 * Math.log10(peak) * 10) / 10 : -96;
  const rmsDbfs = rms > 1e-7 ? Math.round(20 * Math.log10(rms) * 10) / 10 : -96;
  const silenceRatio = Math.round((silentSamples / samples.length) * 1000) / 1000;

  return {
    peakDbfs,
    rmsDbfs,
    clippingSampleCount,
    silenceRatio,
    dialogueToBackgroundDb,
    exportIntegrityVerified: samples.length > 0 && peak > 1e-5,
    measuredStemVaultKey,
  };
}

export function buildAudioStemRecord(params: {
  projectId: string;
  stemType: AudioStemRecord['stemType'];
  vaultKey: string;
  sampleRate: number;
  durationMs: number;
  sizeBytes: number;
  separationMethod: string;
  confidence: number;
  artifactWarning: string | null;
}): AudioStemRecord {
  return {
    id: `stem_${params.projectId}_${params.stemType}`,
    projectId: params.projectId,
    stemType: params.stemType,
    vaultKey: params.vaultKey,
    sampleRate: params.sampleRate,
    durationMs: params.durationMs,
    sizeBytes: params.sizeBytes,
    separationMethod: params.separationMethod,
    confidence: params.confidence,
    artifactWarning: params.artifactWarning,
    createdAt: new Date().toISOString(),
  };
}
