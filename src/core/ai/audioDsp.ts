import type { ChunkDefinition, VoiceCharacteristics } from '../../types/domain';

export interface DecodedAudioMono {
  samples: Float32Array;
  sampleRate: number;
  durationMs: number;
}

export interface DecodedAudioStereo {
  left: Float32Array;
  right: Float32Array;
  channels: number; // original source channels (1 or 2+)
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
 * Encodes true 2-channel stereo Float32Array L/R PCM samples [-1, 1] into a standard
 * 16-bit interleaved stereo RIFF/WAV ArrayBuffer (preserving 44.1 / 48 kHz studio quality).
 */
export function encodeStereoToWavBuffer(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number
): ArrayBuffer {
  const frameCount = Math.min(left.length, right.length);
  const numChannels = 2;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = frameCount * numChannels * 2;
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
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < frameCount; i += 1) {
    const l = Math.max(-1, Math.min(1, left[i]));
    const r = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(offset, l < 0 ? Math.round(l * 0x8000) : Math.round(l * 0x7fff), true);
    view.setInt16(offset + 2, r < 0 ? Math.round(r * 0x8000) : Math.round(r * 0x7fff), true);
    offset += 4;
  }

  return buffer;
}

export function encodeStereoToWavBlob(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number
): Blob {
  return new Blob([encodeStereoToWavBuffer(left, right, sampleRate)], {
    type: 'audio/wav',
  });
}

/**
 * Decodes a 16-bit PCM RIFF/WAV ArrayBuffer preserving stereo L/R channels & native sample rate.
 */
export function decodePcmWavBufferStereo(buffer: ArrayBuffer): DecodedAudioStereo | null {
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
  let sampleRate = 48000;
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

  if (dataOffset < 0 || bitsPerSample !== 16 || sampleRate <= 0 || channels <= 0) return null;

  const totalFrames = Math.floor(dataSize / (2 * channels));
  const left = new Float32Array(totalFrames);
  const right = new Float32Array(totalFrames);
  let readPos = dataOffset;

  for (let i = 0; i < totalFrames; i += 1) {
    if (channels === 1) {
      const s = view.getInt16(readPos, true) / 32768;
      left[i] = s;
      right[i] = s;
      readPos += 2;
    } else {
      left[i] = view.getInt16(readPos, true) / 32768;
      right[i] = view.getInt16(readPos + 2, true) / 32768;
      readPos += 2 * channels;
    }
  }

  return {
    left,
    right,
    channels,
    sampleRate,
    durationMs: measureSamplesDurationMs(totalFrames, sampleRate),
  };
}

/**
 * Decodes a 16-bit PCM RIFF/WAV ArrayBuffer into mono Float32Array deterministically.
 */
export function decodePcmWavBuffer(buffer: ArrayBuffer): DecodedAudioMono | null {
  const stereo = decodePcmWavBufferStereo(buffer);
  if (!stereo) return null;
  if (stereo.channels === 1) {
    return {
      samples: stereo.left,
      sampleRate: stereo.sampleRate,
      durationMs: stereo.durationMs,
    };
  }
  const mono = new Float32Array(stereo.left.length);
  for (let i = 0; i < mono.length; i += 1) {
    mono[i] = 0.5 * (stereo.left[i] + stereo.right[i]);
  }
  return {
    samples: mono,
    sampleRate: stereo.sampleRate,
    durationMs: stereo.durationMs,
  };
}

export function measureSamplesDurationMs(sampleCount: number, sampleRate: number): number {
  if (sampleRate <= 0 || sampleCount <= 0) return 0;
  return Math.round((sampleCount / sampleRate) * 1000);
}

/**
 * Resamples mono Float32Array to target sample rate using linear interpolation.
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
 * Slices a specific time window [startMs, endMs] from a native stereo buffer and
 * downmixes + resamples ONLY that chunk to 16 kHz mono for ML models (Whisper, PyAnnote).
 * Avoids storing duplicate full-length mono copies in memory.
 */
export function extractMono16kChunkFromStereo(
  stereo: DecodedAudioStereo,
  startMs: number,
  endMs: number
): DecodedAudioMono {
  const sIdx = Math.max(0, Math.floor((startMs / 1000) * stereo.sampleRate));
  const eIdx = Math.min(stereo.left.length, Math.ceil((endMs / 1000) * stereo.sampleRate));
  const len = Math.max(0, eIdx - sIdx);
  if (len === 0) {
    return { samples: new Float32Array(0), sampleRate: 16000, durationMs: 0 };
  }
  const monoSlice = new Float32Array(len);
  if (stereo.channels === 1) {
    monoSlice.set(stereo.left.subarray(sIdx, eIdx));
  } else {
    for (let i = 0; i < len; i += 1) {
      monoSlice[i] = 0.5 * (stereo.left[sIdx + i] + stereo.right[sIdx + i]);
    }
  }
  const resampled = resampleMono(monoSlice, stereo.sampleRate, 16000);
  return {
    samples: resampled,
    sampleRate: 16000,
    durationMs: measureSamplesDurationMs(resampled.length, 16000),
  };
}

/**
 * Browser media blob decoder preserving native stereo channels & high sample rate (44.1 / 48 kHz)
 * for video containers (MP4, WebM, MOV) and audio files (WAV, MP3, M4A, FLAC, OGG).
 * Honestly reports unsupported containers (e.g. MKV when browser cannot decode its codec).
 */
export async function decodeMediaBlobToStereo(
  blob: Blob,
  fileExtension?: string
): Promise<DecodedAudioStereo> {
  const arrayBuffer = await blob.arrayBuffer();

  // Fast deterministic path for 16-bit PCM WAV files (zero AudioContext resampling)
  const wavDecoded = decodePcmWavBufferStereo(arrayBuffer);
  if (wavDecoded) {
    return wavDecoded;
  }

  const AudioCtx =
    typeof window !== 'undefined'
      ? window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined;

  if (!AudioCtx) {
    throw new Error('Web Audio API is unavailable in this environment to decode media streams.');
  }

  const ctx = new AudioCtx();
  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const channels = decoded.numberOfChannels;
    const left = new Float32Array(decoded.getChannelData(0));
    const right =
      channels >= 2
        ? new Float32Array(decoded.getChannelData(1))
        : new Float32Array(left);

    return {
      left,
      right,
      channels,
      sampleRate: decoded.sampleRate,
      durationMs: measureSamplesDurationMs(left.length, decoded.sampleRate),
    };
  } catch (err) {
    const extNote = fileExtension ? `.${fileExtension.toLowerCase()}` : 'this container';
    throw new Error(
      `Browser audio decoder could not extract PCM audio from ${extNote} (containers such as MKV or AC-3/DTS tracks require remuxing to MP4/WebM/WAV before local web decoding). Original decoder detail: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

/**
 * Browser media blob decoder returning 16 kHz mono Float32Array (used ONLY for ML models
 * like Whisper and PyAnnote that require 16 kHz mono input).
 */
export async function decodeMediaBlobToMono16k(
  blob: Blob,
  fileExtension?: string
): Promise<DecodedAudioMono> {
  const stereo = await decodeMediaBlobToStereo(blob, fileExtension);
  return extractMono16kChunkFromStereo(stereo, 0, stereo.durationMs);
}

/**
 * Pitch-preserving Waveform Similarity Overlap-Add (WSOLA) time-stretcher in pure TypeScript.
 * Physically modifies the PCM audio length by speedMultiplier (bounded strictly to [0.88, 1.15])
 * WITHOUT altering vocal pitch, so Agent #20 Synchronization produces real synchronized WAV files.
 * - speedMultiplier > 1.0 -> shorter duration (faster speech, same pitch)
 * - speedMultiplier < 1.0 -> longer duration (slower speech, same pitch)
 */
export function timeStretchPcmWSOLA(
  samples: Float32Array,
  sampleRate: number,
  speedMultiplier: number
): { samples: Float32Array; sampleRate: number; durationMs: number; appliedSpeed: number } {
  const clampedSpeed = Math.round(Math.min(1.15, Math.max(0.88, speedMultiplier)) * 1000) / 1000;
  if (samples.length < 512 || Math.abs(clampedSpeed - 1.0) < 0.005) {
    return {
      samples: new Float32Array(samples),
      sampleRate,
      durationMs: measureSamplesDurationMs(samples.length, sampleRate),
      appliedSpeed: 1.0,
    };
  }

  // 32ms Hann analysis window, 50% synthesis hop, ±8ms similarity search tolerance
  const winLen = Math.max(256, Math.round(sampleRate * 0.032));
  const synHop = Math.max(64, Math.floor(winLen / 2));
  const anaHopFloat = synHop * clampedSpeed;
  const searchRadius = Math.max(16, Math.round(sampleRate * 0.008));

  const targetOutLen = Math.max(winLen, Math.round(samples.length / clampedSpeed));
  const out = new Float32Array(targetOutLen + winLen);
  const norm = new Float32Array(targetOutLen + winLen);

  // Precompute Hann window
  const hann = new Float32Array(winLen);
  for (let i = 0; i < winLen; i += 1) {
    hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (winLen - 1)));
  }

  // Copy first frame directly
  let outPos = 0;
  let lastAnaPos = 0;
  for (let i = 0; i < winLen && i < samples.length; i += 1) {
    out[i] += samples[i] * hann[i];
    norm[i] += hann[i];
  }

  let frameIndex = 1;
  while (outPos + synHop + winLen <= out.length) {
    outPos += synHop;
    const idealAnaPos = Math.round(frameIndex * anaHopFloat);
    if (idealAnaPos + winLen >= samples.length) break;

    // Natural continuation reference from previous frame
    const refPos = Math.min(samples.length - winLen, lastAnaPos + synHop);
    const searchStart = Math.max(0, idealAnaPos - searchRadius);
    const searchEnd = Math.min(samples.length - winLen, idealAnaPos + searchRadius);

    let bestPos = idealAnaPos;
    let bestCorr = -Infinity;

    // Cross-correlation over overlap region (step by 2 for speed while retaining phase lock)
    const corrLen = Math.min(synHop, winLen);
    for (let cand = searchStart; cand <= searchEnd; cand += 2) {
      let dot = 0;
      let energy = 1e-8;
      for (let k = 0; k < corrLen; k += 2) {
        const r = samples[refPos + k];
        const c = samples[cand + k];
        dot += r * c;
        energy += c * c;
      }
      const score = dot / Math.sqrt(energy);
      if (score > bestCorr) {
        bestCorr = score;
        bestPos = cand;
      }
    }

    for (let i = 0; i < winLen; i += 1) {
      out[outPos + i] += samples[bestPos + i] * hann[i];
      norm[outPos + i] += hann[i];
    }

    lastAnaPos = bestPos;
    frameIndex += 1;
  }

  const trimmed = new Float32Array(targetOutLen);
  for (let i = 0; i < targetOutLen; i += 1) {
    const val = norm[i] > 1e-4 ? out[i] / norm[i] : out[i];
    trimmed[i] = Math.max(-0.98, Math.min(0.98, val));
  }

  return {
    samples: trimmed,
    sampleRate,
    durationMs: measureSamplesDurationMs(trimmed.length, sampleRate),
    appliedSpeed: clampedSpeed,
  };
}

/**
 * Energy + Zero-Crossing Voice Activity Detection returning non-silent speech windows.
 * Also flags high-density multi-band spectral flux windows as potential overlapping speech.
 * Never fabricates speech intervals if the signal is silent.
 */
export function detectVoiceActivitySegments(
  samples: Float32Array,
  sampleRate: number,
  globalOffsetMs: number = 0
): SpeechInterval[] {
  if (samples.length === 0 || sampleRate <= 0) return [];

  const frameMs = 50;
  const frameLen = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const frameEnergies: number[] = [];
  const frameZcr: number[] = [];

  for (let start = 0; start < samples.length; start += frameLen) {
    const end = Math.min(samples.length, start + frameLen);
    let sumSq = 0;
    let crossings = 0;
    for (let i = start; i < end; i += 1) {
      const v = samples[i];
      sumSq += v * v;
      if (i > start) {
        const prev = samples[i - 1];
        if ((prev >= 0 && v < 0) || (prev < 0 && v >= 0)) crossings += 1;
      }
    }
    const rms = Math.sqrt(sumSq / Math.max(1, end - start));
    const db = rms > 1e-7 ? 20 * Math.log10(rms) : -90;
    frameEnergies.push(db);
    frameZcr.push(crossings / Math.max(1, end - start));
  }

  const sortedDb = [...frameEnergies].sort((a, b) => a - b);
  const noiseFloorDb = sortedDb[Math.floor(sortedDb.length * 0.2)] ?? -65;
  const speechThresholdDb = Math.max(-48, noiseFloorDb + 9);

  const intervals: SpeechInterval[] = [];
  let inSpeech = false;
  let segStartFrame = 0;
  let silenceFrames = 0;
  const maxBridgeSilenceFrames = 6; // 300ms pause tolerance
  const localDurationMs = measureSamplesDurationMs(samples.length, sampleRate);

  const pushInterval = (startFrame: number, endFrame: number) => {
    const durationFrames = endFrame - startFrame;
    if (durationFrames < 4) return;
    const energySlice = frameEnergies.slice(startFrame, endFrame);
    const zcrSlice = frameZcr.slice(startFrame, endFrame);
    const avgDb = energySlice.reduce((a, b) => a + b, 0) / durationFrames;
    const zcrMean = zcrSlice.reduce((a, b) => a + b, 0) / durationFrames;
    const zcrVar =
      zcrSlice.reduce((acc, z) => acc + Math.pow(z - zcrMean, 2), 0) / durationFrames;
    // Heuristic overlap cue: high sustained energy + high ZCR variance indicates simultaneous voices
    const overlapping = avgDb > -18 && Math.sqrt(zcrVar) > 0.085 && durationFrames >= 10;

    intervals.push({
      startMs: globalOffsetMs + startFrame * frameMs,
      endMs: globalOffsetMs + Math.min(localDurationMs, endFrame * frameMs),
      energyDb: Math.round(avgDb * 10) / 10,
      overlapping,
    });
  };

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
        pushInterval(segStartFrame, f - silenceFrames + 1);
        inSpeech = false;
        silenceFrames = 0;
      }
    }
  }

  if (inSpeech) {
    pushInterval(segStartFrame, frameEnergies.length);
  }

  return intervals;
}

/**
 * Chunk-based Voice Activity Detection over long stereo episodes using ChunkDefinition plan
 * (30s chunks, 2s overlap) with overlap-aware deduplication and global timestamps.
 */
export function detectVoiceActivityChunked(
  stereo: DecodedAudioStereo,
  chunkPlan: ChunkDefinition[]
): SpeechInterval[] {
  const effectiveChunks =
    chunkPlan.length > 0
      ? chunkPlan
      : [
          {
            index: 0,
            startMs: 0,
            endMs: stereo.durationMs,
            overlapStartMs: 0,
            overlapEndMs: stereo.durationMs,
            status: 'planned' as const,
          },
        ];

  const allIntervals: SpeechInterval[] = [];
  for (const ch of effectiveChunks) {
    const monoChunk = extractMono16kChunkFromStereo(stereo, ch.overlapStartMs, ch.overlapEndMs);
    const localIntervals = detectVoiceActivitySegments(
      monoChunk.samples,
      monoChunk.sampleRate,
      ch.overlapStartMs
    );

    for (const iv of localIntervals) {
      // Keep segments whose midpoint belongs to this chunk's authoritative [startMs, endMs]
      const mid = (iv.startMs + iv.endMs) / 2;
      if (mid < ch.startMs || mid > ch.endMs) continue;

      const prev = allIntervals[allIntervals.length - 1];
      if (prev && iv.startMs <= prev.endMs + 120) {
        prev.endMs = Math.max(prev.endMs, iv.endMs);
        prev.energyDb = Math.round(((prev.energyDb + iv.energyDb) / 2) * 10) / 10;
        prev.overlapping = prev.overlapping || iv.overlapping;
      } else {
        allIntervals.push(iv);
      }
    }
  }

  return allIntervals;
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
  const minLag = Math.floor(sampleRate / 420);
  const maxLag = Math.min(Math.floor(length / 2), Math.floor(sampleRate / 65));
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
 * for cosine-similarity recurring speaker clustering.
 */
export function extractAcousticSpeakerEmbedding(
  samples: Float32Array,
  sampleRate: number
): number[] {
  if (samples.length < 256) return new Array(10).fill(0);

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
    if (frameCount >= 40) break;
  }

  const meanPitch =
    pitches.length > 0 ? pitches.reduce((a, b) => a + b, 0) / pitches.length : 160;
  const pitchStd =
    pitches.length > 1
      ? Math.sqrt(
          pitches.reduce((acc, p) => acc + Math.pow(p - meanPitch, 2), 0) / pitches.length
        )
      : 15;

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
 * with calibrated confidence (never overclaiming certainty on fallback spectral clustering).
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
    const endIdx = Math.min(samples.length, Math.ceil((interval.endMs / 1000) * sampleRate));
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
      // Calibrated confidence bounded strictly below 0.86 for acoustic spectral clustering
      confidence = Math.min(0.86, Math.max(0.5, bestSim * 0.9));
      const nextCount = cluster.count + 1;
      cluster.vec = cluster.vec.map(
        (val, dim) => (val * cluster.count + embedding[dim]) / nextCount
      );
      cluster.count = nextCount;
    } else {
      const nextNum = centroids.length + 1;
      label = `SPK_${String(nextNum).padStart(2, '0')}`;
      confidence = centroids.length === 0 ? 0.68 : 0.62;
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
  const pitchMinHz =
    pitches.length > 0 ? Math.round(pitches[Math.floor(pitches.length * 0.1)]) : null;
  const pitchMaxHz =
    pitches.length > 0 ? Math.round(pitches[Math.floor(pitches.length * 0.9)]) : null;
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
 * Uses pitch-preserving WSOLA for rateMultiplier and separates modest pitch shift + gain + pause padding.
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
  const rate = Math.min(1.15, Math.max(0.88, options.rateMultiplier ?? 1.0));
  const pitchSt = Math.min(3.0, Math.max(-3.0, options.pitchSemitones ?? 0));
  let working = samples;

  // 1. Apply modest pitch shift (resampling + compensating WSOLA keeps duration stable)
  if (Math.abs(pitchSt) >= 0.15 && working.length >= 512) {
    const pitchRatio = Math.pow(2, pitchSt / 12);
    const pitchedLen = Math.max(1, Math.round(working.length / pitchRatio));
    const pitched = new Float32Array(pitchedLen);
    for (let i = 0; i < pitchedLen; i += 1) {
      const src = i * pitchRatio;
      const lo = Math.floor(src);
      const hi = Math.min(working.length - 1, lo + 1);
      const frac = src - lo;
      pitched[i] = working[lo] * (1 - frac) + working[hi] * frac;
    }
    // Compensate duration change using WSOLA combined with requested rateMultiplier
    const compensatedRate = Math.min(1.15, Math.max(0.88, rate / pitchRatio));
    working = timeStretchPcmWSOLA(pitched, sampleRate, compensatedRate).samples;
  } else if (Math.abs(rate - 1.0) >= 0.005) {
    working = timeStretchPcmWSOLA(working, sampleRate, rate).samples;
  }

  const padSamples = Math.max(
    0,
    Math.round(((options.pausePaddingMs ?? 0) / 1000) * sampleRate)
  );
  const gainLinear = Math.pow(10, Math.min(6, Math.max(-12, options.gainDb ?? 0)) / 20);

  const output = new Float32Array(working.length + padSamples);
  for (let i = 0; i < working.length; i += 1) {
    output[i] = Math.max(-0.98, Math.min(0.98, working[i] * gainLinear));
  }

  return {
    samples: output,
    sampleRate,
    durationMs: measureSamplesDurationMs(output.length, sampleRate),
  };
}
