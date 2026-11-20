import WebSocket, { WebSocketServer } from 'ws';

// Live speech-to-text relay: Sarvam AI realtime streaming. LOCAL TESTING ONLY (config refuses it in production).
//
//   phone --(PCM 16 kHz mono, binary frames)--> /api/speech/live?token=... --> Sarvam (two sockets)
//         <--(JSON: partial / final text)------                          <--
//
// The Sarvam key stays on the server. Two upstream sockets get the same audio: one keeps the worker's own
// language ("original"), one translates to English ("english"). Nothing is stored here: the phone sends
// the final text with the visit.
export const LIVE_PATH = '/api/speech/live';
const MAX_SESSION_MS = 3 * 60 * 1000; // a voice note is at most 2 minutes
const MAX_FRAME_BYTES = 16_000; // Sarvam's per-frame cap (500 ms at 16 kHz, 16-bit)

function upstreamUrl(base, { mode, model }) {
  const u = new URL(base);
  u.searchParams.set('language_code', 'auto'); // the app language is not always the spoken language
  u.searchParams.set('model', model);
  u.searchParams.set('mode', mode);
  u.searchParams.set('stream_type', 'balanced');
  u.searchParams.set('encoding', 'linear16');
  u.searchParams.set('sample_rate', '16000');
  return u.toString();
}

/**
 * @param {import('node:http').Server} server
 * @param {{config: {apiKey: string, model: string, url: string}, auth: {verifyToken: Function}, audit?: {log: Function}, logger?: Console}} deps
 */
export function attachLiveSpeech(server, { config, auth, audit, logger = console }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== LIVE_PATH) return; // not ours: leave it for anyone else
    const user = auth.verifyToken(url.searchParams.get('token') || '');
    if (!user || user.role !== 'worker') {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (client) => session(client, user));
  });

  function session(client, user) {
    const send = (msg) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(msg));
    const streams = {};
    let closed = false;
    let ended = false;
    let openCount = 0;
    const startedAt = Date.now();
    audit?.log({ type: 'speech.live_started', actor: user.id, provider: 'sarvam' });

    function closeAll(reason) {
      if (closed) return;
      closed = true;
      clearTimeout(limit);
      for (const s of Object.values(streams)) if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) s.terminate();
      if (client.readyState === WebSocket.OPEN) client.close(1000, reason);
      audit?.log({ type: 'speech.live_ended', actor: user.id, provider: 'sarvam', seconds: Math.round((Date.now() - startedAt) / 1000) });
    }
    const limit = setTimeout(() => closeAll('session too long'), MAX_SESSION_MS);

    for (const [stream, mode] of [
      ['original', 'transcribe'],
      ['english', 'translate']
    ]) {
      const ws = new WebSocket(upstreamUrl(config.url, { mode, model: config.model }), { headers: { 'Api-Subscription-Key': config.apiKey } });
      streams[stream] = ws;
      ws.on('open', () => {
        openCount += 1;
        if (openCount === 2) send({ event: 'ready' });
      });
      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (msg.event === 'transcript.partial' || msg.event === 'transcript.final') {
          send({ event: msg.event === 'transcript.final' ? 'final' : 'partial', stream, utterance: msg.utterance_idx ?? 0, text: msg.text || '', language: msg.language || null });
        } else if (msg.event === 'vad.speech_start' || msg.event === 'vad.speech_end') {
          if (stream === 'original') send({ event: msg.event === 'vad.speech_start' ? 'speech_start' : 'speech_end' });
        } else if (msg.event === 'error') {
          logger.warn(`[sarvam ${stream}] ${msg.code}: ${msg.message}`);
          send({ event: 'error', stream, code: msg.code, fatal: Boolean(msg.is_fatal) });
          if (msg.is_fatal) closeAll('provider error');
        } else if (msg.event === 'session.end') {
          ws.close();
        }
      });
      ws.on('unexpected-response', (_req, res) => {
        logger.warn(`[sarvam ${stream}] handshake rejected: HTTP ${res.statusCode}`);
        send({ event: 'error', stream, code: `http_${res.statusCode}`, fatal: true });
        closeAll('provider rejected');
      });
      ws.on('error', (err) => {
        logger.warn(`[sarvam ${stream}] ${err.message}`);
        send({ event: 'error', stream, code: 'unreachable', fatal: true });
        closeAll('provider unreachable');
      });
      ws.on('close', () => {
        // After the phone said "end", wait for both streams to finish their last final transcript.
        if (ended && Object.values(streams).every((s) => s.readyState === WebSocket.CLOSED)) {
          send({ event: 'done' });
          closeAll('done');
        }
      });
    }

    client.on('message', (data, isBinary) => {
      if (closed) return;
      if (isBinary) {
        if (data.length === 0 || data.length > MAX_FRAME_BYTES || data.length % 2 !== 0) return;
        const audio = Buffer.from(data).toString('base64');
        for (const s of Object.values(streams)) if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify({ event: 'audio_input', audio }));
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
        for (const s of Object.values(streams)) if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify({ event: 'end' }));
        // Safety net if the provider never closes.
        setTimeout(() => {
          send({ event: 'done' });
          closeAll('done');
        }, 8000).unref?.();
      }
    });
    client.on('close', () => closeAll('client closed'));
    client.on('error', () => closeAll('client error'));
  }

  return { wss, close: () => wss.close() };
}
