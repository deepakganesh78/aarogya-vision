// Live speech on the phone: streams the microphone to the server relay (/api/speech/live), which forwards it
// to the Gemini Live API for transcription only. While the worker speaks she sees live text in her language;
// when she stops, the final text comes back translated to English. Nothing is ever played back.
// The normal voice-note recording is not affected: if this fails, recording carries on as before.

/**
 * @param {{stream: MediaStream, token: string, lang?: string, onUpdate: (text: {original: string, english: string, language: string|null, interim: boolean}) => void, onStatus: (status: 'connecting'|'live'|'unavailable'|'done') => void}} options
 */
export async function startLiveSpeech({ stream, token, lang = 'en', wsUrl = null, onUpdate, onStatus }) {
  const text = { original: '', english: '' };
  let language = null;
  let interim = true;
  let finished = false;
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const snapshot = () => ({ original: text.original, english: text.english, language, interim });

  onStatus('connecting');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const origin = wsUrl || `${proto}//${location.host}`;
  const ws = new WebSocket(`${origin}/api/speech/live?token=${encodeURIComponent(token)}&lang=${encodeURIComponent(lang)}`);

  let ctx;
  let node;
  let source;
  const queue = [];
  let ready = false;

  function finish(status) {
    if (finished) return;
    finished = true;
    interim = false;
    try {
      node?.disconnect();
      source?.disconnect();
    } catch {
      // already closed
    }
    ctx?.close().catch(() => {});
    onStatus(status);
    resolveDone(snapshot());
  }

  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return; // the relay sends text only
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    if (m.event === 'ready') {
      ready = true;
      onStatus('live');
      for (const frame of queue.splice(0)) ws.send(frame);
    } else if (m.event === 'partial' || m.event === 'final') {
      if (m.stream !== 'original' && m.stream !== 'english') return;
      text[m.stream] = m.text || '';
      if (m.stream === 'original' && m.language) language = m.language;
      onUpdate(snapshot());
    } else if (m.event === 'error' && m.fatal) {
      finish('unavailable');
    } else if (m.event === 'done') {
      finish('done');
    }
  };
  ws.onerror = () => finish('unavailable');
  ws.onclose = () => finish(text.original ? 'done' : 'unavailable');

  try {
    ctx = new AudioContext();
    await ctx.audioWorklet.addModule('/js/pcm-worklet.js');
    source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'pcm-downsampler');
    node.port.onmessage = (e) => {
      if (finished) return;
      if (ready && ws.readyState === WebSocket.OPEN) ws.send(e.data);
      else if (queue.length < 50) queue.push(e.data); // keep up to 5 s while connecting
    };
    source.connect(node);
  } catch {
    ws.close();
    finish('unavailable');
  }

  return {
    /** Stop listening and wait (up to 20 s) for the final transcript and the English text. */
    async stop() {
      if (!finished) {
        try {
          node?.disconnect();
          source?.disconnect();
        } catch {
          // ignore
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event: 'end' }));
        else ws.close();
        setTimeout(() => finish('done'), 20000);
      }
      return done;
    },
    cancel() {
      ws.close();
      finish('done');
    }
  };
}
