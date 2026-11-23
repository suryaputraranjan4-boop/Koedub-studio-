import type {
  CharacterProfile,
  DialogueSegment,
  EmotionMetadata,
  VoiceActingDirective,
  VoiceProfile,
} from '../../types/domain';
import { applyPostSynthesisDsp, encodeFloat32ToWavBlob, measureSamplesDurationMs } from './audioDsp';
import { evaluateTimingAdjustment } from '../timeline/timelineEngine';

/**
 * Voice Assignment Agent (#17): Selects the best matching permanent Hindi Voice ID
 * for an unlocked character using acoustic vocal characteristics while strictly honoring
 * locked or manually assigned voices across episodes.
 */
export function selectBestVoiceForCharacter(
  character: CharacterProfile,
  availableVoices: VoiceProfile[]
): VoiceProfile | null {
  if (availableVoices.length === 0) return null;

  // Strictly preserve locked or already manually assigned voice
  if (character.voiceLocked && character.assignedHindiVoiceId) {
    const existing = availableVoices.find(
      (v) => v.voiceId === character.assignedHindiVoiceId
    );
    if (existing) return existing;
  }

  if (character.speakerRole === 'narrator') {
    const narratorVoice = availableVoices.find((v) => v.voiceId === 'mms_hin_narrator');
    if (narratorVoice) return narratorVoice;
  }

  const pitch = character.voiceCharacteristics.pitchMeanHz ?? null;
  if (pitch !== null) {
    if (pitch >= 195) {
      return availableVoices.find((v) => v.voiceId === 'mms_hin_bright') ?? availableVoices[0];
    }
    if (pitch <= 138) {
      return availableVoices.find((v) => v.voiceId === 'mms_hin_warm') ?? availableVoices[0];
    }
  }

  const hint = `${character.voiceCharacteristics.genderPresentation} ${character.voiceCharacteristics.ageEstimate} ${character.personality}`.toLowerCase();
  if (/bright|child|teen|feminine|high/.test(hint)) {
    return availableVoices.find((v) => v.voiceId === 'mms_hin_bright') ?? availableVoices[0];
  }
  if (/deep|mentor|elderly|masculine|baritone/.test(hint)) {
    return availableVoices.find((v) => v.voiceId === 'mms_hin_warm') ?? availableVoices[0];
  }

  return availableVoices.find((v) => v.voiceId === 'mms_hin_base') ?? availableVoices[0];
}

/**
 * Voice Acting Agent (#19): Converts temporary EmotionMetadata into explicit speaking
 * parameters while keeping permanent character voice identity separate.
 * Honestly declares that Meta MMS-TTS-HIN lacks native emotion conditioning, so expressive
 * adjustments are performed via bounded post-synthesis Web Audio DSP.
 */
export function buildVoiceActingDirective(
  emotion: EmotionMetadata,
  voice: VoiceProfile | null
): VoiceActingDirective {
  const intensity = Math.min(1, Math.max(0, emotion.intensity ?? 0.5));
  const basePitch = voice?.dspPitchSemitones ?? 0;
  const baseRate = voice?.dspRateMultiplier ?? 1.0;

  let deltaRate = 0;
  let deltaPitch = 0;
  let gainDb = 0;
  let pausePaddingMs = 0;
  let deliveryStyle = 'Balanced studio delivery';

  switch (emotion.primaryEmotion) {
    case 'Whispering':
      deltaRate = -0.06 * intensity;
      deltaPitch = -0.4;
      gainDb = -6.5;
      pausePaddingMs = 80;
      deliveryStyle = 'Soft low-volume whisper attenuation (DSP)';
      break;
    case 'Shouting':
      deltaRate = 0.04 * intensity;
      deltaPitch = 0.9 * intensity;
      gainDb = 2.5;
      deliveryStyle = 'High-projection emphasis (DSP)';
      break;
    case 'Angry':
      deltaRate = 0.05 * intensity;
      deltaPitch = -0.5 * intensity;
      gainDb = 1.8;
      deliveryStyle = 'Firm forceful cadence (DSP)';
      break;
    case 'Excited':
    case 'Happy':
    case 'Laughter':
      deltaRate = 0.06 * intensity;
      deltaPitch = 0.8 * intensity;
      gainDb = 0.8;
      deliveryStyle = 'Upbeat energetic pacing (DSP)';
      break;
    case 'Sad':
    case 'Crying':
      deltaRate = -0.08 * intensity;
      deltaPitch = -0.7 * intensity;
      gainDb = -1.5;
      pausePaddingMs = 120;
      deliveryStyle = 'Slower measured melancholic pacing (DSP)';
      break;
    case 'Fearful':
    case 'Surprised':
      deltaRate = 0.07 * intensity;
      deltaPitch = 0.9 * intensity;
      deliveryStyle = 'Quickened urgent delivery (DSP)';
      break;
    case 'Sarcastic':
      deltaRate = -0.04;
      deltaPitch = -0.3;
      pausePaddingMs = 60;
      deliveryStyle = 'Dry measured cadence (DSP)';
      break;
    case 'Confident':
      deltaRate = 0;
      deltaPitch = -0.2;
      gainDb = 0.8;
      deliveryStyle = 'Steady assertive projection (DSP)';
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
    controlSource: 'post_synthesis_dsp',
    limitationNote:
      'Meta MMS-TTS-HIN (VITS) does not expose native neural emotion tokens; rate, pitch, gain, and pauses are applied via bounded post-synthesis Web Audio DSP.',
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
 * Synchronization Agent (#20): Compares real measured generated Hindi audio duration against
 * original dialogue timing.
 * - Preferred adjustment target: ±200–400ms shift when practical.
 * - Modest natural speed adjustment bounded strictly to [0.88x, 1.15x] (never unnatural fast speech).
 * - Flags excessively long lines for natural Hindi rephrasing review instead of distorting speech.
 * - Preserves originalStartMs / originalEndMs separately and never creates silent audio files.
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

  // Case 1: Generated speech fits within preferred ±200–400ms tolerance natively
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

  // Case 2: Generated speech is longer than original window
  if (rawDeltaMs > preferredShiftLimitMs) {
    // First check if modest ±preferredShiftLimitMs earlier lead-in + trailing slack absorbs it naturally
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

    // Apply bounded natural speed adjustment up to 1.15x max
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
      syncStatus: stillTooLong || !evalCheck.withinPreferredRange ? 'needs_adjustment' : 'in_tolerance',
      reviewStatus: stillTooLong ? 'needs_review' : 'unreviewed',
      note: stillTooLong
        ? `Capped speed at ${maxNaturalSpeed}× to keep Hindi speech natural; shorten Hindi phrasing or review timing (+${residualDelta} ms).`
        : `Aligned via natural ${appliedSpeedMultiplier}× pacing adjustment (${residualDelta >= 0 ? '+' : ''}${residualDelta} ms).`,
    };
  }

  // Case 3: Generated speech is notably shorter than original window — preserve natural pauses!
  // Gently center or keep original start so natural conversational rhythm stays intact.
  const mildSlow = Math.max(minNaturalSpeed, Math.min(1.0, measuredAudioDurationMs / (originalDurationMs * 0.92)));
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
    note: `Shorter than original window; preserved natural silence gap after clip (${effectiveDurationMs - originalDurationMs} ms).`,
  };
}

interface TransformersTtsOutput {
  audio: Float32Array;
  sampling_rate: number;
}

type TransformersTtsPipeline = (text: string) => Promise<TransformersTtsOutput>;

/**
 * Hindi TTS Agent (#18): Executes real Xenova/mms-tts-hin inference, applies bounded acting DSP,
 * encodes genuine 16-bit PCM WAV, and measures exact real duration in milliseconds.
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

  const rawOutput = await params.ttsPipeline(cleanText);
  if (!rawOutput?.audio || rawOutput.audio.length === 0) {
    throw new Error('MMS-TTS-HIN returned an empty audio buffer.');
  }

  const combinedRate =
    params.directive.speakingRateMultiplier * (params.extraSyncSpeedMultiplier ?? 1.0);

  const processed = applyPostSynthesisDsp(rawOutput.audio, rawOutput.sampling_rate, {
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
