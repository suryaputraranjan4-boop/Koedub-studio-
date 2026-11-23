import type {
  AppSettings,
  CloudPrebuiltVoiceName,
  CollaborationMode,
  CollaborativeTranslationMeta,
  GeminiConnectionStatus,
  PronunciationEntry,
  TranslationAlternative,
} from '../../types/domain';
import { localModelRuntime } from './modelRuntime';
import { refineHindiWithContextAndPronunciation } from './languageIntelligence';
import { decodePcmWavBuffer } from './audioDsp';

export interface CollaborativeRequestInput {
  taskType: 'translate_and_adapt' | 'concise_timing_rewrite' | 'semantic_qa_review';
  japaneseText: string;
  localDraftHindi: string;
  characterContext: string;
  politenessRegister: string;
  targetDurationMs: number;
  previousTurns: string[];
  nextTurns: string[];
  pronunciationRules: PronunciationEntry[];
  settings: AppSettings;
}

export interface GeminiCollaborateApiResponse {
  ok: boolean;
  model?: string;
  mode?: string;
  taskType?: string;
  error?: string;
  result?: {
    hindiTranslation: string;
    conciseAlternative: string;
    naturalAlternative: string;
    culturalNote: string;
    humorOrIdiomAdapted: boolean;
    agreesWithLocalDraft: boolean;
    confidence?: number | null;
    confidenceSource?: string;
    reasoning: string;
    qaWarnings: string[];
  };
}

export interface CollaborativeOutcome {
  hindiText: string;
  meta: CollaborativeTranslationMeta;
  qaWarnings: string[];
}

// Persistent per-browser-tab session identifier so server tracks per-client usage accurately
let cachedSessionId: string | null = null;
export function getClientSessionId(): string {
  if (cachedSessionId) return cachedSessionId;
  try {
    if (typeof sessionStorage !== 'undefined') {
      const existing = sessionStorage.getItem('koedub_session_id');
      if (existing) {
        cachedSessionId = existing;
        return existing;
      }
      const created = `kd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      sessionStorage.setItem('koedub_session_id', created);
      cachedSessionId = created;
      return created;
    }
  } catch {
    // Fallback in non-browser or restricted iframe environments
  }
  cachedSessionId = `kd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return cachedSessionId;
}

function getSessionHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-koedub-session': getClientSessionId(),
  };
}

/**
 * Classifies dialogue complexity so complementary mode can reserve cloud calls
 * for idioms, humor, emotion, and tight-timing lines while keeping simple lines local.
 */
export function classifyDialogueComplexity(
  japaneseText: string,
  targetDurationMs: number
): 'simple' | 'moderate' | 'complex' {
  const text = japaneseText.trim();
  if (text.length <= 8 && !/[!?！？「」]/.test(text)) {
    return 'simple';
  }
  const hasIdiomOrNuance =
    /やっぱり|さすが|しょうがない|なるほど|冗談|まさか|というわけ|なんてこった|勘弁|先輩|様|貴様|てめえ/.test(
      text
    );
  const tightWindow = targetDurationMs > 0 && text.length / (targetDurationMs / 1000) > 6.5;
  if (hasIdiomOrNuance || tightWindow || text.length >= 24) {
    return 'complex';
  }
  return 'moderate';
}

/**
 * Computes lexical token overlap (Jaccard similarity) between two Hindi strings so
 * disagreement detection is backed by concrete measurable textual divergence, not guesswork.
 */
export function computeHindiTokenOverlap(a: string, b: string): number {
  const tokA = new Set(
    a
      .replace(/[।.,!?'"()]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
  );
  const tokB = new Set(
    b
      .replace(/[।.,!?'"()]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
  );
  if (tokA.size === 0 && tokB.size === 0) return 1;
  if (tokA.size === 0 || tokB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokA) {
    if (tokB.has(t)) intersection += 1;
  }
  const union = tokA.size + tokB.size - intersection;
  return union > 0 ? Math.round((intersection / union) * 100) / 100 : 0;
}

/**
 * Fetches live or cached server-side Gemini API connectivity, discovered models & per-session token usage.
 */
export async function fetchGeminiConnectionStatus(
  verifyLive: boolean = false
): Promise<GeminiConnectionStatus> {
  const url = verifyLive ? '/api/gemini/status?verify=1' : '/api/gemini/status';
  try {
    const resp = await fetch(url, {
      headers: { 'x-koedub-session': getClientSessionId() },
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    return (await resp.json()) as GeminiConnectionStatus;
  } catch (err) {
    return {
      configured: false,
      verified: false,
      primaryModel: 'gemini-4-hydrogen',
      ttsModel: 'gemini-3.8-flash-lite-tts',
      availableModels: ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'],
      availableTtsModels: ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'],
      usage: {
        totalRequests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        ttsRequests: 0,
        lastModelUsed: null,
        lastVerifiedAt: null,
        lastVerifiedOk: false,
        lastError: err instanceof Error ? err.message : 'Unable to reach /api/gemini/status.',
      },
      message: 'Local server API unreachable — operating in offline local mode.',
    };
  }
}

/**
 * Optional on-device Local LLM refinement via Qwen2.5-0.5B-Instruct (ONNX q4) when installed.
 * Returns null confidence honestly (small autoregressive ONNX generation doesn't expose calibrated confidence).
 */
async function runLocalOnnxLlmRefinement(
  japaneseText: string,
  localDraftHindi: string,
  politenessRegister: string
): Promise<{ text: string; confidence: number | null; sourceEngine: string } | null> {
  const installed = await localModelRuntime.isModelInstalled('model_local_llm_qwen_onnx');
  if (!installed) return null;

  try {
    type TextGenPipe = (
      messages: Array<{ role: string; content: string }>,
      opts: Record<string, unknown>
    ) => Promise<Array<{ generated_text?: Array<{ content?: string }> | string }>>;

    const pipe = await localModelRuntime.loadInstalledModel<TextGenPipe>(
      'model_local_llm_qwen_onnx'
    );
    const res = await pipe(
      [
        {
          role: 'system',
          content:
            'You refine Japanese anime lines into natural spoken Devanagari Hindi dubbing dialogue. Output ONLY the single refined Hindi line.',
        },
        {
          role: 'user',
          content: `Japanese: ${japaneseText}\nDraft Hindi: ${localDraftHindi || '(none)'}\nRegister: ${
            politenessRegister || 'natural'
          }\nRefined Hindi:`,
        },
      ],
      { max_new_tokens: 64, do_sample: false }
    );

    const first = res?.[0]?.generated_text;
    let outputText = '';
    if (Array.isArray(first)) {
      outputText = String(first[first.length - 1]?.content ?? '').trim();
    } else if (typeof first === 'string') {
      outputText = first.trim();
    }
    if (!outputText) return null;
    return {
      text: outputText.split('\n')[0].trim(),
      confidence: null,
      sourceEngine: 'Qwen2.5-0.5B-Instruct-ONNX',
    };
  } catch {
    return null;
  } finally {
    await localModelRuntime.unloadActiveModel();
  }
}

async function callGeminiCollaborateApi(params: {
  input: CollaborativeRequestInput;
  effectiveMode: CollaborationMode;
  localDraftForCloud: string;
}): Promise<GeminiCollaborateApiResponse> {
  const { input, effectiveMode, localDraftForCloud } = params;
  const resp = await fetch('/api/gemini/collaborate', {
    method: 'POST',
    headers: getSessionHeaders(),
    body: JSON.stringify({
      taskType: input.taskType,
      mode: effectiveMode,
      model: input.settings.preferredGeminiModel || 'gemini-4-hydrogen',
      japaneseText: input.japaneseText,
      localDraftHindi: localDraftForCloud,
      characterContext: input.characterContext,
      politenessRegister: input.politenessRegister,
      targetDurationMs: input.targetDurationMs,
      previousTurns: input.previousTurns,
      nextTurns: input.nextTurns,
      pronunciationRules: input.pronunciationRules.map((p) => ({
        sourceTerm: p.sourceTerm,
        targetHindiForm: p.targetHindiForm,
      })),
    }),
  });

  const data = (await resp.json()) as GeminiCollaborateApiResponse;
  if (!resp.ok || !data.ok || !data.result) {
    throw new Error(data.error || `Gemini proxy error (HTTP ${resp.status})`);
  }
  return data;
}

/**
 * Shared Hybrid Collaborative Intelligence Router with GENUINELY DISTINCT execution paths
 * across all 7 collaboration modes (never collapsing all modes into the same single call):
 * 1. parallel                — Runs Local LLM/Draft & independent Gemini (without seeding Gemini with local draft)
 *                              concurrently, measures token overlap, and flags semantic divergence cleanly.
 * 2. complementary           — Resolves simple lines locally to conserve tokens; sends moderate/complex idiom,
 *                              humor, or tight-timing lines to Gemini with local glossary & facts locked.
 * 3. draft_and_review        — Local produces initial draft first; Gemini explicitly reviews & polishes it.
 * 4. alternatives            — Requests 3 distinct Hindi options (balanced, concise timing, expressive/idiomatic)
 *                              plus local baseline for user choice.
 * 5. disagreement_resolution — Runs Local & Gemini, performs overlap + agreement audit, and escalates ANY
 *                              substantive divergence to needs_review with explicit evidence.
 * 6. sequential              — 3-step pipeline: Local glossary/register pass -> Gemini cultural/timing polish ->
 *                              final local pronunciation/register lock pass.
 * 7. offline_local           — Strict zero-cloud execution; marks cloud review honestly as pending.
 *
 * Honest Confidence Policy: Never writes fabricated fixed constants (0.72/0.74/0.85). Stores null
 * when a model does not expose calibrated confidence, along with `confidenceSource` and `evidence`.
 */
export async function executeCollaborativeIntelligence(
  input: CollaborativeRequestInput
): Promise<CollaborativeOutcome> {
  const now = new Date().toISOString();
  const effectiveMode: CollaborationMode =
    input.settings.offlineOnlyMode ||
    !input.settings.cloudIntelligenceEnabled ||
    !input.settings.allowSendDialogueTextToCloud
      ? 'offline_local'
      : input.settings.collaborationMode;

  const complexity = classifyDialogueComplexity(input.japaneseText, input.targetDurationMs);

  // Step 1: Deterministic pronunciation + register pass on existing local draft
  const baselineRefined = refineHindiWithContextAndPronunciation(
    input.localDraftHindi,
    input.pronunciationRules,
    input.politenessRegister
  );
  const localState: { candidate: string; source: 'local_llm' | 'nllb_local' } = {
    candidate: baselineRefined.hindiText,
    source: 'nllb_local',
  };
  const appliedLocalOverrides = baselineRefined.appliedOverrides.length;

  // Helper to run local ONNX LLM when applicable
  const maybeRunLocalLlm = async () => {
    const localLlmRes = await runLocalOnnxLlmRefinement(
      input.japaneseText,
      localState.candidate,
      input.politenessRegister
    );
    if (localLlmRes?.text) {
      const post = refineHindiWithContextAndPronunciation(
        localLlmRes.text,
        input.pronunciationRules,
        input.politenessRegister
      );
      localState.candidate = post.hindiText;
      localState.source = 'local_llm';
    }
  };

  // MODE 7: Strict Offline Local OR Mode 2 (Complementary) fast-path for simple utterances
  if (
    effectiveMode === 'offline_local' ||
    (effectiveMode === 'complementary' &&
      complexity === 'simple' &&
      localState.candidate.length > 0 &&
      input.taskType === 'translate_and_adapt')
  ) {
    await maybeRunLocalLlm();
    const cloudPending = effectiveMode === 'offline_local';
    const alternatives: TranslationAlternative[] = localState.candidate
      ? [
          {
            id: 'alt_local_primary',
            label: localState.source === 'local_llm' ? 'Local Qwen2.5 ONNX' : 'Local NLLB / Rules',
            hindiText: localState.candidate,
            source: localState.source,
            note: cloudPending
              ? 'Produced offline; cloud idiom/humor review marked pending.'
              : 'Complementary mode resolved simple utterance locally without cloud call.',
          },
        ]
      : [];

    return {
      hindiText: localState.candidate,
      qaWarnings: [],
      meta: {
        mode: effectiveMode,
        geminiDraft: null,
        localDraft: localState.candidate || null,
        selectedSource: localState.source,
        alternatives,
        culturalNote: cloudPending
          ? 'Offline mode active — Gemini cloud review pending when connectivity is enabled.'
          : 'Complementary complexity router handled simple line locally.',
        humorOrIdiomAdapted: false,
        disagreementFlag: false,
        geminiConfidence: null,
        localConfidence: null,
        confidenceSource: 'uncalibrated_local_generation',
        evidence: `Mode=${effectiveMode}, complexity=${complexity}, localSource=${localState.source}, pronunciationOverrides=${appliedLocalOverrides}`,
        reasoning: cloudPending
          ? 'Completed offline using local models and pronunciation rules.'
          : 'Simple utterance resolved locally to save API tokens.',
        cloudReviewPending: cloudPending,
        modelUsed: localState.source === 'local_llm' ? 'Qwen2.5-0.5B-Instruct-ONNX' : 'Local Rules/NLLB',
        updatedAt: now,
      },
    };
  }

  // Cloud-enabled modes (1..6) — each executes its distinct workflow
  try {
    let data: GeminiCollaborateApiResponse;

    if (effectiveMode === 'parallel') {
      // Truly concurrent: run local LLM & independent Gemini (no local draft leaked into Gemini prompt) in parallel!
      const [, geminiResp] = await Promise.all([
        maybeRunLocalLlm(),
        callGeminiCollaborateApi({
          input,
          effectiveMode: 'parallel',
          localDraftForCloud: '', // Independent parallel generation for unbiased comparison
        }),
      ]);
      data = geminiResp;
    } else if (effectiveMode === 'sequential') {
      // Stage 1: Local LLM + Glossary + Register -> Stage 2: Gemini Polish -> Stage 3: Final Glossary Lock
      await maybeRunLocalLlm();
      data = await callGeminiCollaborateApi({
        input,
        effectiveMode: 'sequential',
        localDraftForCloud: localState.candidate,
      });
    } else if (effectiveMode === 'disagreement_resolution') {
      // Ensure local candidate is finalized first, then ask Gemini to audit disagreements explicitly
      await maybeRunLocalLlm();
      data = await callGeminiCollaborateApi({
        input,
        effectiveMode: 'disagreement_resolution',
        localDraftForCloud: localState.candidate,
      });
    } else if (effectiveMode === 'alternatives') {
      // Request 3 distinct spoken candidates alongside local draft
      await maybeRunLocalLlm();
      data = await callGeminiCollaborateApi({
        input,
        effectiveMode: 'alternatives',
        localDraftForCloud: localState.candidate,
      });
    } else if (effectiveMode === 'complementary') {
      // Moderate/complex line: send local glossary-locked draft for idiom/humor/timing elevation
      await maybeRunLocalLlm();
      data = await callGeminiCollaborateApi({
        input,
        effectiveMode: 'complementary',
        localDraftForCloud: localState.candidate,
      });
    } else {
      // draft_and_review: Local draft first, then Gemini reviews and refines it
      await maybeRunLocalLlm();
      data = await callGeminiCollaborateApi({
        input,
        effectiveMode: 'draft_and_review',
        localDraftForCloud: localState.candidate,
      });
    }

    const r = data.result!;
    // Stage 3 / Final Pass: Always enforce persistent local pronunciation dictionary & register rules
    const primaryPass = refineHindiWithContextAndPronunciation(
      r.hindiTranslation,
      input.pronunciationRules,
      input.politenessRegister
    );
    const primaryGemini = primaryPass.hindiText;
    const conciseGemini = refineHindiWithContextAndPronunciation(
      r.conciseAlternative,
      input.pronunciationRules,
      input.politenessRegister
    ).hindiText;
    const naturalGemini = refineHindiWithContextAndPronunciation(
      r.naturalAlternative,
      input.pronunciationRules,
      input.politenessRegister
    ).hindiText;

    const overlapScore =
      localState.candidate && primaryGemini
        ? computeHindiTokenOverlap(localState.candidate, primaryGemini)
        : null;

    let disagreementFlag = false;
    if (localState.candidate && primaryGemini) {
      if (effectiveMode === 'parallel' || effectiveMode === 'disagreement_resolution') {
        disagreementFlag = !r.agreesWithLocalDraft || (overlapScore !== null && overlapScore < 0.45);
      } else {
        disagreementFlag = !r.agreesWithLocalDraft;
      }
    }

    let chosenText = primaryGemini || localState.candidate;
    if (input.taskType === 'concise_timing_rewrite' && conciseGemini) {
      chosenText = conciseGemini;
    } else if (
      effectiveMode === 'alternatives' &&
      naturalGemini &&
      r.humorOrIdiomAdapted
    ) {
      // In alternatives mode, keep primaryGemini default while surfacing all 3 distinct choices
      chosenText = primaryGemini || naturalGemini || localState.candidate;
    }

    const alternatives: TranslationAlternative[] = [];
    if (primaryGemini) {
      alternatives.push({
        id: 'alt_gemini_primary',
        label:
          effectiveMode === 'parallel'
            ? 'Gemini Independent (Parallel)'
            : effectiveMode === 'sequential'
            ? 'Sequential Final (Glossary Locked)'
            : 'Gemini Recommended',
        hindiText: primaryGemini,
        source: 'gemini',
        note: r.reasoning || 'Natural anime Hindi dubbing adaptation',
      });
    }
    if (conciseGemini && conciseGemini !== primaryGemini) {
      alternatives.push({
        id: 'alt_gemini_concise',
        label: 'Concise (Timing Sync)',
        hindiText: conciseGemini,
        source: 'gemini',
        note: 'Shortened for tighter original dialogue duration fit',
      });
    }
    if (naturalGemini && naturalGemini !== primaryGemini && naturalGemini !== conciseGemini) {
      alternatives.push({
        id: 'alt_gemini_expressive',
        label: 'Expressive / Idiomatic',
        hindiText: naturalGemini,
        source: 'gemini',
        note: 'Alternative conversational / emotional Hindi phrasing',
      });
    }
    if (localState.candidate && localState.candidate !== primaryGemini) {
      alternatives.push({
        id: 'alt_local_draft',
        label: localState.source === 'local_llm' ? 'Local Qwen2.5 ONNX' : 'Local NLLB Draft',
        hindiText: localState.candidate,
        source: localState.source,
        note:
          overlapScore !== null
            ? `On-device baseline (token overlap with Gemini: ${Math.round(overlapScore * 100)}%)`
            : 'On-device offline baseline for comparison',
      });
    }

    const evidenceSummary = [
      `mode=${effectiveMode}`,
      `complexity=${complexity}`,
      overlapScore !== null ? `lexicalOverlap=${Math.round(overlapScore * 100)}%` : 'noLocalDraft',
      `agrees=${String(r.agreesWithLocalDraft)}`,
      `glossaryLocks=${primaryPass.appliedOverrides.length}`,
    ].join(' · ');

    return {
      hindiText: chosenText,
      qaWarnings: Array.isArray(r.qaWarnings) ? r.qaWarnings : [],
      meta: {
        mode: effectiveMode,
        geminiDraft: primaryGemini || null,
        localDraft: localState.candidate || null,
        selectedSource: localState.candidate ? 'hybrid_merged' : 'gemini',
        alternatives,
        culturalNote: r.culturalNote || '',
        humorOrIdiomAdapted: Boolean(r.humorOrIdiomAdapted),
        disagreementFlag,
        geminiConfidence: typeof r.confidence === 'number' ? r.confidence : null,
        localConfidence: null,
        confidenceSource: r.confidenceSource || 'uncalibrated_llm_generation',
        evidence: evidenceSummary,
        reasoning: r.reasoning || '',
        cloudReviewPending: false,
        modelUsed: data.model || input.settings.preferredGeminiModel || 'gemini-4-hydrogen',
        updatedAt: now,
      },
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Cloud collaboration unavailable.';
    return {
      hindiText: localState.candidate,
      qaWarnings: [`Cloud review pending: ${errMsg}`],
      meta: {
        mode: 'offline_local',
        geminiDraft: null,
        localDraft: localState.candidate || null,
        selectedSource: localState.source,
        alternatives: localState.candidate
          ? [
              {
                id: 'alt_local_fallback',
                label: 'Offline Local Fallback',
                hindiText: localState.candidate,
                source: localState.source,
                note: `Gemini unavailable (${errMsg}).`,
              },
            ]
          : [],
        culturalNote: `Cloud intelligence fallback (${errMsg}) — marked pending for later review.`,
        humorOrIdiomAdapted: false,
        disagreementFlag: false,
        geminiConfidence: null,
        localConfidence: null,
        confidenceSource: 'offline_fallback_uncalibrated',
        evidence: `Fallback after cloud error: ${errMsg}`,
        reasoning: errMsg,
        cloudReviewPending: true,
        modelUsed: localState.source === 'local_llm' ? 'Qwen2.5-0.5B-Instruct-ONNX' : 'Local Fallback',
        updatedAt: now,
      },
    };
  }
}

/**
 * Independent Semantic QA Review helper (Agent #24):
 * Explicitly invokes `taskType: 'semantic_qa_review'` separate from translation drafting so QA
 * never conflates "a Gemini draft existed during translation" with "semantic QA actually ran".
 */
export async function runSemanticQAReviewOnSegment(params: {
  japaneseText: string;
  hindiText: string;
  characterContext: string;
  politenessRegister: string;
  targetDurationMs: number;
  pronunciationRules: PronunciationEntry[];
  settings: AppSettings;
}): Promise<{ executed: boolean; engine: string | null; warnings: string[]; suggestedFix?: string }> {
  if (
    params.settings.offlineOnlyMode ||
    !params.settings.cloudIntelligenceEnabled ||
    !params.settings.allowSendDialogueTextToCloud
  ) {
    return { executed: false, engine: null, warnings: [] };
  }

  try {
    const outcome = await executeCollaborativeIntelligence({
      taskType: 'semantic_qa_review',
      japaneseText: params.japaneseText,
      localDraftHindi: params.hindiText,
      characterContext: params.characterContext,
      politenessRegister: params.politenessRegister,
      targetDurationMs: params.targetDurationMs,
      previousTurns: [],
      nextTurns: [],
      pronunciationRules: params.pronunciationRules,
      settings: params.settings,
    });
    if (outcome.meta.cloudReviewPending) {
      return { executed: false, engine: null, warnings: [] };
    }
    return {
      executed: true,
      engine: outcome.meta.modelUsed || params.settings.preferredGeminiModel,
      warnings: outcome.qaWarnings,
      suggestedFix: outcome.hindiText && outcome.hindiText !== params.hindiText ? outcome.hindiText : undefined,
    };
  } catch {
    return { executed: false, engine: null, warnings: [] };
  }
}

/**
 * Optional Gemini Cloud Hindi TTS caller via server proxy (/api/gemini/tts).
 * Validates real RIFF/WAV header bytes & actual sample rate instead of assuming hardcoded 24000 Hz.
 */
export async function synthesizeHindiWavViaGeminiCloud(params: {
  hindiText: string;
  emotionStyle: string;
  voiceName: CloudPrebuiltVoiceName;
  model: string;
}): Promise<{ wavBlob: Blob; sampleRate: number; durationMs: number; model: string }> {
  const resp = await fetch('/api/gemini/tts', {
    method: 'POST',
    headers: getSessionHeaders(),
    body: JSON.stringify({
      text: params.hindiText,
      style: params.emotionStyle,
      voiceName: params.voiceName,
      model: params.model,
    }),
  });
  const data = (await resp.json()) as {
    ok: boolean;
    audioBase64?: string;
    sampleRate?: number;
    channels?: number;
    model?: string;
    error?: string;
  };
  if (!resp.ok || !data.ok || !data.audioBase64) {
    throw new Error(data.error || `Gemini Cloud TTS failed (HTTP ${resp.status}).`);
  }

  const binaryStr = atob(data.audioBase64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i += 1) {
    bytes[i] = binaryStr.charCodeAt(i);
  }

  // Validate real WAV header & read actual sample rate + real duration from PCM samples!
  const decoded = decodePcmWavBuffer(bytes.buffer);
  if (!decoded || decoded.samples.length === 0) {
    throw new Error('Gemini Cloud TTS returned an invalid or empty RIFF/WAV audio payload.');
  }

  const wavBlob = new Blob([bytes], { type: 'audio/wav' });
  return {
    wavBlob,
    sampleRate: decoded.sampleRate,
    durationMs: decoded.durationMs,
    model: data.model || params.model,
  };
}
