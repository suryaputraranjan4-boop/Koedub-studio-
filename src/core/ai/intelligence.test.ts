import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeCharacterRelationshipsFromDialogue,
  applyPronunciationDictionary,
  deduplicateAsrChunks,
  detectEmotionHybrid,
} from './languageIntelligence';
import { computeMultimodalFaceVoiceMatches } from './visualIntelligence';
import {
  buildVoiceActingDirective,
  computeSynchronizedPlacement,
  selectBestVoiceForCharacter,
} from './speechSynthesis';
import type {
  CharacterProfile,
  DialogueSegment,
  PronunciationEntry,
  Speaker,
  VoiceProfile,
} from '../../types/domain';

const SAMPLE_VOICES: VoiceProfile[] = [
  {
    voiceId: 'mms_hin_base',
    displayName: 'Meta MMS Hindi Base',
    language: 'hi',
    locale: 'hi-IN',
    genderStyle: 'Neutral',
    characteristics: 'Base VITS',
    engineRuntime: 'ONNX Runtime Web',
    modelId: 'model_mms_tts_hin',
    synthesisMode: 'neural_native',
    dspPitchSemitones: 0,
    dspRateMultiplier: 1.0,
    nativeEmotionControl: false,
    installStatus: 'not_installed',
    availabilityStatus: 'not_installed',
    lockedCharacterIds: [],
    notes: 'Base voice',
  },
  {
    voiceId: 'mms_hin_bright',
    displayName: 'Hindi Bright DSP',
    language: 'hi',
    locale: 'hi-IN',
    genderStyle: 'High-register',
    characteristics: 'Bright DSP',
    engineRuntime: 'ONNX Runtime Web + DSP',
    modelId: 'model_mms_tts_hin',
    synthesisMode: 'single_speaker_dsp_preset',
    dspPitchSemitones: 1.8,
    dspRateMultiplier: 1.03,
    nativeEmotionControl: false,
    installStatus: 'not_installed',
    availabilityStatus: 'not_installed',
    lockedCharacterIds: [],
    notes: 'Bright preset',
  },
  {
    voiceId: 'mms_hin_warm',
    displayName: 'Hindi Warm DSP',
    language: 'hi',
    locale: 'hi-IN',
    genderStyle: 'Low-register',
    characteristics: 'Warm DSP',
    engineRuntime: 'ONNX Runtime Web + DSP',
    modelId: 'model_mms_tts_hin',
    synthesisMode: 'single_speaker_dsp_preset',
    dspPitchSemitones: -1.8,
    dspRateMultiplier: 0.96,
    nativeEmotionControl: false,
    installStatus: 'not_installed',
    availabilityStatus: 'not_installed',
    lockedCharacterIds: [],
    notes: 'Warm preset',
  },
];

function makeCharacter(overrides: Partial<CharacterProfile>): CharacterProfile {
  return {
    characterId: 'CHR-1',
    projectId: 'prj_1',
    seriesScope: 'Test Series',
    displayName: 'Ren',
    visualDescriptors: [],
    associatedSpeakerIds: ['SPK_01'],
    voiceCharacteristics: {
      pitchRange: '120–140 Hz',
      timbre: 'Warm',
      pacing: 'Moderate',
      ageEstimate: 'Adult',
      genderPresentation: 'Masculine-leaning',
      pitchMeanHz: 130,
    },
    assignedHindiVoiceId: null,
    voiceLocked: false,
    personality: 'Calm',
    speakingStyle: 'Direct',
    relationships: [],
    dialogueHistoryIds: [],
    firstSeenMs: null,
    lastSeenMs: null,
    identityConfidence: 0.85,
    reviewStatus: 'unreviewed',
    speakerRole: 'on_screen',
    ambiguityNote: '',
    voiceAssignmentHistory: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSegment(overrides: Partial<DialogueSegment>): DialogueSegment {
  return {
    segmentId: 'SEG-1',
    projectId: 'prj_1',
    sourceSpeakerId: 'SPK_01',
    characterId: 'CHR-1',
    originalStartMs: 0,
    originalEndMs: 2000,
    originalDurationMs: 2000,
    japaneseText: '',
    hindiText: '',
    emotion: {
      primaryEmotion: 'Calm',
      intensity: 0.4,
      deliveryNotes: '',
      source: 'manual',
    },
    assignedHindiVoiceId: null,
    generatedAudioRef: null,
    actualGeneratedDurationMs: null,
    finalStartMs: 0,
    finalEndMs: 2000,
    preferredShiftLimitMs: 300,
    overlapGroupId: null,
    syncStatus: 'unmeasured',
    qaStatus: 'not_run',
    reviewStatus: 'unreviewed',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('Language, Relationship, Multimodal & Synchronization Intelligence', () => {
  it('deduplicates overlapping Japanese ASR stride chunks and normalizes text', () => {
    const normalized = deduplicateAsrChunks(
      [
        { text: '  ここから先 は俺が引き受ける 。 ', timestamp: [0.0, 2.5] },
        { text: 'ここから先 は俺が引き受ける。', timestamp: [0.25, 2.6] }, // boundary duplicate within 600ms
        { text: '大丈夫ですか？', timestamp: [3.0, 4.5] },
      ],
      5000
    );
    assert.equal(normalized.length, 2);
    assert.equal(normalized[0].japaneseText, 'ここから先 は俺が引き受ける。');
    assert.equal(normalized[1].startMs, 3000);
  });

  it('applies persistent Pronunciation Dictionary rules longest-match-first', () => {
    const rules: PronunciationEntry[] = [
      {
        id: 'p1',
        seriesScope: 'Global',
        sourceTerm: 'Neo Tokyo',
        targetHindiForm: 'नियो टोक्यो',
        phoneticHint: 'niyo tokyo',
        category: 'place',
        notes: '',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'p2',
        seriesScope: 'Global',
        sourceTerm: 'Tokyo',
        targetHindiForm: 'टोक्यो',
        phoneticHint: 'tokyo',
        category: 'place',
        notes: '',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    const out = applyPronunciationDictionary('हम Neo Tokyo से Tokyo जा रहे हैं।', rules);
    assert.equal(out.text, 'हम नियो टोक्यो से टोक्यो जा रहे हैं।');
    assert.equal(out.appliedOverrides.length, 2);
  });

  it('never invents relationships from 1 isolated sentence, and infers formal register from >= 2 exchanges', () => {
    const c1 = makeCharacter({ characterId: 'CHR-1', displayName: 'Ren' });
    const c2 = makeCharacter({ characterId: 'CHR-2', displayName: 'Sensei' });

    // Single isolated exchange -> must produce 0 relationships
    const singleRun = analyzeCharacterRelationshipsFromDialogue(
      [c1, c2],
      [
        makeSegment({ segmentId: 'S1', characterId: 'CHR-2', originalStartMs: 0, originalEndMs: 1500, japaneseText: 'おはよう' }),
        makeSegment({ segmentId: 'S2', characterId: 'CHR-1', originalStartMs: 1800, originalEndMs: 3200, japaneseText: '先生、おはようございます。' }),
      ]
    );
    assert.equal(singleRun.size, 0);

    // Multi-turn >=2 exchanges -> infers Respectful / Formal (Aap)
    const multiRun = analyzeCharacterRelationshipsFromDialogue(
      [c1, c2],
      [
        makeSegment({ segmentId: 'S1', characterId: 'CHR-2', originalStartMs: 0, originalEndMs: 1500, japaneseText: 'おはよう' }),
        makeSegment({ segmentId: 'S2', characterId: 'CHR-1', originalStartMs: 1800, originalEndMs: 3200, japaneseText: '先生、おはようございます。' }),
        makeSegment({ segmentId: 'S3', characterId: 'CHR-2', originalStartMs: 3600, originalEndMs: 4800, japaneseText: '準備はいいか？' }),
        makeSegment({ segmentId: 'S4', characterId: 'CHR-1', originalStartMs: 5200, originalEndMs: 6500, japaneseText: 'はい、先生、大丈夫です。' }),
      ]
    );
    const renRels = multiRun.get('CHR-1') ?? [];
    assert.equal(renRels.length, 1);
    assert.ok(renRels[0].politenessRegister.includes('Aap'));
  });

  it('detects emotions from acoustic + lexical cues without relying on punctuation', () => {
    const whisper = detectEmotionHybrid({
      japaneseText: '静かにして',
      hindiText: 'शांत रहो',
      energyDb: -36,
    });
    assert.equal(whisper.primaryEmotion, 'Whispering');

    const angryShout = detectEmotionHybrid({
      japaneseText: 'ふざけるな 黙れ',
      hindiText: 'चुप रहो',
      energyDb: -9,
    });
    assert.equal(angryShout.primaryEmotion, 'Angry');
    assert.equal(angryShout.secondaryEmotion, 'Shouting');
  });

  it('flags audio-only / off-screen speakers for review instead of guessing face matches', () => {
    const speakers: Speaker[] = [
      {
        id: 'spk_1',
        projectId: 'prj_1',
        speakerLabel: 'SPK_01',
        roleType: 'on_screen',
        totalDurationMs: 5000,
        segmentCount: 3,
        estimatedPitchHz: 145,
        matchedCharacterId: null,
        matchConfidence: 0.85,
        reviewStatus: 'needs_review',
      },
    ];
    const res = computeMultimodalFaceVoiceMatches({
      projectId: 'prj_1',
      speakers,
      speakerTurnTimestamps: { SPK_01: [{ startMs: 0, endMs: 2000 }] },
      visualTracks: [],
      existingCharacters: [],
    });
    assert.equal(res.associations.length, 1);
    assert.equal(res.associations[0].visualEvidenceScore, 0);
    assert.equal(res.associations[0].status, 'needs_review');
  });

  it('preserves locked permanent Hindi Voice IDs and builds transparent post-synthesis acting directives', () => {
    const lockedChar = makeCharacter({
      assignedHindiVoiceId: 'mms_hin_bright',
      voiceLocked: true,
      voiceCharacteristics: {
        pitchRange: '110–130 Hz',
        timbre: 'Deep',
        pacing: 'Slow',
        ageEstimate: 'Adult',
        genderPresentation: 'Masculine-leaning',
        pitchMeanHz: 118,
      },
    });
    const chosen = selectBestVoiceForCharacter(lockedChar, SAMPLE_VOICES);
    assert.equal(chosen?.voiceId, 'mms_hin_bright', 'Must never overwrite locked voice');

    const directive = buildVoiceActingDirective(
      { primaryEmotion: 'Sad', intensity: 0.8, deliveryNotes: '', source: 'acoustic_lexical_hybrid' },
      chosen
    );
    assert.equal(directive.controlSource, 'post_synthesis_dsp');
    assert.ok(directive.speakingRateMultiplier >= 0.88 && directive.speakingRateMultiplier <= 1.14);
  });

  it('synchronizes generated audio within ±300ms tolerance, caps speed at 1.15x, and flags overly long lines for review', () => {
    // Fits within tolerance natively
    const nativeFit = computeSynchronizedPlacement({
      originalStartMs: 2000,
      originalEndMs: 4000,
      measuredAudioDurationMs: 2200,
      preferredShiftLimitMs: 300,
    });
    assert.equal(nativeFit.syncStatus, 'in_tolerance');
    assert.equal(nativeFit.appliedSpeedMultiplier, 1.0);

    // Excessively long generated Hindi audio -> must cap speed at 1.15x & flag needs_review
    const tooLong = computeSynchronizedPlacement({
      originalStartMs: 2000,
      originalEndMs: 3500, // 1.5s original
      measuredAudioDurationMs: 3200, // >2x original
      preferredShiftLimitMs: 300,
      nextSegmentStartMs: 3600,
    });
    assert.equal(tooLong.appliedSpeedMultiplier, 1.15);
    assert.equal(tooLong.reviewStatus, 'needs_review');
    assert.equal(tooLong.syncStatus, 'needs_adjustment');
  });
});
