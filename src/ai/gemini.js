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

/** @param {{config: object, client?: {models: {generateContent: Function}}}} options */
export function createGeminiProvider({ config, client }) {
  const ai = client || createClient(config);
  const model = config.model;

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

    const response = await withTimeout(config.timeoutMs, (abortSignal) =>
      ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
          responseMimeType: 'application/json',
          responseJsonSchema: AI_OUTPUT_JSON_SCHEMA,
          temperature: 0.1,
          abortSignal
        }
      })
    );

    assertNotBlocked(response);
    const text = response?.text;
    if (!text) throw new Error('model returned an empty response');
    return { raw: text, output: parseAiOutput(text) };
  }

  async function translate(text, lang) {
    const response = await withTimeout(config.timeoutMs, (abortSignal) =>
      ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text }] }],
        config: { systemInstruction: buildTranslationInstruction(lang), temperature: 0, abortSignal }
      })
    );
    assertNotBlocked(response);
    const out = response?.text?.trim();
    if (!out) throw new Error('model returned an empty translation');
    return out;
  }

  return { name: 'gemini', model, promptVersion: PROMPT_VERSION, analyze, translate };
}
