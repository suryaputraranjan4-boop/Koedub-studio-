import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

// Verified active Gemini models per official Gemini API guidance (text & TTS strictly separated).
// Deprecated (1.5 / 2.0 / gemini-pro) and paid-only models are never allowed here.
const PRIMARY_TEXT_MODEL = 'gemini-4-hydrogen';
const VERIFIED_TEXT_MODELS = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'] as const;
const PRIMARY_TTS_MODEL = 'gemini-3.8-flash-lite-tts';
const VERIFIED_TTS_MODELS = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'] as const;
const PREBUILT_VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'] as const;

const FORBIDDEN_MODEL_PREFIXES = [
  'gemini-1.5',
  'gemini-2.0',
  'gemini-pro',
  'gemini-4-neon',
  'gemini-4-carbon',
  'gemini-4-argon',
];

interface ClientUsageTracker {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  ttsRequests: number;
  lastModelUsed: string | null;
  lastVerifiedAt: string | null;
  lastVerifiedOk: boolean;
  lastError: string | null;
  lastSeenAtMs: number;
}

// Per-client usage map. Client identity is derived from Express's resolved IP,
// never from a caller-controlled session header.
const clientUsageMap = new Map<string, ClientUsageTracker>();

// In-process sliding-window limits. Expired entries are pruned during traffic.
interface ClientRateBucket {
  textTimestamps: number[];
  ttsTimestamps: number[];
  lastSeenAtMs: number;
}
const clientRateBuckets = new Map<string, ClientRateBucket>();
const TEXT_RATE_LIMIT_PER_MIN = 30;
const TTS_RATE_LIMIT_PER_MIN = 20;

// In-flight deduplication map for identical concurrent requests
const inFlightRequests = new Map<string, Promise<unknown>>();

// Cached model discovery from ai.models.list()
let discoveredModelsCache: {
  fetchedAtMs: number;
  textModels: string[];
  ttsModels: string[];
  discoverySource: 'live_models_list' | 'verified_static_fallback';
} | null = null;
const MODEL_DISCOVERY_TTL_MS = 10 * 60 * 1000;

function getClientKey(req: Request): string {
  // Express only trusts forwarded IP headers when trust proxy is explicitly configured.
  // Do not trust x-koedub-session or parse x-forwarded-for directly: both are client-controlled.
  return `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
}

function getOrCreateUsage(clientKey: string): ClientUsageTracker {
  const existing = clientUsageMap.get(clientKey);
  if (existing) {
    existing.lastSeenAtMs = Date.now();
    return existing;
  }
  // Evict stale entries if map grows large
  if (clientUsageMap.size > 500) {
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    for (const [k, v] of clientUsageMap.entries()) {
      if (v.lastSeenAtMs < cutoff) clientUsageMap.delete(k);
    }
  }
  const fresh: ClientUsageTracker = {
    totalRequests: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    ttsRequests: 0,
    lastModelUsed: null,
    lastVerifiedAt: null,
    lastVerifiedOk: false,
    lastError: null,
    lastSeenAtMs: Date.now(),
  };
  clientUsageMap.set(clientKey, fresh);
  return fresh;
}

function checkRateLimit(
  clientKey: string,
  bucket: 'text' | 'tts'
): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const windowMs = 60_000;

  // Opportunistically remove inactive identities so changing connection IPs cannot
  // leave unbounded, permanently retained rate-limit entries.
  if (clientRateBuckets.size > 500) {
    const staleBefore = now - 2 * windowMs;
    for (const [key, value] of clientRateBuckets.entries()) {
      if (value.lastSeenAtMs < staleBefore) clientRateBuckets.delete(key);
    }
  }

  const entry = clientRateBuckets.get(clientKey) ?? {
    textTimestamps: [],
    ttsTimestamps: [],
    lastSeenAtMs: now,
  };
  entry.lastSeenAtMs = now;
  const list = bucket === 'text' ? entry.textTimestamps : entry.ttsTimestamps;
  const limit = bucket === 'text' ? TEXT_RATE_LIMIT_PER_MIN : TTS_RATE_LIMIT_PER_MIN;

  const recent = list.filter((ts) => now - ts < windowMs);
  if (bucket === 'text') entry.textTimestamps = recent;
  else entry.ttsTimestamps = recent;
  clientRateBuckets.set(clientKey, entry);

  if (recent.length >= limit) {
    const oldest = recent[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
    return { allowed: false, retryAfterSec };
  }

  recent.push(now);
  return { allowed: true, retryAfterSec: 0 };
}

function getConfiguredApiKey(): string | null {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || key === 'MY_GEMINI_API_KEY') return null;
  return key;
}

function createGeminiClient(): GoogleGenAI | null {
  const apiKey = getConfiguredApiKey();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function isModelForbidden(modelId: string): boolean {
  const lower = modelId.toLowerCase().trim();
  return FORBIDDEN_MODEL_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

async function discoverAvailableModels(ai: GoogleGenAI): Promise<{
  textModels: string[];
  ttsModels: string[];
  discoverySource: 'live_models_list' | 'verified_static_fallback';
}> {
  if (
    discoveredModelsCache &&
    Date.now() - discoveredModelsCache.fetchedAtMs < MODEL_DISCOVERY_TTL_MS
  ) {
    return {
      textModels: discoveredModelsCache.textModels,
      ttsModels: discoveredModelsCache.ttsModels,
      discoverySource: discoveredModelsCache.discoverySource,
    };
  }

  try {
    const pager = await ai.models.list();
    const discoveredNames = new Set<string>();
    let count = 0;
    for await (const model of pager) {
      const rawName = String(model.name || '').replace(/^models\//, '').trim();
      if (rawName && !isModelForbidden(rawName)) {
        discoveredNames.add(rawName);
      }
      count += 1;
      if (count >= 120) break;
    }

    const liveText = VERIFIED_TEXT_MODELS.filter((m) => discoveredNames.has(m));
    const liveTts = VERIFIED_TTS_MODELS.filter((m) => discoveredNames.has(m));

    const result = {
      textModels: liveText.length > 0 ? [...liveText] : [...VERIFIED_TEXT_MODELS],
      ttsModels: liveTts.length > 0 ? [...liveTts] : [...VERIFIED_TTS_MODELS],
      discoverySource: (liveText.length > 0 || liveTts.length > 0
        ? 'live_models_list'
        : 'verified_static_fallback') as 'live_models_list' | 'verified_static_fallback',
    };
    discoveredModelsCache = { fetchedAtMs: Date.now(), ...result };
    return result;
  } catch {
    return {
      textModels: [...VERIFIED_TEXT_MODELS],
      ttsModels: [...VERIFIED_TTS_MODELS],
      discoverySource: 'verified_static_fallback',
    };
  }
}

function resolveSafeTextModel(requested?: string, available?: string[]): string {
  const pool = available && available.length > 0 ? available : [...VERIFIED_TEXT_MODELS];
  if (requested && !isModelForbidden(requested) && pool.includes(requested)) {
    return requested;
  }
  return pool[0] || PRIMARY_TEXT_MODEL;
}

function resolveSafeTtsModel(requested?: string, available?: string[]): string {
  const pool = available && available.length > 0 ? available : [...VERIFIED_TTS_MODELS];
  if (requested && !isModelForbidden(requested) && pool.includes(requested)) {
    return requested;
  }
  return pool[0] || PRIMARY_TTS_MODEL;
}

function isTransientApiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(429|500|502|503|504|ETIMEDOUT|ECONNRESET|timeout|overloaded|rate limit|temporarily unavailable)\b/i.test(
    msg
  );
}

async function withTimeoutAndRetry<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  maxRetries: number = 2
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Gemini request timed out after ${timeoutMs} ms.`)), timeoutMs)
        ),
      ]);
    } catch (err) {
      if (attempt >= maxRetries || !isTransientApiError(err)) {
        throw err;
      }
      const backoffMs = 600 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, backoffMs));
      attempt += 1;
    }
  }
}

/**
 * Parses a RIFF/WAV header if present, returning actual sampleRate, channels, and PCM payload.
 */
function parseWavBufferIfValid(buf: Buffer): {
  isWav: boolean;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  pcmData: Buffer;
} | null {
  if (buf.length < 44) return null;
  if (buf.subarray(0, 4).toString('ascii') !== 'RIFF') return null;
  if (buf.subarray(8, 12).toString('ascii') !== 'WAVE') return null;

  let offset = 12;
  let sampleRate = 24000;
  let channels = 1;
  let bitsPerSample = 16;
  let dataStart = -1;
  let dataLen = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.subarray(offset, offset + 4).toString('ascii');
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ' && offset + 24 <= buf.length) {
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      dataStart = offset + 8;
      dataLen = Math.min(size, buf.length - dataStart);
      break;
    }
    offset += 8 + size + (size % 2);
  }

  if (dataStart < 0 || sampleRate <= 0 || channels <= 0) return null;
  return {
    isWav: true,
    sampleRate,
    channels,
    bitsPerSample,
    pcmData: buf.subarray(dataStart, dataStart + dataLen),
  };
}

function parseSampleRateFromMimeType(mimeType: string | undefined, fallback: number = 24000): number {
  if (!mimeType) return fallback;
  const match = mimeType.match(/rate=(\d{4,6})/i);
  if (match) {
    const parsed = Number(match[1]);
    if (Number.isFinite(parsed) && parsed >= 8000 && parsed <= 96000) {
      return parsed;
    }
  }
  return fallback;
}

function wrapPcm16ToWav(pcmBuffer: Buffer, sampleRate: number, numChannels: number = 1): Buffer {
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuffer]);
}

function splitLongHindiTextForTts(text: string, maxChars: number = 360): string[] {
  const clean = text.trim();
  if (clean.length <= maxChars) return [clean];
  const sentences = clean
    .split(/(?<=[।.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = '';
  for (const sent of sentences) {
    if ((current + ' ' + sent).trim().length <= maxChars) {
      current = (current + ' ' + sent).trim();
    } else {
      if (current) chunks.push(current);
      if (sent.length <= maxChars) {
        current = sent;
      } else {
        for (let i = 0; i < sent.length; i += maxChars) {
          chunks.push(sent.slice(i, i + maxChars));
        }
        current = '';
      }
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [clean.slice(0, maxChars)];
}

function buildModeSpecificDirective(mode: string, taskType: string): string {
  if (taskType === 'semantic_qa_review') {
    return [
      'TASK: Independent Semantic, Cultural & Pronunciation Quality Audit (NOT drafting).',
      'Inspect the existing Hindi dubbing line against the Japanese source, character personality, politeness register, and pronunciation rules.',
      'Populate qaWarnings with concrete issues (mistranslation, broken register, awkward literalism, ignored pronunciation rule, idiom loss, timing overload).',
      'Only suggest a corrected hindiTranslation when an actual defect exists; otherwise preserve the Hindi line and report zero warnings.',
    ].join('\n');
  }
  if (taskType === 'concise_timing_rewrite') {
    return [
      'TASK: Concise Dubbing Timing Adaptation.',
      'Rewrite the Hindi line so it fits naturally within the target duration milliseconds without rushing speech or dropping core emotional meaning.',
      'Put the shortest natural spoken Hindi version in conciseAlternative AND hindiTranslation.',
    ].join('\n');
  }
  switch (mode) {
    case 'parallel':
      return 'MODE (Parallel Comparison): Produce an independent studio-grade Hindi translation from the Japanese source WITHOUT copying the local draft blindly, then compare semantically and set agreesWithLocalDraft=false if meaning, register, or tone materially differs.';
    case 'complementary':
      return 'MODE (Complementary): Preserve all locked local pronunciation dictionary terms and sentence facts from the local draft, while elevating idioms, anime humor, sarcasm, and cultural subtext into natural spoken Hindi.';
    case 'draft_and_review':
      return 'MODE (Draft & Review): Review the local Hindi draft line-by-line, fix unnatural machine-translation phrasing or wrong Aap/Tum/Tu register, and explain what was improved in reasoning.';
    case 'alternatives':
      return 'MODE (Multi-Alternative Generation): Provide THREE genuinely distinct spoken Hindi options: (1) hindiTranslation = balanced faithful dub, (2) conciseAlternative = tighter lip-sync/duration fit, (3) naturalAlternative = expressive/idiomatic anime phrasing.';
    case 'disagreement_resolution':
      return 'MODE (Disagreement Resolution): Critically audit discrepancies between the Japanese source and local Hindi draft. Clearly set agreesWithLocalDraft=false if any nuance/register/pronunciation conflict exists and document evidence in reasoning + qaWarnings.';
    case 'sequential':
      return 'MODE (Sequential Refinement): Treat the local draft as Stage-1 glossary/register output and perform Stage-2 cultural, emotional, and spoken-duration polish while strictly preserving all glossary terms.';
    default:
      return 'MODE (Studio Dubbing Adaptation): Adapt the Japanese anime line into natural spoken Devanagari Hindi matching character register and target duration.';
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // 1. Live Connectivity, Model Discovery & Per-Session Usage Status
  app.get('/api/gemini/status', async (req: Request, res: Response) => {
    const clientKey = getClientKey(req);
    const usage = getOrCreateUsage(clientKey);
    const ai = createGeminiClient();

    if (!ai) {
      res.json({
        configured: false,
        verified: false,
        primaryModel: PRIMARY_TEXT_MODEL,
        ttsModel: PRIMARY_TTS_MODEL,
        availableModels: [...VERIFIED_TEXT_MODELS],
        availableTtsModels: [...VERIFIED_TTS_MODELS],
        discoverySource: 'verified_static_fallback',
        usage: {
          totalRequests: usage.totalRequests,
          totalInputTokens: usage.totalInputTokens,
          totalOutputTokens: usage.totalOutputTokens,
          ttsRequests: usage.ttsRequests,
          lastModelUsed: usage.lastModelUsed,
          lastVerifiedAt: usage.lastVerifiedAt,
          lastVerifiedOk: usage.lastVerifiedOk,
          lastError: usage.lastError,
        },
        message:
          'GEMINI_API_KEY is not configured in the server environment. KoeDub Studio runs offline with local models until configured in Secrets.',
      });
      return;
    }

    const discovered = await discoverAvailableModels(ai);
    const verifyLive = req.query.verify === '1';

    if (verifyLive) {
      const testModel = resolveSafeTextModel(undefined, discovered.textModels);
      try {
        const response = await withTimeoutAndRetry(
          () =>
            ai.models.generateContent({
              model: testModel,
              contents: 'Reply with OK.',
              config: { maxOutputTokens: 8, temperature: 0 },
            }),
          15_000,
          1
        );
        usage.totalRequests += 1;
        usage.totalInputTokens += response.usageMetadata?.promptTokenCount ?? 0;
        usage.totalOutputTokens += response.usageMetadata?.candidatesTokenCount ?? 0;
        usage.lastModelUsed = testModel;
        usage.lastVerifiedAt = new Date().toISOString();
        usage.lastVerifiedOk = true;
        usage.lastError = null;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Live Gemini verification failed.';
        usage.lastVerifiedAt = new Date().toISOString();
        usage.lastVerifiedOk = false;
        usage.lastError = msg;
      }
    }

    res.json({
      configured: true,
      verified: usage.lastVerifiedOk,
      primaryModel: discovered.textModels[0] || PRIMARY_TEXT_MODEL,
      ttsModel: discovered.ttsModels[0] || PRIMARY_TTS_MODEL,
      availableModels: discovered.textModels,
      availableTtsModels: discovered.ttsModels,
      discoverySource: discovered.discoverySource,
      usage: {
        totalRequests: usage.totalRequests,
        totalInputTokens: usage.totalInputTokens,
        totalOutputTokens: usage.totalOutputTokens,
        ttsRequests: usage.ttsRequests,
        lastModelUsed: usage.lastModelUsed,
        lastVerifiedAt: usage.lastVerifiedAt,
        lastVerifiedOk: usage.lastVerifiedOk,
        lastError: usage.lastError,
      },
      message: usage.lastVerifiedOk
        ? `Live Gemini API verified (${discovered.discoverySource === 'live_models_list' ? 'discovered via models.list' : 'verified registry'}) using ${usage.lastModelUsed || discovered.textModels[0]}.`
        : usage.lastError
        ? `API key detected, but live check reported: ${usage.lastError}`
        : `Server-side Gemini API key detected (${discovered.textModels.join(', ')}). Click Verify Connection to test live.`,
    });
  });

  // 2. Collaborative Translation, Cultural Nuance, Concise Rewrite & Independent Semantic QA
  app.post('/api/gemini/collaborate', async (req: Request, res: Response) => {
    const clientKey = getClientKey(req);
    const usage = getOrCreateUsage(clientKey);
    const ai = createGeminiClient();
    if (!ai) {
      res.status(503).json({
        ok: false,
        error: 'GEMINI_API_KEY is not configured on the server. Operating in offline local mode.',
      });
      return;
    }

    const rate = checkRateLimit(clientKey, 'text');
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSec));
      res.status(429).json({
        ok: false,
        error: `Rate limit reached (${TEXT_RATE_LIMIT_PER_MIN} requests/min). Retry in ${rate.retryAfterSec}s.`,
      });
      return;
    }

    const {
      taskType = 'translate_and_adapt',
      mode = 'draft_and_review',
      model,
      japaneseText = '',
      localDraftHindi = '',
      characterContext = '',
      politenessRegister = '',
      targetDurationMs = 2500,
      previousTurns = [],
      nextTurns = [],
      pronunciationRules = [],
    } = req.body ?? {};

    const cleanJapanese = String(japaneseText).trim();
    const cleanLocalDraft = String(localDraftHindi).trim();
    if (!cleanJapanese && !cleanLocalDraft) {
      res.status(400).json({ ok: false, error: 'Either japaneseText or localDraftHindi is required.' });
      return;
    }
    if (cleanJapanese.length > 4000 || cleanLocalDraft.length > 4000) {
      res.status(413).json({ ok: false, error: 'Dialogue payload exceeds 4000-character safety limit.' });
      return;
    }

    const discovered = await discoverAvailableModels(ai);
    const selectedModel = resolveSafeTextModel(
      typeof model === 'string' ? model : undefined,
      discovered.textModels
    );

    const dedupKey = `collab:${clientKey}:${selectedModel}:${taskType}:${mode}:${cleanJapanese.slice(0, 120)}:${cleanLocalDraft.slice(0, 120)}`;
    if (inFlightRequests.has(dedupKey)) {
      try {
        const shared = await inFlightRequests.get(dedupKey);
        res.json(shared);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Shared Gemini call failed.';
        res.status(502).json({ ok: false, error: msg });
      }
      return;
    }

    const safePrev = Array.isArray(previousTurns)
      ? previousTurns.slice(0, 5).map((s) => String(s).slice(0, 240))
      : [];
    const safeNext = Array.isArray(nextTurns)
      ? nextTurns.slice(0, 5).map((s) => String(s).slice(0, 240))
      : [];
    const safePron = Array.isArray(pronunciationRules)
      ? pronunciationRules.slice(0, 40)
      : [];

    const pronSummary =
      safePron.length > 0
        ? safePron
            .map(
              (r: { sourceTerm?: string; targetHindiForm?: string }) =>
                `${String(r.sourceTerm ?? '')} -> ${String(r.targetHindiForm ?? '')}`
            )
            .join('; ')
        : 'None';

    const modeDirective = buildModeSpecificDirective(String(mode), String(taskType));

    const prompt = [
      'You are a senior Japanese-to-Hindi anime dubbing director and localization linguist.',
      modeDirective,
      'Preserve honorific nuance, Hindi politeness register (Aap/Tum/Tu), idioms, anime humor, and character personality.',
      'Return natural spoken Devanagari Hindi (NEVER stiff literal word-for-word machine translation).',
      'Strictly honor all Pronunciation Dictionary overrides.',
      `Target spoken duration window: ${Math.max(200, Math.min(60000, Number(targetDurationMs) || 2500))} ms.`,
      `Character Context: ${String(characterContext || 'Unspecified speaker').slice(0, 400)}`,
      `Politeness Register: ${String(politenessRegister || 'Match source tone naturally').slice(0, 200)}`,
      `Pronunciation Dictionary: ${pronSummary}`,
      safePrev.length > 0 ? `Previous Turns:\n${safePrev.join('\n')}` : '',
      safeNext.length > 0 ? `Next Turns:\n${safeNext.join('\n')}` : '',
      `Original Japanese: ${cleanJapanese || '(not provided)'}`,
      `Local Draft Hindi: ${cleanLocalDraft || '(none — create natural Hindi dubbing line)'}`,
    ]
      .filter(Boolean)
      .join('\n');

    const promise = (async () => {
      const response = await withTimeoutAndRetry(
        () =>
          ai.models.generateContent({
            model: selectedModel,
            contents: prompt,
            config: {
              temperature: taskType === 'semantic_qa_review' ? 0.15 : mode === 'alternatives' ? 0.55 : 0.3,
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  hindiTranslation: { type: Type.STRING },
                  conciseAlternative: { type: Type.STRING },
                  naturalAlternative: { type: Type.STRING },
                  culturalNote: { type: Type.STRING },
                  humorOrIdiomAdapted: { type: Type.BOOLEAN },
                  agreesWithLocalDraft: { type: Type.BOOLEAN },
                  reasoning: { type: Type.STRING },
                  qaWarnings: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                },
                required: [
                  'hindiTranslation',
                  'conciseAlternative',
                  'naturalAlternative',
                  'culturalNote',
                  'humorOrIdiomAdapted',
                  'agreesWithLocalDraft',
                  'reasoning',
                  'qaWarnings',
                ],
              },
            },
          }),
        28_000,
        2
      );

      usage.totalRequests += 1;
      usage.totalInputTokens += response.usageMetadata?.promptTokenCount ?? 0;
      usage.totalOutputTokens += response.usageMetadata?.candidatesTokenCount ?? 0;
      usage.lastModelUsed = selectedModel;
      usage.lastVerifiedOk = true;
      usage.lastVerifiedAt = new Date().toISOString();
      usage.lastError = null;

      const parsed = JSON.parse(response.text || '{}');
      return {
        ok: true,
        model: selectedModel,
        mode,
        taskType,
        result: {
          ...parsed,
          // Honest confidence: LLMs do not expose calibrated token probabilities here, so return null.
          confidence: null,
          confidenceSource: 'uncalibrated_llm_generation',
        },
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    })();

    inFlightRequests.set(dedupKey, promise);
    try {
      const payload = await promise;
      res.json(payload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gemini collaborative request failed.';
      usage.lastError = msg;
      res.status(502).json({ ok: false, error: msg });
    } finally {
      inFlightRequests.delete(dedupKey);
    }
  });

  // 3. Optional Server-Side Gemini Hindi TTS (Multi-part inspection, Real WAV header validation, Long-text chunking)
  app.post('/api/gemini/tts', async (req: Request, res: Response) => {
    const clientKey = getClientKey(req);
    const usage = getOrCreateUsage(clientKey);
    const ai = createGeminiClient();
    if (!ai) {
      res.status(503).json({
        ok: false,
        error: 'GEMINI_API_KEY is not configured on the server. Use local offline MMS-TTS instead.',
      });
      return;
    }

    const rate = checkRateLimit(clientKey, 'tts');
    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfterSec));
      res.status(429).json({
        ok: false,
        error: `TTS rate limit reached (${TTS_RATE_LIMIT_PER_MIN} requests/min). Retry in ${rate.retryAfterSec}s.`,
      });
      return;
    }

    const { text = '', style = 'natural anime Hindi dubbing', voiceName = 'Kore', model } =
      req.body ?? {};
    const cleanText = String(text).trim();
    if (!cleanText) {
      res.status(400).json({ ok: false, error: 'Hindi text is required for TTS synthesis.' });
      return;
    }
    if (cleanText.length > 1500) {
      res.status(413).json({ ok: false, error: 'TTS text exceeds 1500-character safety limit.' });
      return;
    }

    const discovered = await discoverAvailableModels(ai);
    const selectedModel = resolveSafeTtsModel(
      typeof model === 'string' ? model : undefined,
      discovered.ttsModels
    );
    const safeVoice = (PREBUILT_VOICES as readonly string[]).includes(String(voiceName))
      ? String(voiceName)
      : 'Kore';

    const chunks = splitLongHindiTextForTts(cleanText, 360);

    try {
      const pcmBuffers: Buffer[] = [];
      let detectedSampleRate = 24000;
      let detectedChannels = 1;

      for (const chunkText of chunks) {
        const response = await withTimeoutAndRetry(
          () =>
            ai.models.generateContent({
              model: selectedModel,
              contents: `Speak this Hindi anime dubbing line with ${String(style).slice(0, 120)} delivery. Speak ONLY the Hindi line:\n${chunkText}`,
              config: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                  voiceConfig: {
                    prebuiltVoiceConfig: { voiceName: safeVoice },
                  },
                },
              },
            }),
          35_000,
          2
        );

        // Scan ALL parts in candidates[0].content.parts for inlineData audio (never assume parts[0])
        const parts = response.candidates?.[0]?.content?.parts ?? [];
        const audioPart = parts.find(
          (p) => Boolean(p?.inlineData?.data) && (!p.inlineData?.mimeType || p.inlineData.mimeType.startsWith('audio/'))
        );

        const audioBase64 = audioPart?.inlineData?.data;
        const mimeType = audioPart?.inlineData?.mimeType;
        if (!audioBase64) {
          throw new Error('Gemini TTS returned no inlineData audio part across candidate parts.');
        }

        const rawBuf = Buffer.from(audioBase64, 'base64');
        const parsedWav = parseWavBufferIfValid(rawBuf);
        if (parsedWav) {
          detectedSampleRate = parsedWav.sampleRate;
          detectedChannels = parsedWav.channels;
          pcmBuffers.push(parsedWav.pcmData);
        } else {
          // Raw linear 16-bit PCM (e.g. audio/L16;codec=pcm;rate=24000)
          detectedSampleRate = parseSampleRateFromMimeType(mimeType, detectedSampleRate);
          detectedChannels = 1;
          pcmBuffers.push(rawBuf);
        }

        usage.totalRequests += 1;
        usage.ttsRequests += 1;
        usage.totalInputTokens += response.usageMetadata?.promptTokenCount ?? 0;
        usage.totalOutputTokens += response.usageMetadata?.candidatesTokenCount ?? 0;
        usage.lastModelUsed = selectedModel;
        usage.lastVerifiedOk = true;
        usage.lastVerifiedAt = new Date().toISOString();
        usage.lastError = null;
      }

      const combinedPcm = Buffer.concat(pcmBuffers);
      const finalWav = wrapPcm16ToWav(combinedPcm, detectedSampleRate, detectedChannels);

      res.json({
        ok: true,
        model: selectedModel,
        voiceName: safeVoice,
        mimeType: 'audio/wav',
        sampleRate: detectedSampleRate,
        channels: detectedChannels,
        chunkCount: chunks.length,
        audioBase64: finalWav.toString('base64'),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gemini Cloud TTS synthesis failed.';
      usage.lastError = msg;
      res.status(502).json({ ok: false, error: msg });
    }
  });

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`KoeDub Studio server listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start KoeDub Studio server:', err);
  process.exit(1);
});
