import type {
  CharacterProfile,
  CharacterRelationship,
  ContextSnapshot,
  DialogueSegment,
  EmotionMetadata,
  PronunciationEntry,
  Scene,
} from '../../types/domain';

export interface AsrRawChunk {
  text: string;
  timestamp: [number, number | null];
}

export interface NormalizedAsrSegment {
  startMs: number;
  endMs: number;
  japaneseText: string;
  confidence: number;
}

/**
 * Normalizes Japanese ASR text (NFKC full-width cleanup, punctuation spacing, trim).
 */
export function normalizeJapaneseText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/\s+([。、！？])/g, '$1')
    .trim();
}

/**
 * Deduplicates overlapping Japanese ASR chunks produced at 30s / 5s stride boundaries
 * while preserving global timestamps and overlapping speech.
 */
export function deduplicateAsrChunks(
  chunks: AsrRawChunk[],
  totalDurationMs: number
): NormalizedAsrSegment[] {
  const cleaned: NormalizedAsrSegment[] = [];

  for (const ch of chunks) {
    const text = normalizeJapaneseText(ch.text ?? '');
    if (!text) continue;
    const startSec = Math.max(0, ch.timestamp?.[0] ?? 0);
    const endSec =
      ch.timestamp?.[1] !== null && ch.timestamp?.[1] !== undefined
        ? Math.max(startSec + 0.2, ch.timestamp[1])
        : Math.min(totalDurationMs / 1000, startSec + 2.5);

    const startMs = Math.round(startSec * 1000);
    const endMs = Math.min(Math.max(startMs + 200, Math.round(endSec * 1000)), Math.max(totalDurationMs, startMs + 200));

    // Drop exact boundary duplicates within 600ms
    const prev = cleaned[cleaned.length - 1];
    if (
      prev &&
      prev.japaneseText === text &&
      Math.abs(prev.startMs - startMs) <= 600
    ) {
      continue;
    }

    cleaned.push({
      startMs,
      endMs,
      japaneseText: text,
      confidence: 0.82,
    });
  }

  return cleaned;
}

/**
 * Pronunciation Agent (#15): Applies persistent pronunciation dictionary rules across
 * source Japanese names, places, fictional terms, and English loanwords inside Hindi text.
 */
export function applyPronunciationDictionary(
  text: string,
  entries: PronunciationEntry[]
): { text: string; appliedOverrides: Array<{ term: string; reading: string }> } {
  let result = text;
  const appliedOverrides: Array<{ term: string; reading: string }> = [];

  // Longest sourceTerm first prevents partial substring collisions
  const sorted = [...entries].sort(
    (a, b) => b.sourceTerm.length - a.sourceTerm.length
  );

  for (const entry of sorted) {
    if (!entry.sourceTerm.trim() || !entry.targetHindiForm.trim()) continue;
    if (result.includes(entry.sourceTerm)) {
      result = result.split(entry.sourceTerm).join(entry.targetHindiForm);
      appliedOverrides.push({
        term: entry.sourceTerm,
        reading: entry.targetHindiForm,
      });
    }
  }

  return { text: result, appliedOverrides };
}

/**
 * Context Intelligence Agent (#14): Builds a bounded memory-safe context snapshot
 * containing scene summaries, character speaking styles, registers, and active terminology.
 */
export function buildProjectContextSnapshot(params: {
  projectId: string;
  scenes: Scene[];
  characters: CharacterProfile[];
  pronunciations: PronunciationEntry[];
  windowSize?: number;
}): ContextSnapshot {
  const { projectId, scenes, characters, pronunciations, windowSize = 5 } = params;
  return {
    id: `ctx_${projectId}`,
    projectId,
    sceneCount: scenes.length,
    windowSize,
    terminology: pronunciations
      .slice(0, 40)
      .map((p) => `${p.sourceTerm} → ${p.targetHindiForm}`),
    characterBriefs: characters.slice(0, 24).map((c) => ({
      characterId: c.characterId,
      name: c.displayName,
      speakingStyle: c.speakingStyle,
      registerSummary:
        c.relationships.length > 0
          ? c.relationships
              .map((r) => `${r.targetName}: ${r.politenessRegister}`)
              .join('; ')
          : 'Default conversational register',
    })),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Relationship Intelligence Agent (#11): Analyzes multi-turn dialogue history to detect
 * politeness registers (Aap / Tum / Tu) and interpersonal dynamics.
 * Explicitly requires >= 2 co-occurring exchanges — never invents relationships from 1 isolated sentence.
 */
export function analyzeCharacterRelationshipsFromDialogue(
  characters: CharacterProfile[],
  segments: DialogueSegment[]
): Map<string, CharacterRelationship[]> {
  const byChar = new Map<string, CharacterRelationship[]>();
  const charMap = new Map(characters.map((c) => [c.characterId, c]));

  // Track directed pair interactions across adjacent dialogue turns within 12 seconds
  const pairStats = new Map<
    string,
    {
      fromId: string;
      toId: string;
      turns: number;
      formalHits: number;
      casualHits: number;
      respectHits: number;
      conflictHits: number;
    }
  >();

  for (let i = 1; i < segments.length; i += 1) {
    const prev = segments[i - 1];
    const curr = segments[i];
    if (!prev.characterId || !curr.characterId || prev.characterId === curr.characterId) {
      continue;
    }
    if (curr.originalStartMs - prev.originalEndMs > 12000) {
      continue;
    }

    const key = `${curr.characterId}::${prev.characterId}`;
    const stat = pairStats.get(key) ?? {
      fromId: curr.characterId,
      toId: prev.characterId,
      turns: 0,
      formalHits: 0,
      casualHits: 0,
      respectHits: 0,
      conflictHits: 0,
    };

    stat.turns += 1;
    const jp = curr.japaneseText;
    if (/です|ます|ございます|ください|さん|様|先生|先輩/.test(jp)) stat.formalHits += 1;
    if (/様|先生|先輩/.test(jp)) stat.respectHits += 1;
    if (/お前|てめえ|だぜ|だよ|じゃん|くん|ちゃん/.test(jp)) stat.casualHits += 1;
    if (/黙れ|ふざけるな|許さない|くそ|やめろ/.test(jp)) stat.conflictHits += 1;

    pairStats.set(key, stat);
  }

  for (const stat of pairStats.values()) {
    // Guardrail: never invent relationships from a single isolated sentence
    if (stat.turns < 2) continue;
    const target = charMap.get(stat.toId);
    if (!target) continue;

    let relationType = 'Recurring Conversational Partner';
    let politenessRegister = 'Neutral / Familiar (Tum)';
    if (stat.conflictHits >= 2) {
      relationType = 'Rival / Conflict Dynamic';
      politenessRegister = 'Direct / Confrontational (Tu / Tum)';
    } else if (stat.respectHits >= 1 || stat.formalHits > stat.casualHits) {
      relationType = stat.respectHits >= 1 ? 'Mentor / Senior / Respected' : 'Formal Acquaintance';
      politenessRegister = 'Respectful / Formal (Aap)';
    } else if (stat.casualHits >= 1) {
      relationType = 'Close Peer / Informal';
      politenessRegister = 'Informal / Close (Tum / Tu)';
    }

    const list = byChar.get(stat.fromId) ?? [];
    list.push({
      targetCharacterId: stat.toId,
      targetName: target.displayName,
      relationType,
      politenessRegister,
      notes: `Inferred from ${stat.turns} multi-turn exchanges (formal=${stat.formalHits}, casual=${stat.casualHits}).`,
    });
    byChar.set(stat.fromId, list);
  }

  return byChar;
}

/**
 * Emotion Detection Agent (#16): Combines acoustic cues (energy dB, pitch variation, speaking rate)
 * + Japanese/Hindi lexical cues + optional multilingual sentiment classifier label.
 * Never assigns emotion solely from punctuation!
 */
export function detectEmotionHybrid(params: {
  japaneseText: string;
  hindiText: string;
  energyDb?: number | null;
  pitchVariationHz?: number | null;
  speakingRateCps?: number | null;
  sentimentModelLabel?: { label: string; score: number } | null;
}): EmotionMetadata {
  const {
    japaneseText,
    hindiText,
    energyDb = null,
    pitchVariationHz = null,
    speakingRateCps = null,
    sentimentModelLabel = null,
  } = params;

  const combined = `${japaneseText} ${hindiText}`;
  const acousticCues: string[] = [];
  const textCues: string[] = [];

  let primaryEmotion = 'Calm';
  let secondaryEmotion: string | null = null;
  let intensity = 0.4;
  let confidence = 0.58;

  // 1. Acoustic delivery cues (Whispering / Shouting / High-arousal)
  if (energyDb !== null) {
    if (energyDb <= -32) {
      primaryEmotion = 'Whispering';
      intensity = 0.65;
      confidence = 0.72;
      acousticCues.push(`Low RMS loudness (${energyDb} dB)`);
    } else if (energyDb >= -11) {
      primaryEmotion = 'Shouting';
      intensity = 0.85;
      confidence = 0.75;
      acousticCues.push(`High RMS projection (${energyDb} dB)`);
    } else {
      acousticCues.push(`Moderate vocal energy (${energyDb} dB)`);
    }
  }

  if (pitchVariationHz !== null && pitchVariationHz >= 95) {
    acousticCues.push(`Wide pitch excursion (${pitchVariationHz} Hz)`);
    intensity = Math.min(0.95, intensity + 0.15);
  }

  if (speakingRateCps !== null && speakingRateCps >= 8) {
    acousticCues.push(`Rapid delivery (${speakingRateCps} chars/s)`);
  }

  // 2. Lexical / semantic Japanese & Hindi indicators (beyond punctuation)
  if (/はは|ふふ|笑|嬉しい|ありがとう|よかった|खुश|धन्यवाद|बढ़िया/.test(combined)) {
    if (primaryEmotion === 'Calm') primaryEmotion = 'Happy';
    else secondaryEmotion = 'Happy';
    if (/はは|ふふ|笑/.test(combined)) primaryEmotion = 'Laughter';
    textCues.push('Positive / joyful lexical marker');
    confidence = Math.max(confidence, 0.74);
  } else if (/悲しい|ごめん|すまない|泣|つらい|दुख|माफ़|रो/.test(combined)) {
    primaryEmotion = /泣|रो/.test(combined) ? 'Crying' : 'Sad';
    intensity = Math.max(intensity, 0.65);
    textCues.push('Sorrow / remorse lexical marker');
    confidence = Math.max(confidence, 0.74);
  } else if (/許さない|ふざけるな|黙れ|くそ|怒|गुस्सा|चुप|बकवास/.test(combined)) {
    primaryEmotion = primaryEmotion === 'Shouting' ? 'Angry' : 'Angry';
    secondaryEmotion = energyDb !== null && energyDb >= -11 ? 'Shouting' : null;
    intensity = Math.max(intensity, 0.8);
    textCues.push('Conflict / anger lexical marker');
    confidence = Math.max(confidence, 0.78);
  } else if (/怖い|助けて|逃げろ|やばい|डर|बचाओ|भागो/.test(combined)) {
    primaryEmotion = 'Fearful';
    intensity = Math.max(intensity, 0.75);
    textCues.push('Fear / urgency lexical marker');
    confidence = Math.max(confidence, 0.75);
  } else if (/まさか|本当|信じられない|えっ|सच|यकीन|अरे/.test(combined)) {
    primaryEmotion = 'Surprised';
    intensity = Math.max(intensity, 0.7);
    textCues.push('Surprise / disbelief lexical marker');
    confidence = Math.max(confidence, 0.72);
  } else if (/任せて|大丈夫|必ず|引き受ける|भरोसा|पक्का|ज़िम्मेदारी/.test(combined)) {
    primaryEmotion = 'Confident';
    intensity = Math.max(intensity, 0.68);
    textCues.push('Determination / confidence lexical marker');
    confidence = Math.max(confidence, 0.73);
  } else if (/皮肉|へえ|なるほどね|वाह क्या बात/.test(combined)) {
    primaryEmotion = 'Sarcastic';
    intensity = Math.max(intensity, 0.6);
    textCues.push('Ironic / sarcastic lexical marker');
    confidence = Math.max(confidence, 0.66);
  } else if (/すごい|やった|最高|कमाल|ज़बरदस्त/.test(combined)) {
    primaryEmotion = 'Excited';
    intensity = Math.max(intensity, 0.78);
    textCues.push('Excitement lexical marker');
    confidence = Math.max(confidence, 0.74);
  }

  // 3. Optional ONNX multilingual sentiment reinforcement
  if (sentimentModelLabel) {
    const lbl = sentimentModelLabel.label.toLowerCase();
    textCues.push(
      `Multilingual ONNX sentiment: ${sentimentModelLabel.label} (${Math.round(
        sentimentModelLabel.score * 100
      )}%)`
    );
    if (lbl.includes('positive') && primaryEmotion === 'Calm' && sentimentModelLabel.score > 0.65) {
      primaryEmotion = 'Happy';
      confidence = Math.max(confidence, Math.round(sentimentModelLabel.score * 100) / 100);
    } else if (
      lbl.includes('negative') &&
      primaryEmotion === 'Calm' &&
      sentimentModelLabel.score > 0.65
    ) {
      primaryEmotion = 'Sad';
      confidence = Math.max(confidence, Math.round(sentimentModelLabel.score * 100) / 100);
    }
  }

  if (secondaryEmotion && secondaryEmotion !== primaryEmotion) {
    textCues.push(`Mixed tone: ${primaryEmotion} + ${secondaryEmotion}`);
  }

  return {
    primaryEmotion,
    secondaryEmotion,
    intensity: Math.round(intensity * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    deliveryNotes:
      [...acousticCues, ...textCues].join(' · ') || 'Neutral acoustic & lexical baseline',
    acousticCues,
    textCues,
    source: sentimentModelLabel ? 'prompt2_model' : 'acoustic_lexical_hybrid',
  };
}

/**
 * Applies Hindi politeness register alignment based on CharacterRelationship context
 * while preserving the intended meaning.
 */
export function refineHindiWithContextAndPronunciation(
  rawHindi: string,
  pronunciations: PronunciationEntry[],
  politenessRegister?: string
): { hindiText: string; appliedOverrides: Array<{ term: string; reading: string }> } {
  const { text: afterPron, appliedOverrides } = applyPronunciationDictionary(
    rawHindi.trim(),
    pronunciations
  );
  let refined = afterPron;

  if (politenessRegister && /Respectful|Formal|Aap/i.test(politenessRegister)) {
    refined = refined.replace(/\bतुम\b/g, 'आप').replace(/\bतू\b/g, 'आप');
  }

  return {
    hindiText: refined,
    appliedOverrides,
  };
}
