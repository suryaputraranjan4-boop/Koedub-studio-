import type { VoiceCharacteristics } from '../../types/domain';

export interface DecodedAudioMono {
  samples: Float32Array;
  sampleRate: number;
  durationMs: number;
}

export interface SpeechInterval {
  startMs: number;
  endMs: number;
  energyDb: number;
  overlapping: boolean;
}

export interface SpeakerClusterSegment {
  startMs: number;
  endMs: number;
  speakerLabel: string;
  confidence: number;
  overlapping: boolean;
  embedding: number[];
}

/**
 * Encodes mono Float32Array PCM samples [-1, 1] into a standard 16-bit PCM RIFF/WAV ArrayBuffer.
 */
export function encodeFloat32ToWavBuffer(
  samples: Float32Array,
  sampleRate: number
): ArrayBuffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i += 1) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    const int16 = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(offset, int16, true);
    offset += 2;
  }

  return buffer;
}

export function encodeFloat32ToWavBlob(
  samples: Float32Array,
  sampleRate: number
): Blob {
  return new Blob([encodeFloat32ToWavBuffer(samples, sampleRate)], {
    type: 'audio/wav',
  });
}

/**
 * Decodes a 16-bit PCM RIFF/WAV ArrayBuffer deterministically without AudioContext resampling.
 */
export function decodePcmWavBuffer(buffer: ArrayBuffer): DecodedAudioMono | null {
  if (buffer.byteLength < 44) return null;
  const view = new DataView(buffer);
  const riff = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3)
  );
  const wave = String.fromCharCode(
    view.getUint8(8),
    view.getUint8(9),
    view.getUint8(10),
    view.getUint8(11)
  );
  if (riff !== 'RIFF' || wave !== 'WAVE') return null;

  let offset = 12;
  let sampleRate = 16000;
  let channels = 1;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3)
    );
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ' && offset + 24 <= view.byteLength) {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataSize = Math.min(size, view.byteLength - dataOffset);
      break;
    }
    offset += 8 + size + (size % 2);
  }

  if (dataOffset < 0 || bitsPerSample !== 16 || sampleRate <= 0) return null;

  const totalFrames = Math.floor(dataSize / (2 * Math.max(1, channels)));
  const samples = new Float32Array(totalFrames);
  let readPos = dataOffset;

  for (let i = 0; i < totalFrames; i += 1) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      sum += view.getInt16(readPos, true) / 32768;
      readPos += 2;
    }
    samples[i] = sum / channels;
  }

  return {
    samples,
    sampleRate,
    durationMs: measureSamplesDurationMs(samples.length, sampleRate),
  };
}

export function measureSamplesDurationMs(sampleCount: number, sampleRate: number): number {
  if (sampleRate <= 0 || sampleCount <= 0) return 0;
  return Math.round((sampleCount / sampleRate) * 1000);
}

/**
 * Resamples mono Float32Array to target sample rate (e.g. 16000 Hz for Whisper / PyAnnote).
 */
export function resampleMono(
  samples: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i += 1) {
    const srcIdx = i * ratio;
    const low = Math.floor(srcIdx);
    const high = Math.min(samples.length - 1, low + 1);
    const frac = srcIdx - low;
    out[i] = samples[low] * (1 - frac) + samples[high] * frac;
  }
  return out;
}

/**
 * Browser media blob decoder returning 16 kHz mono Float32Array.
 */
export async function decodeMediaBlobToMono16k(blob: Blob): Promise<DecodedAudioMono> {
  const arrayBuffer = await blob.arrayBuffer();

  // Fast deterministic path for 16-bit PCM WAV files
  const wavDecoded = decodePcmWavBuffer(arrayBuffer);
  if (wavDecoded) {
    const resampled = resampleMono(wavDecoded.samples, wavDecoded.sampleRate, 16000);
    return {
      samples: resampled,
      sampleRate: 16000,
      durationMs: measureSamplesDurationMs(resampled.length, 16000),
    };
  }

  const AudioCtx =
    typeof window !== 'undefined'
      ? window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined;

  if (!AudioCtx) {
    throw new Error('Web Audio API is unavailable in this environment to decode audio streams.');
  }

  const ctx = new AudioCtx();
  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const numChannels = decoded.numberOfChannels;
    const length = decoded.length;
    const mono = new Float32Array(length);

    for (let ch = 0; ch < numChannels; ch += 1) {
      const channelData = decoded.getChannelData(ch);
      for (let i = 0; i < length; i += 1) {
        mono[i] += channelData[i] / numChannels;
      }
    }

    const resampled = resampleMono(mono, decoded.sampleRate, 16000);
    return {
      samples: resampled,
      sampleRate: 16000,
      durationMs: measureSamplesDurationMs(resampled.length, 16000),
    };
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

/**
 * Energy + Zero-Crossing Voice Activity Detection returning non-silent speech windows.
 * Never fabricates speech intervals if the signal is silent.
 */
export function detectVoiceActivitySegments(
  samples: Float32Array,
  sampleRate: number
): SpeechInterval[] {
  if (samples.length === 0 || sampleRate <= 0) return [];

  const frameMs = 50;
  const frameLen = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const frameEnergies: number[] = [];

  for (let start = 0; start < samples.length; start += frameLen) {
    const end = Math.min(samples.length, start + frameLen);
    let sumSq = 0;
    for (let i = start; i < end; i += 1) {
      sumSq += samples[i] * samples[i];
    }
    const rms = Math.sqrt(sumSq / Math.max(1, end - start));
    const db = rms > 1e-7 ? 20 * Math.log10(rms) : -90;
    frameEnergies.push(db);
  }

  // Adaptive noise floor (20th percentile) + speech threshold
  const sortedDb = [...frameEnergies].sort((a, b) => a - b);
  const noiseFloorDb = sortedDb[Math.floor(sortedDb.length * 0.2)] ?? -65;
  const speechThresholdDb = Math.max(-48, noiseFloorDb + 9);

  const intervals: SpeechInterval[] = [];
  let inSpeech = false;
  let segStartFrame = 0;
  let silenceFrames = 0;
  const maxBridgeSilenceFrames = 6; // 300ms pause tolerance

  for (let f = 0; f < frameEnergies.length; f += 1) {
    const active = frameEnergies[f] >= speechThresholdDb;
    if (active) {
      if (!inSpeech) {
        inSpeech = true;
        segStartFrame = f;
      }
      silenceFrames = 0;
    } else if (inSpeech) {
      silenceFrames += 1;
      if (silenceFrames > maxBridgeSilenceFrames) {
        const endFrame = f - silenceFrames + 1;
        const durationFrames = endFrame - segStartFrame;
        if (durationFrames >= 4) {
          const avgDb =
            frameEnergies
              .slice(segStartFrame, endFrame)
              .reduce((a, b) => a + b, 0) / durationFrames;
          intervals.push({
            startMs: segStartFrame * frameMs,
            endMs: Math.min(measureSamplesDurationMs(samples.length, sampleRate), endFrame * frameMs),
            energyDb: Math.round(avgDb * 10) / 10,
            overlapping: false,
          });
        }
        inSpeech = false;
        silenceFrames = 0;
      }
    }
  }

  if (inSpeech) {
    const endFrame = frameEnergies.length;
    const durationFrames = endFrame - segStartFrame;
    if (durationFrames >= 4) {
      const avgDb =
        frameEnergies
          .slice(segStartFrame, endFrame)
          .reduce((a, b) => a + b, 0) / durationFrames;
      intervals.push({
        startMs: segStartFrame * frameMs,
        endMs: measureSamplesDurationMs(samples.length, sampleRate),
        energyDb: Math.round(avgDb * 10) / 10,
        overlapping: false,
      });
    }
  }

  return intervals;
}

/**
 * Estimates fundamental frequency (F0 in Hz) on a single window via normalized autocorrelation.
 */
function estimateWindowPitchHz(
  samples: Float32Array,
  start: number,
  length: number,
  sampleRate: number
): number | null {
  const minLag = Math.floor(sampleRate / 420); // 420 Hz max human F0
  const maxLag = Math.min(Math.floor(length / 2), Math.floor(sampleRate / 65)); // 65 Hz min F0
  if (maxLag <= minLag) return null;

  let energy = 0;
  for (let i = 0; i < length; i += 1) {
    const v = samples[start + i];
    energy += v * v;
  }
  if (energy < 1e-4) return null;

  let bestLag = -1;
  let bestCorr = 0;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    const limit = length - lag;
    for (let i = 0; i < limit; i += 1) {
      const a = samples[start + i];
      const b = samples[start + i + lag];
      dot += a * b;
      normA += a * a;
      normB += b * b;
    }
    const denom = Math.sqrt(normA * normB);
    const corr = denom > 1e-8 ? dot / denom : 0;
    if (corr > bestCorr) {
      bestCorr = corr;
      bestLag = lag;
    }
  }

  if (bestLag > 0 && bestCorr >= 0.48) {
    return sampleRate / bestLag;
  }
  return null;
}

/**
 * Extracts a compact deterministic 10-dimensional acoustic speaker embedding vector
 * (F0 pitch statistics, ZCR, spectral band ratios across 6 frequency bands, RMS profile)
 * for cosine-similarity recurring speaker clustering.
 */
export function extractAcousticSpeakerEmbedding(
  samples: Float32Array,
  sampleRate: number
): number[] {
  if (samples.length < 256) return new Array(10).fill(0);

  // 1. Pitch statistics across 40ms frames
  const winLen = Math.min(samples.length, Math.round(sampleRate * 0.04));
  const step = Math.max(128, Math.round(winLen / 2));
  const pitches: number[] = [];
  let zcrSum = 0;
  let rmsSum = 0;
  let frameCount = 0;

  for (let pos = 0; pos + winLen <= samples.length; pos += step) {
    const f0 = estimateWindowPitchHz(samples, pos, winLen, sampleRate);
    if (f0 !== null) pitches.push(f0);

    let crossings = 0;
    let sq = 0;
    for (let i = 1; i < winLen; i += 1) {
      const prev = samples[pos + i - 1];
      const curr = samples[pos + i];
      if ((prev >= 0 && curr < 0) || (prev < 0 && curr >= 0)) crossings += 1;
      sq += curr * curr;
    }
    zcrSum += crossings / winLen;
    rmsSum += Math.sqrt(sq / winLen);
    frameCount += 1;
    if (frameCount >= 40) break; // bounded cost for long segments
  }

  const meanPitch =
    pitches.length > 0
      ? pitches.reduce((a, b) => a + b, 0) / pitches.length
      : 160;
  const pitchStd =
    pitches.length > 1
      ? Math.sqrt(
          pitches.reduce((acc, p) => acc + Math.pow(p - meanPitch, 2), 0) /
            pitches.length
        )
      : 15;

  // 2. 6-band Goertzel spectral energy profile (200, 500, 1000, 2000, 3500, 5500 Hz)
  const targetFreqs = [200, 500, 1000, 2000, 3500, 5500];
  const dftLen = Math.min(samples.length, 2048);
  const bandEnergies = targetFreqs.map((freq) => {
    const k = Math.round((dftLen * freq) / sampleRate);
    const omega = (2 * Math.PI * k) / dftLen;
    const coeff = 2 * Math.cos(omega);
    let sPrev = 0;
    let sPrev2 = 0;
    for (let i = 0; i < dftLen; i += 1) {
      const s = samples[i] + coeff * sPrev - sPrev2;
      sPrev2 = sPrev;
      sPrev = s;
    }
    const power = Math.max(0, sPrev2 * sPrev2 + sPrev * sPrev - coeff * sPrev * sPrev2);
    return Math.log10(1 + power);
  });

  const rawVec = [
    meanPitch / 350,
    pitchStd / 100,
    (zcrSum / Math.max(1, frameCount)) * 4,
    (rmsSum / Math.max(1, frameCount)) * 3,
    ...bandEnergies,
  ];

  // L2 normalize for cosine similarity
  const norm = Math.sqrt(rawVec.reduce((acc, v) => acc + v * v, 0)) || 1;
  return rawVec.map((v) => v / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA * normB);
  return denom > 1e-8 ? dot / denom : 0;
}

/**
 * Speaker Diarization clustering: groups recurring turns by acoustic embedding similarity
 * so the same speaker keeps a persistent SPK_01 / SPK_02 ID across scenes instead of spawning
 * a new Speaker ID per sentence.
 */
export function clusterSpeakerIntervals(
  samples: Float32Array,
  sampleRate: number,
  intervals: SpeechInterval[],
  similarityThreshold: number = 0.89
): SpeakerClusterSegment[] {
  const centroids: Array<{ label: string; vec: number[]; count: number }> = [];
  const results: SpeakerClusterSegment[] = [];

  for (const interval of intervals) {
    const startIdx = Math.max(0, Math.floor((interval.startMs / 1000) * sampleRate));
    const endIdx = Math.min(
      samples.length,
      Math.ceil((interval.endMs / 1000) * sampleRate)
    );
    const slice = samples.subarray(startIdx, endIdx);
    const embedding = extractAcousticSpeakerEmbedding(slice, sampleRate);

    let bestIdx = -1;
    let bestSim = -1;
    for (let i = 0; i < centroids.length; i += 1) {
      const sim = cosineSimilarity(embedding, centroids[i].vec);
      if (sim > bestSim) {
        bestSim = sim;
        bestIdx = i;
      }
    }

    let label: string;
    let confidence: number;

    if (bestIdx >= 0 && bestSim >= similarityThreshold) {
      const cluster = centroids[bestIdx];
      label = cluster.label;
      confidence = Math.min(0.95, Math.max(0.55, bestSim));
      // Running centroid update
      const nextCount = cluster.count + 1;
      cluster.vec = cluster.vec.map(
        (val, dim) => (val * cluster.count + embedding[dim]) / nextCount
      );
      cluster.count = nextCount;
    } else {
      const nextNum = centroids.length + 1;
      label = `SPK_${String(nextNum).padStart(2, '0')}`;
      confidence = centroids.length === 0 ? 0.8 : 0.72;
      centroids.push({ label, vec: embedding, count: 1 });
    }

    results.push({
      startMs: interval.startMs,
      endMs: interval.endMs,
      speakerLabel: label,
      confidence: Math.round(confidence * 100) / 100,
      overlapping: interval.overlapping,
      embedding,
    });
  }

  return results;
}

/**
 * Voice Analysis Agent (#8): computes real acoustic measurements on a speaker's PCM turns.
 * Explicitly estimates audible vocal presentation without making identity assumptions.
 */
export function analyzeVoiceAcoustics(
  samples: Float32Array,
  sampleRate: number,
  spokenCharCount: number = 0
): VoiceCharacteristics {
  if (samples.length < 256 || sampleRate <= 0) {
    return {
      pitchRange: 'Unmeasured',
      timbre: 'Unmeasured',
      pacing: 'Unmeasured',
      ageEstimate: 'Uncertain',
      genderPresentation: 'Uncertain',
      acousticMeasurementSource: 'unmeasured',
    };
  }

  const winLen = Math.min(samples.length, Math.round(sampleRate * 0.04));
  const step = Math.max(160, Math.round(winLen / 2));
  const pitches: number[] = [];
  let sumSq = 0;
  let crossings = 0;
  let activeFrames = 0;
  let totalFrames = 0;

  for (let pos = 0; pos + winLen <= samples.length; pos += step) {
    let frameSq = 0;
    for (let i = 0; i < winLen; i += 1) {
      const v = samples[pos + i];
      frameSq += v * v;
      if (i > 0) {
        const prev = samples[pos + i - 1];
        if ((prev >= 0 && v < 0) || (prev < 0 && v >= 0)) crossings += 1;
      }
    }
    const frameRms = Math.sqrt(frameSq / winLen);
    sumSq += frameSq;
    totalFrames += 1;
    if (frameRms > 0.015) {
      activeFrames += 1;
      const f0 = estimateWindowPitchHz(samples, pos, winLen, sampleRate);
      if (f0 !== null) pitches.push(f0);
    }
    if (totalFrames >= 120) break;
  }

  const rms = Math.sqrt(sumSq / Math.max(1, totalFrames * winLen));
  const energyDb = rms > 1e-7 ? Math.round(20 * Math.log10(rms) * 10) / 10 : -80;
  const zcr = crossings / Math.max(1, totalFrames * winLen);
  const spectralCentroidHz = Math.round(zcr * (sampleRate / 2));

  pitches.sort((a, b) => a - b);
  const pitchMinHz = pitches.length > 0 ? Math.round(pitches[Math.floor(pitches.length * 0.1)]) : null;
  const pitchMaxHz = pitches.length > 0 ? Math.round(pitches[Math.floor(pitches.length * 0.9)]) : null;
  const pitchMeanHz =
    pitches.length > 0
      ? Math.round(pitches.reduce((a, b) => a + b, 0) / pitches.length)
      : null;
  const pitchVariationHz =
    pitchMinHz !== null && pitchMaxHz !== null ? Math.max(0, pitchMaxHz - pitchMinHz) : null;

  const durationSec = Math.max(0.25, samples.length / sampleRate);
  const speakingRateCps =
    spokenCharCount > 0 ? Math.round((spokenCharCount / durationSec) * 10) / 10 : null;
  const speechDutyCycle = activeFrames / Math.max(1, totalFrames);

  // Cautious audible vocal-presentation estimates (never identity assertions)
  let genderPresentation = 'Uncertain / Neutral vocal presentation';
  let ageEstimate = 'Adult-sounding (estimate)';

  if (pitchMeanHz !== null) {
    if (pitchMeanHz >= 275) {
      ageEstimate = 'Child-like or high-register vocal presentation (estimate)';
      genderPresentation = 'High-register / Feminine-leaning (estimate)';
    } else if (pitchMeanHz >= 190) {
      ageEstimate =
        spectralCentroidHz > 1800
          ? 'Teen-like or young adult vocal presentation (estimate)'
          : 'Adult-sounding (estimate)';
      genderPresentation = 'Feminine-leaning vocal presentation (estimate)';
    } else if (pitchMeanHz >= 145) {
      ageEstimate = 'Teen-like or adult vocal presentation (estimate)';
      genderPresentation = 'Androgynous / Mid-range vocal presentation (estimate)';
    } else {
      ageEstimate =
        pitchVariationHz !== null && pitchVariationHz < 35
          ? 'Mature / Elderly-leaning or calm adult (estimate)'
          : 'Adult-sounding (estimate)';
      genderPresentation = 'Masculine-leaning vocal presentation (estimate)';
    }
  }

  const timbre =
    spectralCentroidHz > 2100
      ? 'Bright / crisp timbre'
      : spectralCentroidHz > 1200
      ? 'Balanced / clear timbre'
      : 'Warm / dark resonance';

  const voiceTexture =
    zcr > 0.18
      ? 'Airy / breathy texture'
      : zcr > 0.08
      ? 'Clear modal texture'
      : 'Dense / chest-resonant texture';

  const pacing =
    speakingRateCps !== null
      ? speakingRateCps > 7.5
        ? `Fast (${speakingRateCps} chars/s)`
        : speakingRateCps > 4.2
        ? `Moderate (${speakingRateCps} chars/s)`
        : `Measured (${speakingRateCps} chars/s)`
      : speechDutyCycle > 0.72
      ? 'Dense / continuous cadence'
      : 'Measured / paused cadence';

  return {
    pitchRange:
      pitchMinHz !== null && pitchMaxHz !== null
        ? `${pitchMinHz}–${pitchMaxHz} Hz (mean ${pitchMeanHz} Hz)`
        : 'Unvoiced / low-SNR audio',
    timbre,
    pacing,
    ageEstimate,
    genderPresentation,
    pitchMinHz,
    pitchMaxHz,
    pitchMeanHz,
    pitchVariationHz,
    spectralCentroidHz,
    energyDb,
    speakingRateCps,
    voiceTexture,
    rhythm: speechDutyCycle > 0.7 ? 'Rapid continuous rhythm' : 'Conversational paused rhythm',
    resonance: spectralCentroidHz < 1300 ? 'Low / chest resonance' : 'Mid-upper resonance',
    speechStyle:
      energyDb > -14
        ? 'High-projection / intense delivery'
        : energyDb < -30
        ? 'Soft / low-volume delivery'
        : 'Conversational studio level',
    vocalCategoryEstimate: `${ageEstimate} · ${genderPresentation}`,
    acousticMeasurementSource: 'web_audio_dsp',
  };
}

/**
 * Post-synthesis Web Audio DSP adjustment for Voice Acting (#19) & Synchronization (#20).
 * Keeps speed bounded strictly within [0.85, 1.18] so speech remains natural.
 */
export function applyPostSynthesisDsp(
  samples: Float32Array,
  sampleRate: number,
  options: {
    rateMultiplier?: number;
    pitchSemitones?: number;
    gainDb?: number;
    pausePaddingMs?: number;
  }
): { samples: Float32Array; sampleRate: number; durationMs: number } {
  const rate = Math.min(1.18, Math.max(0.85, options.rateMultiplier ?? 1.0));
  const pitchFactor = Math.pow(2, Math.min(3.5, Math.max(-3.5, options.pitchSemitones ?? 0)) / 12);
  // Modest combined playback factor bounded so output stays intelligible
  const combinedFactor = Math.min(1.22, Math.max(0.82, rate * (1 + (pitchFactor - 1) * 0.45)));

  const outCoreLen = Math.max(1, Math.round(samples.length / combinedFactor));
  const padSamples = Math.max(
    0,
    Math.round(((options.pausePaddingMs ?? 0) / 1000) * sampleRate)
  );
  const gainLinear = Math.pow(10, Math.min(6, Math.max(-12, options.gainDb ?? 0)) / 20);

  const output = new Float32Array(outCoreLen + padSamples);
  for (let i = 0; i < outCoreLen; i += 1) {
    const srcPos = i * combinedFactor;
    const low = Math.floor(srcPos);
    const high = Math.min(samples.length - 1, low + 1);
    const frac = srcPos - low;
    const val = (samples[low] * (1 - frac) + samples[high] * frac) * gainLinear;
    output[i] = Math.max(-0.98, Math.min(0.98, val));
  }

  return {
    samples: output,
    sampleRate,
    durationMs: measureSamplesDurationMs(output.length, sampleRate),
  };
}
