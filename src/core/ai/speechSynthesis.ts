import type {
  CharacterProfile,
  CloudPrebuiltVoiceName,
  DialogueSegment,
  EmotionMetadata,
  VoiceActingDirective,
  VoiceProfile,
} from '../../types/domain';
import {
  applyPostSynthesisDsp,
  decodePcmWavBuffer,
  encodeFloat32ToWavBlob,
  measureSamplesDurationMs,
  timeStretchPcmWSOLA,
} from './audioDsp';
import { evaluateTimingAdjustment } from '../timeline/timelineEngine';

const CLOUD_VOICE_POOL: CloudPrebuiltVoiceName[] = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Zephyr'];

/**
 * Resolves a character's deterministic persistent Gemini Cloud prebuilt voice name
 * without random cycling or hardcoding 'Kore' for every speaker.
 */
export function resolvePersistentCloudVoiceName(
  character: CharacterProfile | null,
  voice: VoiceProfile | null,
  fallbackSpeakerKey: string = 'SPK_01'
): CloudPrebuiltVoiceName {
  if (character?.assignedCloudVoiceName) {
    return character.assignedCloudVoiceName;
  }
  if (voice?.cloudVoiceName) {
    return voice.cloudVoiceName;
  }
  if (character?.speakerRole === 'narrator') {
    return 'Fenrir';
  }
  const pitch = character?.voiceCharacteristics.pitchMeanHz ?? null;
  if (pitch !== null) {
    if (pitch >= 210) return 'Zephyr';
    if (pitch >= 175) return 'Puck';
    if (pitch <= 135) return 'Charon';
    return 'Kore';
  }
  const hash = Math.abs(
    (character?.characterId || fallbackSpeakerKey)
      .split('')
      .reduce((acc, ch) => acc * 31 + ch.charCodeAt(0), 7)
  );
  return CLOUD_VOICE_POOL[hash % CLOUD_VOICE_POOL.length];
}

/**
 * Voice Assignment Agent (#17): Selects the best matching permanent Hindi Voice ID
 * for an unlocked character using acoustic vocal characteristics while strictly honoring
 * locked or manually assigned voices across episodes.
 * Supports distinct Cloud Prebuilt Voices when Cloud TTS is preferred, or Local MMS-TTS
 * voices offline — keeping one persistent voice per character and avoiding unnecessary collisions.
 */
export function selectBestVoiceForCharacter(
  character: CharacterProfile,
  availableVoices: VoiceProfile[],
  options: { preferCloudVoices?: boolean; alreadyAssignedVoiceIds?: Set<string> } = {}
): VoiceProfile | null {
  if (availableVoices.length === 0) return null;

  // Strictly preserve locked or already manually assigned voice
  if (character.voiceLocked && character.assignedHindiVoiceId) {
    const existing = availableVoices.find(
      (v) => v.voiceId === character.assignedHindiVoiceId
    );
    if (existing) return existing;
  }

  const cloudVoices = availableVoices.filter((v) => v.synthesisMode === 'cloud_prebuilt_voice');
  const localVoices = availableVoices.filter((v) => v.synthesisMode !== 'cloud_prebuilt_voice');
  const pool =
    options.preferCloudVoices && cloudVoices.length > 0
      ? cloudVoices
      : localVoices.length > 0
      ? localVoices
      : availableVoices;

  const pickPreferred = (preferredId: string): VoiceProfile => {
    const exact = pool.find((v) => v.voiceId === preferredId);
    if (exact && !options.alreadyAssignedVoiceIds?.has(exact.voiceId)) {
      return exact;
    }
    const unused = pool.find((v) => !options.alreadyAssignedVoiceIds?.has(v.voiceId));
    return unused ?? exact ?? pool[0];
  };

  if (options.preferCloudVoices && cloudVoices.length > 0) {
    if (character.speakerRole === 'narrator') return pickPreferred('cloud_gemini_fenrir');
    const pitch = character.voiceCharacteristics.pitchMeanHz ?? null;
    if (pitch !== null) {
      if (pitch >= 205) return pickPreferred('cloud_gemini_zephyr');
      if (pitch >= 170) return pickPreferred('cloud_gemini_puck');
      if (pitch <= 135) return pickPreferred('cloud_gemini_charon');
      return pickPreferred('cloud_gemini_kore');
    }
    const hint = `${character.voiceCharacteristics.genderPresentation} ${character.voiceCharacteristics.ageEstimate} ${character.personality}`.toLowerCase();
    if (/bright|child|teen|feminine|high/.test(hint)) return pickPreferred('cloud_gemini_zephyr');
    if (/deep|mentor|elderly|masculine|baritone/.test(hint)) return pickPreferred('cloud_gemini_charon');
    if (/energetic|youth|hero|upbeat/.test(hint)) return pickPreferred('cloud_gemini_puck');
    return pickPreferred('cloud_gemini_kore');
  }

  if (character.speakerRole === 'narrator') {
    return pickPreferred('mms_hin_narrator');
  }

  const pitch = character.voiceCharacteristics.pitchMeanHz ?? null;
  if (pitch !== null) {
    if (pitch >= 195) return pickPreferred('mms_hin_bright');
    if (pitch <= 138) return pickPreferred('mms_hin_warm');
  }

  const hint = `${character.voiceCharacteristics.genderPresentation} ${character.voiceCharacteristics.ageEstimate} ${character.personality}`.toLowerCase();
  if (/bright|child|teen|feminine|high/.test(hint)) {
    return pickPreferred('mms_hin_bright');
  }
  if (/deep|mentor|elderly|masculine|baritone/.test(hint)) {
    return pickPreferred('mms_hin_warm');
  }

  return pickPreferred('mms_hin_base');
}

/**
 * Voice Acting Agent (#19): Converts temporary EmotionMetadata into explicit speaking
 * parameters while keeping permanent character voice identity separate.
 */
export function buildVoiceActingDirective(
  emotion: EmotionMetadata,
  voice: VoiceProfile | null
): VoiceActingDirective {
  const intensity = Math.min(1, Math.max(0, emotion.intensity ?? 0.5));
  const isCloudVoice = voice?.synthesisMode === 'cloud_prebuilt_voice';
  const basePitch = isCloudVoice ? 0 : voice?.dspPitchSemitones ?? 0;
  const baseRate = isCloudVoice ? 1.0 : voice?.dspRateMultiplier ?? 1.0;

  let deltaRate = 0;
  let deltaPitch = 0;
  let gainDb = 0;
  let pausePaddingMs = 0;
  let deliveryStyle = 'Balanced studio delivery';

  switch (emotion.primaryEmotion) {
    case 'Whispering':
      deltaRate = -0.06 * intensity;
      deltaPitch = isCloudVoice ? 0 : -0.4;
      gainDb = -6.0;
      pausePaddingMs = 80;
      deliveryStyle = isCloudVoice
        ? 'Soft whispered delivery (Cloud style + gain attenuation)'
        : 'Soft low-volume whisper attenuation (DSP)';
      break;
    case 'Shouting':
      deltaRate = 0.04 * intensity;
      deltaPitch = isCloudVoice ? 0 : 0.9 * intensity;
      gainDb = 2.2;
      deliveryStyle = isCloudVoice
        ? 'High-projection dramatic shouting (Cloud style + emphasis)'
        : 'High-projection emphasis (DSP)';
      break;
    case 'Angry':
      deltaRate = 0.05 * intensity;
      deltaPitch = isCloudVoice ? 0 : -0.5 * intensity;
      gainDb = 1.6;
      deliveryStyle = isCloudVoice
        ? 'Forceful angry cadence (Cloud style + gain emphasis)'
        : 'Firm forceful cadence (DSP)';
      break;
    case 'Excited':
    case 'Happy':
    case 'Laughter':
      deltaRate = 0.05 * intensity;
      deltaPitch = isCloudVoice ? 0 : 0.7 * intensity;
      gainDb = 0.8;
      deliveryStyle = isCloudVoice
        ? 'Upbeat joyful delivery (Cloud expressive)'
        : 'Upbeat energetic pacing (DSP)';
      break;
    case 'Sad':
    case 'Crying':
      deltaRate = -0.07 * intensity;
      deltaPitch = isCloudVoice ? 0 : -0.7 * intensity;
      gainDb = -1.5;
      pausePaddingMs = 120;
      deliveryStyle = isCloudVoice
        ? 'Emotional melancholic delivery (Cloud expressive + pause)'
        : 'Slower measured melancholic pacing (DSP)';
      break;
    case 'Fearful':
    case 'Surprised':
      deltaRate = 0.06 * intensity;
      deltaPitch = isCloudVoice ? 0 : 0.8 * intensity;
      deliveryStyle = isCloudVoice
        ? 'Urgent breathless delivery (Cloud expressive)'
        : 'Quickened urgent delivery (DSP)';
      break;
    case 'Sarcastic':
      deltaRate = -0.04;
      deltaPitch = isCloudVoice ? 0 : -0.3;
      pausePaddingMs = 60;
      deliveryStyle = 'Dry measured sarcastic cadence';
      break;
    case 'Confident':
      deltaRate = 0;
      deltaPitch = isCloudVoice ? 0 : -0.2;
      gainDb = 0.8;
      deliveryStyle = 'Steady assertive projection';
      break;
    default:
      deliveryStyle = 'Calm natural studio delivery';
      break;
  }

  const speakingRateMultiplier =
    Math.round(Math.min(1.14, Math.max(0.88, baseRate + deltaRate)) * 100) / 100;
  const pitchShiftSemitones =
    Math.round(Math.min(3.0, Math.max(-3.0, basePitch + deltaPitch)) * 10) / 10;

  return {
    emotion: emotion.primaryEmotion,
    intensity,
    speakingRateMultiplier,
    pitchShiftSemitones,
    gainDbAdjustment: Math.round(gainDb * 10) / 10,
    pausePaddingMs,
    deliveryStyle,
    controlSource: isCloudVoice ? 'native_tts_and_dsp' : 'post_synthesis_dsp',
    limitationNote: isCloudVoice
      ? 'Gemini Cloud TTS receives native expressive style prompting plus bounded post-synthesis gain/pause/WSOLA timing control.'
      : 'Meta MMS-TTS-HIN (VITS) does not expose native neural emotion tokens; rate, pitch, gain, and pauses are applied via bounded post-synthesis WSOLA/DSP.',
  };
}

/**
 * Applies post-synthesis Voice Acting DSP (gain, pause padding, modest WSOLA rate/pitch)
 * to any generated WAV Blob (including Gemini Cloud TTS WAV outputs so acting directives
 * are consistently honored on both local and cloud paths!).
 */
export async function applyVoiceActingToWavBlob(
  wavBlob: Blob,
  directive: VoiceActingDirective,
  isCloudNativeExpressive: boolean
): Promise<{ wavBlob: Blob; sampleRate: number; durationMs: number }> {
  const buf = await wavBlob.arrayBuffer();
  const decoded = decodePcmWavBuffer(buf);
  if (!decoded || decoded.samples.length === 0) {
    throw new Error('Cannot apply voice acting DSP to invalid or empty WAV buffer.');
  }

  // For cloud native voices, preserve natural vocal timbre (pitch=0) while honoring gain, pause & subtle rate
  const processed = applyPostSynthesisDsp(decoded.samples, decoded.sampleRate, {
    rateMultiplier: isCloudNativeExpressive
      ? Math.min(1.08, Math.max(0.92, directive.speakingRateMultiplier))
      : directive.speakingRateMultiplier,
    pitchSemitones: isCloudNativeExpressive ? 0 : directive.pitchShiftSemitones,
    gainDb: directive.gainDbAdjustment,
    pausePaddingMs: directive.pausePaddingMs,
  });

  return {
    wavBlob: encodeFloat32ToWavBlob(processed.samples, processed.sampleRate),
    sampleRate: processed.sampleRate,
    durationMs: processed.durationMs,
  };
}

export interface SynchronizationOutcome {
  finalStartMs: number;
  finalEndMs: number;
  actualGeneratedDurationMs: number;
  syncDeltaMs: number;
  appliedSpeedMultiplier: number;
  syncStatus: DialogueSegment['syncStatus'];
  reviewStatus: DialogueSegment['reviewStatus'];
  note: string;
}

/**
 * Synchronization Agent (#20) timing planner: compares real measured generated Hindi audio
 * duration against original dialogue timing.
 * - Preferred adjustment target: ±200–400ms shift when practical.
 * - Modest natural speed adjustment bounded strictly to [0.88x, 1.15x].
 * - Flags excessively long lines for natural Hindi rephrasing review instead of truncating speech.
 */
export function computeSynchronizedPlacement(params: {
  originalStartMs: number;
  originalEndMs: number;
  measuredAudioDurationMs: number;
  preferredShiftLimitMs?: number;
  nextSegmentStartMs?: number | null;
}): SynchronizationOutcome {
  const {
    originalStartMs,
    originalEndMs,
    measuredAudioDurationMs,
    preferredShiftLimitMs = 300,
    nextSegmentStartMs = null,
  } = params;

  const originalDurationMs = Math.max(100, originalEndMs - originalStartMs);
  const rawDeltaMs = measuredAudioDurationMs - originalDurationMs;
  const maxNaturalSpeed = 1.15;
  const minNaturalSpeed = 0.88;

  let appliedSpeedMultiplier = 1.0;
  let effectiveDurationMs = measuredAudioDurationMs;

  if (Math.abs(rawDeltaMs) <= preferredShiftLimitMs) {
    const finalStartMs = originalStartMs;
    const finalEndMs = finalStartMs + effectiveDurationMs;
    return {
      finalStartMs,
      finalEndMs,
      actualGeneratedDurationMs: effectiveDurationMs,
      syncDeltaMs: rawDeltaMs,
      appliedSpeedMultiplier: 1.0,
      syncStatus: 'in_tolerance',
      reviewStatus: 'unreviewed',
      note: `Fits within ±${preferredShiftLimitMs} ms tolerance (${rawDeltaMs >= 0 ? '+' : ''}${rawDeltaMs} ms).`,
    };
  }

  if (rawDeltaMs > preferredShiftLimitMs) {
    const availableSlackBefore = Math.min(Math.round(preferredShiftLimitMs * 0.5), originalStartMs);
    const availableGapAfter =
      nextSegmentStartMs !== null
        ? Math.max(0, Math.min(preferredShiftLimitMs, nextSegmentStartMs - originalEndMs))
        : preferredShiftLimitMs;

    const targetWindowMs = originalDurationMs + availableSlackBefore + availableGapAfter;
    const neededSpeed = measuredAudioDurationMs / Math.max(200, targetWindowMs);

    if (neededSpeed <= 1.0) {
      const shiftBack = Math.min(availableSlackBefore, Math.round(rawDeltaMs / 2));
      const finalStartMs = Math.max(0, originalStartMs - shiftBack);
      return {
        finalStartMs,
        finalEndMs: finalStartMs + measuredAudioDurationMs,
        actualGeneratedDurationMs: measuredAudioDurationMs,
        syncDeltaMs: measuredAudioDurationMs - originalDurationMs,
        appliedSpeedMultiplier: 1.0,
        syncStatus: 'in_tolerance',
        reviewStatus: 'unreviewed',
        note: `Aligned using ${shiftBack} ms early lead-in without altering speech rate.`,
      };
    }

    appliedSpeedMultiplier = Math.round(Math.min(maxNaturalSpeed, neededSpeed) * 100) / 100;
    effectiveDurationMs = Math.round(measuredAudioDurationMs / appliedSpeedMultiplier);
    const shiftBack = Math.min(availableSlackBefore, Math.round(preferredShiftLimitMs * 0.4));
    const finalStartMs = Math.max(0, originalStartMs - shiftBack);
    const finalEndMs = finalStartMs + effectiveDurationMs;
    const residualDelta = effectiveDurationMs - originalDurationMs;
    const evalCheck = evaluateTimingAdjustment(
      originalStartMs,
      finalStartMs,
      preferredShiftLimitMs
    );

    const stillTooLong = neededSpeed > maxNaturalSpeed;
    return {
      finalStartMs,
      finalEndMs,
      actualGeneratedDurationMs: effectiveDurationMs,
      syncDeltaMs: residualDelta,
      appliedSpeedMultiplier,
      syncStatus:
        stillTooLong || !evalCheck.withinPreferredRange ? 'needs_adjustment' : 'in_tolerance',
      reviewStatus: stillTooLong ? 'needs_review' : 'unreviewed',
      note: stillTooLong
        ? `Capped WSOLA speed at ${maxNaturalSpeed}× to keep Hindi speech natural; shorten Hindi phrasing or review timing (+${residualDelta} ms).`
        : `Synchronized via pitch-preserving ${appliedSpeedMultiplier}× WSOLA adjustment (${residualDelta >= 0 ? '+' : ''}${residualDelta} ms).`,
    };
  }

  const mildSlow = Math.max(
    minNaturalSpeed,
    Math.min(1.0, measuredAudioDurationMs / (originalDurationMs * 0.92))
  );
  appliedSpeedMultiplier = Math.round(mildSlow * 100) / 100;
  effectiveDurationMs = Math.round(measuredAudioDurationMs / appliedSpeedMultiplier);

  return {
    finalStartMs: originalStartMs,
    finalEndMs: originalStartMs + effectiveDurationMs,
    actualGeneratedDurationMs: effectiveDurationMs,
    syncDeltaMs: effectiveDurationMs - originalDurationMs,
    appliedSpeedMultiplier,
    syncStatus: 'in_tolerance',
    reviewStatus: 'unreviewed',
    note: `Shorter than original window; applied ${appliedSpeedMultiplier}× WSOLA pacing & preserved natural trailing silence (${effectiveDurationMs - originalDurationMs} ms).`,
  };
}

/**
 * CRITICAL SYNCHRONIZATION REPAIR:
 * Actually applies bounded pitch-preserving WSOLA time-stretching to the generated WAV PCM samples,
 * writes out a new synchronized WAV Blob, and re-measures its exact physical duration in milliseconds
 * (never leaving metadata out of sync with the actual WAV file, and never silently truncating speech).
 */
export async function applyRealSyncToGeneratedWavBlob(params: {
  wavBlob: Blob;
  originalStartMs: number;
  originalEndMs: number;
  preferredShiftLimitMs?: number;
  nextSegmentStartMs?: number | null;
}): Promise<{
  synchronizedWavBlob: Blob;
  modifiedPcm: boolean;
  outcome: SynchronizationOutcome;
}> {
  const buf = await params.wavBlob.arrayBuffer();
  const decoded = decodePcmWavBuffer(buf);
  if (!decoded || decoded.samples.length === 0) {
    throw new Error('Cannot synchronize invalid or empty WAV audio.');
  }

  const planned = computeSynchronizedPlacement({
    originalStartMs: params.originalStartMs,
    originalEndMs: params.originalEndMs,
    measuredAudioDurationMs: decoded.durationMs,
    preferredShiftLimitMs: params.preferredShiftLimitMs,
    nextSegmentStartMs: params.nextSegmentStartMs,
  });

  if (Math.abs(planned.appliedSpeedMultiplier - 1.0) < 0.01) {
    return {
      synchronizedWavBlob: params.wavBlob,
      modifiedPcm: false,
      outcome: planned,
    };
  }

  // Physically time-stretch the PCM audio via pitch-preserving WSOLA
  const stretched = timeStretchPcmWSOLA(
    decoded.samples,
    decoded.sampleRate,
    planned.appliedSpeedMultiplier
  );
  const synchronizedWavBlob = encodeFloat32ToWavBlob(stretched.samples, stretched.sampleRate);
  const remeasuredDurationMs = stretched.durationMs;
  const originalDurationMs = Math.max(100, params.originalEndMs - params.originalStartMs);
  const realSyncDeltaMs = remeasuredDurationMs - originalDurationMs;
  const finalEndMs = planned.finalStartMs + remeasuredDurationMs;

  return {
    synchronizedWavBlob,
    modifiedPcm: true,
    outcome: {
      ...planned,
      finalEndMs,
      actualGeneratedDurationMs: remeasuredDurationMs,
      syncDeltaMs: realSyncDeltaMs,
      appliedSpeedMultiplier: stretched.appliedSpeed,
    },
  };
}

interface TransformersTtsOutput {
  audio: Float32Array;
  sampling_rate: number;
}

type TransformersTtsPipeline = (text: string) => Promise<TransformersTtsOutput>;

function chunkHindiTextForLocalTts(text: string, maxChars: number = 180): string[] {
  const clean = text.trim();
  if (clean.length <= maxChars) return [clean];
  const sentences = clean
    .split(/(?<=[।.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let acc = '';
  for (const s of sentences) {
    if ((acc + ' ' + s).trim().length <= maxChars) {
      acc = (acc + ' ' + s).trim();
    } else {
      if (acc) chunks.push(acc);
      if (s.length <= maxChars) {
        acc = s;
      } else {
        for (let i = 0; i < s.length; i += maxChars) {
          chunks.push(s.slice(i, i + maxChars));
        }
        acc = '';
      }
    }
  }
  if (acc) chunks.push(acc);
  return chunks.length > 0 ? chunks : [clean.slice(0, maxChars)];
}

/**
 * Hindi TTS Agent (#18): Executes real Xenova/mms-tts-hin inference (with long-text chunking),
 * applies bounded acting WSOLA/DSP, encodes genuine 16-bit PCM WAV, and measures exact real duration.
 */
export async function synthesizeHindiWavWithModel(params: {
  ttsPipeline: TransformersTtsPipeline;
  hindiText: string;
  directive: VoiceActingDirective;
  extraSyncSpeedMultiplier?: number;
}): Promise<{
  wavBlob: Blob;
  sampleRate: number;
  durationMs: number;
  rawSamples: Float32Array;
}> {
  const cleanText = params.hindiText.trim();
  if (!cleanText) {
    throw new Error('Cannot synthesize Hindi TTS for empty text.');
  }

  const textChunks = chunkHindiTextForLocalTts(cleanText, 180);
  const pcmChunks: Float32Array[] = [];
  let sampleRate = 16000;

  for (let idx = 0; idx < textChunks.length; idx += 1) {
    const rawOutput = await params.ttsPipeline(textChunks[idx]);
    if (!rawOutput?.audio || rawOutput.audio.length === 0) {
      throw new Error('MMS-TTS-HIN returned an empty audio buffer.');
    }
    sampleRate = rawOutput.sampling_rate || sampleRate;
    pcmChunks.push(rawOutput.audio);
    if (idx < textChunks.length - 1) {
      // Natural 120ms inter-sentence pause between chunks
      pcmChunks.push(new Float32Array(Math.round(sampleRate * 0.12)));
    }
  }

  const totalLen = pcmChunks.reduce((sum, c) => sum + c.length, 0);
  const combinedAudio = new Float32Array(totalLen);
  let cursor = 0;
  for (const chunk of pcmChunks) {
    combinedAudio.set(chunk, cursor);
    cursor += chunk.length;
  }

  const combinedRate =
    params.directive.speakingRateMultiplier * (params.extraSyncSpeedMultiplier ?? 1.0);

  const processed = applyPostSynthesisDsp(combinedAudio, sampleRate, {
    rateMultiplier: combinedRate,
    pitchSemitones: params.directive.pitchShiftSemitones,
    gainDb: params.directive.gainDbAdjustment,
    pausePaddingMs: params.directive.pausePaddingMs,
  });

  const wavBlob = encodeFloat32ToWavBlob(processed.samples, processed.sampleRate);
  const durationMs = measureSamplesDurationMs(
    processed.samples.length,
    processed.sampleRate
  );

  return {
    wavBlob,
    sampleRate: processed.sampleRate,
    durationMs,
    rawSamples: processed.samples,
  };
}
