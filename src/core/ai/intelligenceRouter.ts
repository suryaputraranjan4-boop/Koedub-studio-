import type {
  AppSettings,
  CollaborationMode,
  CollaborativeTranslationMeta,
  GeminiConnectionStatus,
  PronunciationEntry,
  TranslationAlternative,
} from '../../types/domain';
import { localModelRuntime } from './modelRuntime';
import { refineHindiWithContextAndPronunciation } from './languageIntelligence';

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
  error?: string;
  result?: {
    hindiTranslation: string;
    conciseAlternative: string;
    naturalAlternative: string;
    culturalNote: string;
    humorOrIdiomAdapted: boolean;
    agreesWithLocalDraft: boolean;
    confidence: number;
    reasoning: string;
    qaWarnings: string[];
  };
}

export interface CollaborativeOutcome {
  hindiText: string;
  meta: CollaborativeTranslationMeta;
  qaWarnings: string[];
}

/**
 * Classifies dialogue complexity so trivial greetings don't waste cloud tokens
 * while idioms, humor, emotion, and long tight-timing lines use full collaboration.
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
 * Fetches live or cached server-side Gemini API connectivity & session token usage.
 * Never touches or exposes API keys in the browser.
 */
export async function fetchGeminiConnectionStatus(
  verifyLive: boolean = false
): Promise<GeminiConnectionStatus> {
  const url = verifyLive ? '/api/gemini/status?verify=1' : '/api/gemini/status';
  try {
    const resp = await fetch(url);
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
      availableModels: ['gemini-4-hydrogen'],
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
 */
async function runLocalOnnxLlmRefinement(
  japaneseText: string,
  localDraftHindi: string,
  politenessRegister: string
): Promise<{ text: string; confidence: number } | null> {
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
    return { text: outputText.split('\n')[0].trim(), confidence: 0.72 };
  } catch {
    return null;
  } finally {
    await localModelRuntime.unloadActiveModel();
  }
}

/**
 * Shared Hybrid Collaborative Intelligence Router supporting all 7 collaboration modes:
 * A. parallel              - Runs Gemini & Local LLM/Draft together, compares, flags disagreements.
 * B. complementary         - Uses Local for terminology/structure and Gemini for idiom/humor nuance.
 * C. draft_and_review      - Local produces initial draft; Gemini reviews & polishes natural Hindi.
 * D. alternatives          - Generates multiple Hindi candidates (primary, concise, expressive).
 * E. disagreement_resolution - Detects drift between Local and Gemini and escalates for user review.
 * F. sequential            - Local glossary & register pass -> Gemini timing/cultural refinement -> glossary lock.
 * G. offline_local         - Strict offline execution; marks cloud-only reviews honestly as pending.
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

  // Step 1: Deterministic pronunciation + register baseline on local draft
  const baselineRefined = refineHindiWithContextAndPronunciation(
    input.localDraftHindi,
    input.pronunciationRules,
    input.politenessRegister
  );
  let localCandidate = baselineRefined.hindiText;
  let localConfidence = localCandidate ? 0.74 : 0.0;
  let localSource: 'local_llm' | 'nllb_local' = 'nllb_local';

  // Run local ONNX LLM when installed (and in parallel/offline/draft modes)
  const localLlmRes = await runLocalOnnxLlmRefinement(
    input.japaneseText,
    localCandidate,
    input.politenessRegister
  );
  if (localLlmRes?.text) {
    localCandidate = refineHindiWithContextAndPronunciation(
      localLlmRes.text,
      input.pronunciationRules,
      input.politenessRegister
    ).hindiText;
    localConfidence = localLlmRes.confidence;
    localSource = 'local_llm';
  }

  // Mode G (Offline-only) OR trivial greeting when local draft is already solid
  if (
    effectiveMode === 'offline_local' ||
    (effectiveMode === 'complementary' &&
      complexity === 'simple' &&
      localCandidate.length > 0 &&
      input.taskType === 'translate_and_adapt')
  ) {
    const cloudPending = effectiveMode === 'offline_local';
    const alternatives: TranslationAlternative[] = localCandidate
      ? [
          {
            id: 'alt_local_primary',
            label: localSource === 'local_llm' ? 'Local Qwen2.5 ONNX' : 'Local NLLB / Draft',
            hindiText: localCandidate,
            source: localSource,
            note: cloudPending
              ? 'Produced offline; cloud idiom/humor review marked pending.'
              : 'Simple line handled locally to save API tokens.',
          },
        ]
      : [];

    return {
      hindiText: localCandidate,
      qaWarnings: [],
      meta: {
        mode: effectiveMode,
        geminiDraft: null,
        localDraft: localCandidate || null,
        selectedSource: localSource,
        alternatives,
        culturalNote: cloudPending
          ? 'Offline mode active — Gemini cloud review pending when connectivity is enabled.'
          : 'Simple utterance resolved locally without unnecessary cloud call.',
        humorOrIdiomAdapted: false,
        disagreementFlag: false,
        geminiConfidence: null,
        localConfidence: localCandidate ? localConfidence : null,
        reasoning: cloudPending
          ? 'Completed offline using local models and pronunciation rules.'
          : 'Complexity router resolved simple greeting locally.',
        cloudReviewPending: cloudPending,
        modelUsed: localSource === 'local_llm' ? 'Qwen2.5-0.5B-Instruct-ONNX' : 'Local Rules/NLLB',
        updatedAt: now,
      },
    };
  }

  // Step 2: Call Server-Side Gemini Proxy (/api/gemini/collaborate)
  try {
    const resp = await fetch('/api/gemini/collaborate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskType: input.taskType,
        mode: effectiveMode,
        model: input.settings.preferredGeminiModel || 'gemini-4-hydrogen',
        japaneseText: input.japaneseText,
        localDraftHindi: localCandidate,
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

    const r = data.result;
    // Always enforce persistent local pronunciation dictionary rules on Gemini output too!
    const primaryGemini = refineHindiWithContextAndPronunciation(
      r.hindiTranslation,
      input.pronunciationRules,
      input.politenessRegister
    ).hindiText;
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

    const disagreementFlag =
      Boolean(localCandidate) &&
      (!r.agreesWithLocalDraft ||
        (effectiveMode === 'disagreement_resolution' &&
          localCandidate.replace(/\s+/g, '') !== primaryGemini.replace(/\s+/g, '')));

    const chosenText =
      input.taskType === 'concise_timing_rewrite' && conciseGemini
        ? conciseGemini
        : primaryGemini || localCandidate;

    const alternatives: TranslationAlternative[] = [];
    if (primaryGemini) {
      alternatives.push({
        id: 'alt_gemini_primary',
        label: 'Gemini Recommended',
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
    if (localCandidate && localCandidate !== primaryGemini) {
      alternatives.push({
        id: 'alt_local_draft',
        label: localSource === 'local_llm' ? 'Local Qwen2.5 ONNX' : 'Local NLLB Draft',
        hindiText: localCandidate,
        source: localSource,
        note: 'On-device offline baseline for comparison',
      });
    }

    return {
      hindiText: chosenText,
      qaWarnings: Array.isArray(r.qaWarnings) ? r.qaWarnings : [],
      meta: {
        mode: effectiveMode,
        geminiDraft: primaryGemini || null,
        localDraft: localCandidate || null,
        selectedSource: localCandidate ? 'hybrid_merged' : 'gemini',
        alternatives,
        culturalNote: r.culturalNote || '',
        humorOrIdiomAdapted: Boolean(r.humorOrIdiomAdapted),
        disagreementFlag,
        geminiConfidence: typeof r.confidence === 'number' ? r.confidence : 0.85,
        localConfidence: localCandidate ? localConfidence : null,
        reasoning: r.reasoning || '',
        cloudReviewPending: false,
        modelUsed: data.model || input.settings.preferredGeminiModel || 'gemini-4-hydrogen',
        updatedAt: now,
      },
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Cloud collaboration unavailable.';
    // Honest fallback to offline local draft — mark cloudReviewPending = true, NEVER fake success
    return {
      hindiText: localCandidate,
      qaWarnings: [`Cloud review pending: ${errMsg}`],
      meta: {
        mode: 'offline_local',
        geminiDraft: null,
        localDraft: localCandidate || null,
        selectedSource: localSource,
        alternatives: localCandidate
          ? [
              {
                id: 'alt_local_fallback',
                label: 'Offline Local Fallback',
                hindiText: localCandidate,
                source: localSource,
                note: `Gemini unavailable (${errMsg}).`,
              },
            ]
          : [],
        culturalNote: `Cloud intelligence fallback (${errMsg}) — marked pending for later review.`,
        humorOrIdiomAdapted: false,
        disagreementFlag: false,
        geminiConfidence: null,
        localConfidence: localCandidate ? localConfidence : null,
        reasoning: errMsg,
        cloudReviewPending: true,
        modelUsed: localSource === 'local_llm' ? 'Qwen2.5-0.5B-Instruct-ONNX' : 'Local Fallback',
        updatedAt: now,
      },
    };
  }
}

/**
 * Optional Gemini Cloud Hindi TTS caller via server proxy (/api/gemini/tts).
 * Returns a genuine 24kHz mono 16-bit WAV Blob directly from Gemini 3.8 TTS.
 */
export async function synthesizeHindiWavViaGeminiCloud(params: {
  hindiText: string;
  emotionStyle: string;
  voiceName: 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr';
  model: string;
}): Promise<{ wavBlob: Blob; sampleRate: number; durationMs: number; model: string }> {
  const resp = await fetch('/api/gemini/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  const wavBlob = new Blob([bytes], { type: 'audio/wav' });
  const sampleRate = data.sampleRate ?? 24000;
  // 44-byte RIFF header + 2 bytes per 16-bit mono sample
  const sampleCount = Math.max(0, Math.floor((bytes.byteLength - 44) / 2));
  const durationMs = Math.round((sampleCount / sampleRate) * 1000);

  return {
    wavBlob,
    sampleRate,
    durationMs,
    model: data.model || params.model,
  };
}
