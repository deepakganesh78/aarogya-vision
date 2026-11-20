import { GoogleGenAI } from '@google/genai';
import { AI_OUTPUT_JSON_SCHEMA, PROMPT_VERSION, parseAiOutput } from './schema.js';
import { SYSTEM_INSTRUCTION, buildTranslationInstruction, buildUserPrompt } from './prompt.js';

function createClient(config) {
  if (config.enterprise) {
    if (!config.project) throw new Error('GOOGLE_CLOUD_PROJECT is required when GOOGLE_GENAI_USE_ENTERPRISE=true');
    return new GoogleGenAI({ enterprise: true, project: config.project, location: config.location });
  }
  if (!config.apiKey) throw new Error('GEMINI_API_KEY is required for AI_PROVIDER=gemini');
  return new GoogleGenAI({ apiKey: config.apiKey });
}

const BLOCKED_FINISH_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);

// Gemini's safety filters can block a request or a response. Surface that as an explicit failure
// so the case falls back to human review instead of showing a partial summary.
function assertNotBlocked(response) {
  const blockReason = response?.promptFeedback?.blockReason;
  if (blockReason) throw new Error(`blocked by Gemini safety filters (${blockReason})`);
  const finishReason = response?.candidates?.[0]?.finishReason;
  if (finishReason && BLOCKED_FINISH_REASONS.has(finishReason)) throw new Error(`response stopped by Gemini (${finishReason})`);
}

async function withTimeout(timeoutMs, fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// Temporary or model-specific failures (overloaded, rate-limited, model not found): try the next model.
function isRetryable(err) {
  // A model that does not answer in time is treated like an overloaded one.
  if (err?.name === 'AbortError') return true;
  const text = String(err?.message || err);
  const status = err?.status ?? err?.code;
  return [404, 429, 500, 503].includes(Number(status)) || /(404|429|500|503)|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded|not found/i.test(text);
}

/** @param {{config: object, client?: {models: {generateContent: Function}}}} options */
export function createGeminiProvider({ config, client }) {
  const ai = client || createClient(config);
  // GEMINI_MODEL may list fallbacks: "gemini-3.8-flash,gemini-flash-latest". The first that answers is used.
  const models = String(config.model || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  const model = models[0];

  async function generate(request) {
    let lastError;
    for (const m of models) {
      try {
        const response = await withTimeout(config.timeoutMs, (abortSignal) => ai.models.generateContent({ ...request, model: m, config: { ...request.config, abortSignal } }));
        return { response, model: m };
      } catch (err) {
        lastError = err;
        if (!isRetryable(err)) throw err;
      }
    }
    throw lastError;
  }

  async function analyze({ caseRecord, photo, audio }) {
    const parts = [{ text: buildUserPrompt(caseRecord, { hasPhoto: Boolean(photo), hasAudio: Boolean(audio) }) }];
    if (photo) {
      parts.push({ text: 'Photo taken by the ASHA worker:' });
      parts.push({ inlineData: { mimeType: photo.mimeType, data: photo.buffer.toString('base64') } });
    }
    if (audio) {
      parts.push({ text: 'Voice note recorded by the ASHA worker:' });
      parts.push({ inlineData: { mimeType: audio.mimeType, data: audio.buffer.toString('base64') } });
    }

    const { response, model: used } = await generate({
      contents: [{ role: 'user', parts }],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseJsonSchema: AI_OUTPUT_JSON_SCHEMA,
        temperature: 0.1
      }
    });

    assertNotBlocked(response);
    const text = response?.text;
    if (!text) throw new Error('model returned an empty response');
    return { raw: text, output: parseAiOutput(text), model: used };
  }

  async function translate(text, lang) {
    const { response } = await generate({
      contents: [{ role: 'user', parts: [{ text }] }],
      config: { systemInstruction: buildTranslationInstruction(lang), temperature: 0 }
    });
    assertNotBlocked(response);
    const out = response?.text?.trim();
    if (!out) throw new Error('model returned an empty translation');
    return out;
  }

  return { name: 'gemini', model, promptVersion: PROMPT_VERSION, analyze, translate };
}
