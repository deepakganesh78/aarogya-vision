// Live speech-to-text on the phone: streams the microphone to the server relay (/api/speech/live), which
// forwards it to Sarvam AI (LOCAL TESTING ONLY) and sends back live text in the worker's language and in English.
// The normal voice-note recording is not affected: if this fails, recording carries on as before.

/**
 * @param {{stream: MediaStream, token: string, onUpdate: (text: {original: string, english: string, language: string|null, interim: boolean}) => void, onStatus: (status: 'connecting'|'live'|'unavailable'|'done') => void}} options
 */
export async function startLiveSpeech({ stream, token, onUpdate, onStatus }) {
  const utterances = { original: new Map(), english: new Map() };
  let language = null;
  let finished = false;
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));

  const join = (map) =>
    [...map.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, u]) => u.text)
      .filter(Boolean)
      .join(' ');
  const snapshot = () => ({
    original: join(utterances.original),
    english: join(utterances.english),
    language,
    interim: [...utterances.original.values(), ...utterances.english.values()].some((u) => !u.final)
  });

  onStatus('connecting');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/speech/live?token=${encodeURIComponent(token)}`);
  ws.binaryType = 'arraybuffer';

  let ctx;
  let node;
  let source;
  const queue = [];
  let ready = false;

  function finish(status) {
    if (finished) return;
    finished = true;
    try {
      node?.disconnect();
      source?.disconnect();
      ctx?.close();
    } catch {
      // already closed
    }
    onStatus(status);
    resolveDone(snapshot());
  }

  ws.onmessage = (e) => {
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
      const map = utterances[m.stream];
      if (!map) return;
      const prev = map.get(m.utterance);
      if (prev?.final && m.event === 'partial') return;
      map.set(m.utterance, { text: m.text, final: m.event === 'final' });
      if (m.stream === 'original' && m.language) language = m.language;
      onUpdate(snapshot());
    } else if (m.event === 'error' && m.fatal) {
      finish('unavailable');
    } else if (m.event === 'done') {
      finish('done');
    }
  };
  ws.onerror = () => finish('unavailable');
  ws.onclose = () => finish(utterances.original.size ? 'done' : 'unavailable');

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
    /** Stop listening and wait (up to 8 s) for the last words to be finalised. */
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
        setTimeout(() => finish('done'), 8000);
      }
      return done;
    },
    cancel() {
      ws.close();
      finish('done');
    }
  };
}
