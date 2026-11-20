import WebSocket, { WebSocketServer } from 'ws';
import { createClient } from '../ai/gemini.js';
import { buildLiveInstruction } from '../ai/prompt.js';

// Live speech relay: Gemini Live API (Vertex AI in production).
//
//   phone --(PCM 16 kHz mono, binary frames)--> /api/speech/live?token=...&lang=xx --> Gemini Live
//         <--(JSON: live text / follow-up text, binary: spoken follow-up PCM 24 kHz)--
//
// While the worker speaks, Gemini Live transcribes her words in her own language. When she stops, Gemini
// asks at most two short spoken follow-up questions about signs she did not mention (questions only:
// no diagnosis, no advice, no urgency; the checklist and the doctor decide). The final transcript is
// translated to English with Gemini. Nothing is stored here: the phone sends the text with the visit.
export const LIVE_PATH = '/api/speech/live';
const MAX_SESSION_MS = 3 * 60 * 1000; // a voice note is at most 2 minutes
const MAX_FRAME_BYTES = 16_000; // 500 ms at 16 kHz, 16-bit
const FOLLOWUP_WAIT_MS = 15_000;

/** Default connector: a Gemini Live session through @google/genai. */
export function geminiLiveConnector(config) {
  const ai = createClient(config);
  return ({ lang, callbacks }) =>
    ai.live.connect({
      model: config.model,
      config: {
        responseModalities: ['AUDIO'],
        systemInstruction: buildLiveInstruction(lang),
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } }
      },
      callbacks
    });
}

/**
 * @param {import('node:http').Server} server
 * @param {{config: {model: string}, auth: {verifyToken: Function}, connect: Function, translate?: (text: string) => Promise<string>, audit?: {log: Function}, logger?: Console}} deps
 */
export function attachLiveSpeech(server, { config, auth, connect, translate, audit, logger = console }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== LIVE_PATH) return;
    const user = auth.verifyToken(url.searchParams.get('token') || '');
    if (!user || user.role !== 'worker') {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const lang = ['en', 'hi', 'ta'].includes(url.searchParams.get('lang')) ? url.searchParams.get('lang') : 'en';
    wss.handleUpgrade(req, socket, head, (client) => session(client, user, lang));
  });

  function session(client, user, lang) {
    const send = (msg) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(msg));
    let live = null;
    let ready = false;
    let closed = false;
    let ended = false;
    let original = '';
    let followup = '';
    const startedAt = Date.now();
    audit?.log({ type: 'speech.live_started', actor: user.id, provider: 'gemini-live', model: config.model });

    function closeAll(reason) {
      if (closed) return;
      closed = true;
      clearTimeout(limit);
      try {
        live?.close();
      } catch {
        // already closed
      }
      if (client.readyState === WebSocket.OPEN) client.close(1000, reason);
      audit?.log({ type: 'speech.live_ended', actor: user.id, provider: 'gemini-live', seconds: Math.round((Date.now() - startedAt) / 1000) });
    }
    const limit = setTimeout(() => closeAll('session too long'), MAX_SESSION_MS);

    let finishing = false;
    async function finish() {
      if (closed || finishing) return;
      finishing = true;
      send({ event: 'final', stream: 'original', utterance: 0, text: original.trim(), language: lang });
      let english = '';
      if (original.trim() && translate) {
        try {
          english = await translate(original.trim());
        } catch (err) {
          logger.warn(`[gemini-live] translation failed: ${err.message}`);
        }
      }
      send({ event: 'final', stream: 'english', utterance: 0, text: english, language: 'en' });
      send({ event: 'done' });
      closeAll('done');
    }

    function onmessage(msg) {
      if (closed) return;
      if (msg.setupComplete && !ready) {
        ready = true;
        send({ event: 'ready' });
        return;
      }
      const sc = msg.serverContent;
      if (!sc) return;
      if (sc.inputTranscription?.text) {
        original += sc.inputTranscription.text;
        send({ event: 'partial', stream: 'original', utterance: 0, text: original.trim(), language: lang });
      }
      if (sc.outputTranscription?.text) {
        followup += sc.outputTranscription.text;
        send({ event: 'followup', text: followup.trim() });
      }
      for (const part of sc.modelTurn?.parts || []) {
        if (part.inlineData?.data && client.readyState === WebSocket.OPEN) client.send(Buffer.from(part.inlineData.data, 'base64'));
      }
      if (sc.turnComplete && ended) finish();
    }

    Promise.resolve(
      connect({
        lang,
        callbacks: {
          onopen() {},
          onmessage,
          onerror(err) {
            logger.warn(`[gemini-live] ${err?.message || err}`);
            send({ event: 'error', code: 'provider_error', fatal: true });
            closeAll('provider error');
          },
          onclose() {
            if (!closed && ended) finish();
            else if (!closed) {
              send({ event: 'error', code: 'provider_closed', fatal: true });
              closeAll('provider closed');
            }
          }
        }
      })
    )
      .then((s) => {
        live = s;
        if (closed) return s.close();
        s.sendRealtimeInput({ activityStart: {} });
      })
      .catch((err) => {
        logger.warn(`[gemini-live] connect failed: ${err.message}`);
        send({ event: 'error', code: 'unreachable', fatal: true });
        closeAll('provider unreachable');
      });

    client.on('message', (data, isBinary) => {
      if (closed) return;
      if (isBinary) {
        if (!live || ended || data.length === 0 || data.length > MAX_FRAME_BYTES || data.length % 2 !== 0) return;
        live.sendRealtimeInput({ audio: { data: Buffer.from(data).toString('base64'), mimeType: 'audio/pcm;rate=16000' } });
        return;
      }
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.event === 'end' && !ended) {
        ended = true;
        try {
          live?.sendRealtimeInput({ activityEnd: {} });
        } catch {
          // provider gone: finish with what we have
        }
        // Safety net if the follow-up never completes.
        setTimeout(() => finish(), FOLLOWUP_WAIT_MS).unref?.();
      }
    });
    client.on('close', () => closeAll('client closed'));
    client.on('error', () => closeAll('client error'));
  }

  return { wss, close: () => wss.close() };
}
