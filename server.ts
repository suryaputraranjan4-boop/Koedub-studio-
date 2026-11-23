import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

const ALLOWED_TEXT_MODELS = new Set(['gemini-4-hydrogen']);
const ALLOWED_TTS_MODELS = new Set([
  'gemini-3.8-flash-lite-tts',
  'gemini-3.8-flash-tts',
]);
const ALLOWED_TTS_VOICES = new Set(['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr']);

const DEFAULT_TEXT_MODEL = 'gemini-4-hydrogen';
const DEFAULT_TTS_MODEL = 'gemini-3.8-flash-lite-tts';

const sessionUsage = {
  totalRequests: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  ttsRequests: 0,
  lastModelUsed: null as string | null,
  lastVerifiedAt: null as string | null,
  lastVerifiedOk: false,
  lastError: null as string | null,
};

function getApiKey(): string | null {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key || key === 'MY_GEMINI_API_KEY') return null;
  return key;
}

function createGenAIClient(): GoogleGenAI | null {
  const apiKey = getApiKey();
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

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const retryable =
        msg.includes('429') ||
        msg.includes('503') ||
        msg.includes('500') ||
        msg.includes('RESOURCE_EXHAUSTED') ||
        msg.includes('UNAVAILABLE');
      if (!retryable || attempt === maxRetries) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 450 * Math.pow(2, attempt)));
    }
  }
  throw lastErr;
}

function recordUsage(
  model: string,
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
) {
  sessionUsage.totalRequests += 1;
  sessionUsage.lastModelUsed = model;
  if (usageMetadata) {
    sessionUsage.totalInputTokens += usageMetadata.promptTokenCount ?? 0;
    sessionUsage.totalOutputTokens += usageMetadata.candidatesTokenCount ?? 0;
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '6mb' }));

  // 1. Server-side Gemini connectivity & session usage status (never exposes key!)
  app.get('/api/gemini/status', async (req, res) => {
    const configured = Boolean(getApiKey());
    const shouldVerify = req.query.verify === '1' || req.query.verify === 'true';

    if (!configured) {
      sessionUsage.lastVerifiedOk = false;
      sessionUsage.lastError =
        'GEMINI_API_KEY is not configured in server environment (Settings > Secrets).';
      res.json({
        configured: false,
        verified: false,
        primaryModel: DEFAULT_TEXT_MODEL,
        ttsModel: DEFAULT_TTS_MODEL,
        availableModels: Array.from(ALLOWED_TEXT_MODELS),
        availableTtsModels: Array.from(ALLOWED_TTS_MODELS),
        usage: { ...sessionUsage },
        message:
          'Cloud Intelligence inactive — configure GEMINI_API_KEY in Settings > Secrets to enable Gemini collaboration.',
      });
      return;
    }

    if (shouldVerify) {
      try {
        const ai = createGenAIClient();
        if (!ai) {
          throw new Error('Server API client unavailable.');
        }
        const ping = await withRetry(() =>
          ai.models.generateContent({
            model: DEFAULT_TEXT_MODEL,
            contents: 'Reply with OK.',
            config: {
              maxOutputTokens: 8,
            },
          })
        );
        recordUsage(DEFAULT_TEXT_MODEL, ping.usageMetadata);
        sessionUsage.lastVerifiedAt = new Date().toISOString();
        sessionUsage.lastVerifiedOk = true;
        sessionUsage.lastError = null;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Live Gemini connectivity verification failed.';
        sessionUsage.lastVerifiedOk = false;
        sessionUsage.lastError = message;
        res.status(200).json({
          configured: true,
          verified: false,
          primaryModel: DEFAULT_TEXT_MODEL,
          ttsModel: DEFAULT_TTS_MODEL,
          availableModels: Array.from(ALLOWED_TEXT_MODELS),
          availableTtsModels: Array.from(ALLOWED_TTS_MODELS),
          usage: { ...sessionUsage },
          message,
        });
        return;
      }
    }

    res.json({
      configured: true,
      verified: sessionUsage.lastVerifiedOk,
      primaryModel: DEFAULT_TEXT_MODEL,
      ttsModel: DEFAULT_TTS_MODEL,
      availableModels: Array.from(ALLOWED_TEXT_MODELS),
      availableTtsModels: Array.from(ALLOWED_TTS_MODELS),
      usage: { ...sessionUsage },
      message: sessionUsage.lastVerifiedOk
        ? `Connected and verified via server proxy (${DEFAULT_TEXT_MODEL}).`
        : 'Server GEMINI_API_KEY detected. Click Test Connection to verify live access.',
    });
  });

  // 2. Hybrid Collaborative Intelligence endpoint (translation, cultural/idiom adaptation, concise timing rewrite, semantic QA)
  app.post('/api/gemini/collaborate', async (req, res) => {
    const ai = createGenAIClient();
    if (!ai) {
      res.status(503).json({
        ok: false,
        error:
          'Server GEMINI_API_KEY is not configured. Configure it in Settings > Secrets or continue in Offline Mode.',
      });
      return;
    }

    try {
      const body = req.body ?? {};
      const taskType = String(body.taskType ?? 'translate_and_adapt');
      const requestedModel = String(body.model ?? DEFAULT_TEXT_MODEL);
      const model = ALLOWED_TEXT_MODELS.has(requestedModel)
        ? requestedModel
        : DEFAULT_TEXT_MODEL;

      const japaneseText = String(body.japaneseText ?? '').trim();
      const localDraftHindi = String(body.localDraftHindi ?? '').trim();
      const targetDurationMs = Number(body.targetDurationMs ?? 0);
      const politenessRegister = String(body.politenessRegister ?? '').trim();
      const characterContext = String(body.characterContext ?? '').trim();
      const previousTurns = Array.isArray(body.previousTurns)
        ? body.previousTurns.slice(-3).map(String)
        : [];
      const nextTurns = Array.isArray(body.nextTurns)
        ? body.nextTurns.slice(0, 2).map(String)
        : [];
      const pronunciationRules = Array.isArray(body.pronunciationRules)
        ? body.pronunciationRules.slice(0, 20)
        : [];
      const mode = String(body.mode ?? 'draft_and_review');

      if (!japaneseText && !localDraftHindi) {
        res.status(400).json({
          ok: false,
          error: 'Either japaneseText or localDraftHindi is required.',
        });
        return;
      }

      const glossaryLines = pronunciationRules
        .map((r: { sourceTerm?: string; targetHindiForm?: string }) =>
          r?.sourceTerm && r?.targetHindiForm
            ? `- ${r.sourceTerm} -> ${r.targetHindiForm}`
            : null
        )
        .filter(Boolean)
        .join('\n');

      const durationSec = targetDurationMs > 0 ? (targetDurationMs / 1000).toFixed(2) : 'unspecified';

      const prompt = [
        `You are a senior Japanese-to-Hindi anime dubbing dialogue director collaborating with a local on-device translator.`,
        `Task type: ${taskType} (collaboration mode: ${mode}).`,
        `Rules:`,
        `1. Produce natural, spoken Devanagari Hindi suitable for anime voice acting—never robotic literal word-for-word translation.`,
        `2. Adapt Japanese idioms, jokes, sarcasm, and honorifics into natural Hindi equivalents that preserve emotional impact and character voice.`,
        `3. Respect the target spoken duration window (${durationSec}s). Provide a concise alternative specifically paced to fit tightly if the natural line is long.`,
        `4. Respect the politeness register (${politenessRegister || 'match speaker relationship naturally: Aap/Tum/Tu'}).`,
        `5. Strictly follow any provided glossary/pronunciation spellings.`,
        characterContext ? `Character profile & style: ${characterContext}` : '',
        previousTurns.length > 0 ? `Previous dialogue turns:\n${previousTurns.join('\n')}` : '',
        nextTurns.length > 0 ? `Following dialogue turns:\n${nextTurns.join('\n')}` : '',
        glossaryLines ? `Required Hindi pronunciation glossary:\n${glossaryLines}` : '',
        `Source Japanese line: ${japaneseText || '(not provided)'}`,
        localDraftHindi ? `Local on-device Hindi draft for review/comparison: ${localDraftHindi}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');

      const response = await withRetry(() =>
        ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                hindiTranslation: {
                  type: Type.STRING,
                  description: 'Primary natural spoken Devanagari Hindi dubbing line.',
                },
                conciseAlternative: {
                  type: Type.STRING,
                  description: 'Shorter spoken Devanagari Hindi alternative for tighter lip/timing sync.',
                },
                naturalAlternative: {
                  type: Type.STRING,
                  description: 'Expressive or idiomatic alternative Devanagari Hindi phrasing.',
                },
                culturalNote: {
                  type: Type.STRING,
                  description: 'Brief note on idiom, humor, honorific, or register adaptation.',
                },
                humorOrIdiomAdapted: {
                  type: Type.BOOLEAN,
                  description: 'True if cultural nuance, idiom, sarcasm, or humor was actively adapted.',
                },
                agreesWithLocalDraft: {
                  type: Type.BOOLEAN,
                  description: 'True if the local Hindi draft captures the same meaning and tone accurately.',
                },
                confidence: {
                  type: Type.NUMBER,
                  description: 'Confidence score between 0 and 1.',
                },
                reasoning: {
                  type: Type.STRING,
                  description: 'Concise 1-2 sentence explanation of phrasing choices.',
                },
                qaWarnings: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: 'Semantic, register, or duration risk warnings if any.',
                },
              },
              required: [
                'hindiTranslation',
                'conciseAlternative',
                'naturalAlternative',
                'culturalNote',
                'humorOrIdiomAdapted',
                'agreesWithLocalDraft',
                'confidence',
                'reasoning',
                'qaWarnings',
              ],
            },
          },
        })
      );

      recordUsage(model, response.usageMetadata);
      sessionUsage.lastVerifiedAt = new Date().toISOString();
      sessionUsage.lastVerifiedOk = true;
      sessionUsage.lastError = null;

      const rawText = response.text?.trim();
      if (!rawText) {
        throw new Error('Gemini returned an empty structured response.');
      }

      const parsed = JSON.parse(rawText);
      res.json({
        ok: true,
        model,
        result: parsed,
        usage: { ...sessionUsage },
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Gemini collaborative intelligence request failed.';
      sessionUsage.lastError = message;
      res.status(502).json({
        ok: false,
        error: message,
      });
    }
  });

  // 3. Optional Gemini Cloud Hindi TTS endpoint (gemini-3.8-flash-lite-tts / gemini-3.8-flash-tts)
  app.post('/api/gemini/tts', async (req, res) => {
    const ai = createGenAIClient();
    if (!ai) {
      res.status(503).json({
        ok: false,
        error: 'Server GEMINI_API_KEY is not configured for Cloud TTS.',
      });
      return;
    }

    try {
      const body = req.body ?? {};
      const text = String(body.text ?? '').trim();
      if (!text) {
        res.status(400).json({ ok: false, error: 'Text is required for speech synthesis.' });
        return;
      }

      const requestedModel = String(body.model ?? DEFAULT_TTS_MODEL);
      const model = ALLOWED_TTS_MODELS.has(requestedModel)
        ? requestedModel
        : DEFAULT_TTS_MODEL;
      const requestedVoice = String(body.voiceName ?? 'Kore');
      const voiceName = ALLOWED_TTS_VOICES.has(requestedVoice) ? requestedVoice : 'Kore';
      const style = String(
        body.style ?? 'Natural, expressive Hindi anime voice acting'
      ).slice(0, 180);

      const response = await withRetry(() =>
        ai.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              parts: [
                {
                  text,
                  speechMetadata: {
                    style,
                  },
                },
              ],
            },
          ],
          config: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName },
              },
            },
          },
        })
      );

      const base64Audio =
        response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) {
        throw new Error('Gemini TTS response did not include audio inlineData.');
      }

      sessionUsage.ttsRequests += 1;
      recordUsage(model, response.usageMetadata);
      sessionUsage.lastVerifiedOk = true;
      sessionUsage.lastError = null;

      // Unary Gemini 3.8 TTS returns a complete 24kHz mono 16-bit WAV file directly
      res.json({
        ok: true,
        model,
        voiceName,
        mimeType: 'audio/wav',
        sampleRate: 24000,
        audioBase64: base64Audio,
        usage: { ...sessionUsage },
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Gemini Cloud TTS generation failed.';
      sessionUsage.lastError = message;
      res.status(502).json({
        ok: false,
        error: message,
      });
    }
  });

  if (!IS_PROD) {
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
      const indexHtml = path.join(distDir, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(404).send('Build output not found. Run npm run build first.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`KoeDub Studio server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start KoeDub Studio server:', err);
  process.exit(1);
});
