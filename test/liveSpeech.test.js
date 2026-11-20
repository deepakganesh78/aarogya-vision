import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { loadConfig } from '../src/config.js';
import { attachLiveSpeech } from '../src/speech/sarvamLive.js';
import { triageAssessment } from '../public/shared/triage.js';
import { authed, buildCase, startTestServer, submitCase } from './helpers.js';

// A fake Sarvam realtime server: checks the handshake, echoes partial + final text per mode.
function startFakeSarvam() {
  const seen = [];
  const wss = new WebSocketServer({ port: 0 });
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    const mode = url.searchParams.get('mode');
    seen.push({ key: req.headers['api-subscription-key'], mode, params: Object.fromEntries(url.searchParams) });
    let bytes = 0;
    ws.on('message', (data) => {
      const m = JSON.parse(String(data));
      if (m.event === 'audio_input') {
        bytes += Buffer.from(m.audio, 'base64').length;
        ws.send(JSON.stringify({ event: 'transcript.partial', utterance_idx: 0, text: mode === 'translate' ? 'Baby not' : 'குழந்தை', language: 'ta-IN' }));
      }
      if (m.event === 'end') {
        const text = mode === 'translate' ? 'Baby is not feeding and has fever.' : 'குழந்தை பால் குடிக்கவில்லை, காய்ச்சல்.';
        ws.send(JSON.stringify({ event: 'transcript.final', utterance_idx: 0, text, language: 'ta-IN', language_confidence: '0.97' }));
        ws.send(JSON.stringify({ event: 'session.end', request_id: 'r1', audio_duration_s: String(bytes / 32000) }));
        ws.close();
      }
    });
  });
  return new Promise((resolve) => wss.on('listening', () => resolve({ wss, seen, url: `ws://127.0.0.1:${wss.address().port}/speech-to-text-realtime/ws` })));
}

describe('live speech-to-text relay (Sarvam, local testing only)', () => {
  let fake;
  let ctx;

  before(async () => {
    fake = await startFakeSarvam();
    ctx = await startTestServer();
    attachLiveSpeech(ctx.server, { config: { apiKey: 'test-key', model: 'saaras:v4', url: fake.url }, auth: ctx.services.auth, logger: { warn() {} } });
  });
  after(async () => {
    await ctx.close();
    fake.wss.close();
  });

  const liveUrl = (token) => `${ctx.baseUrl.replace('http', 'ws')}/api/speech/live?token=${encodeURIComponent(token)}`;

  it('refuses Sarvam in production, and without a key', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production', SPEECH_PROVIDER: 'sarvam', SARVAM_API_KEY: 'x', SESSION_SECRET: 's', ACCESS_CODES: '[{"code":"aaaaaaaaaaaaaa","role":"worker","id":"a","name":"A"}]' }), /local testing only/);
    assert.throws(() => loadConfig({ SPEECH_PROVIDER: 'sarvam' }), /SARVAM_API_KEY/);
    assert.equal(loadConfig({}).speech.provider, 'none');
  });

  it('rejects a connection without a worker token', async () => {
    const doctor = await ctx.login('doctor-demo');
    for (const url of [liveUrl(''), liveUrl(doctor)]) {
      const status = await new Promise((resolve) => {
        const ws = new WebSocket(url);
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
        ws.on('open', () => resolve('open'));
        ws.on('error', () => {});
      });
      assert.equal(status, 401);
    }
  });

  it('relays audio to two Sarvam streams and returns live text in her language and in English', async () => {
    const token = await ctx.login('asha-demo');
    const ws = new WebSocket(liveUrl(token));
    const messages = [];
    await new Promise((resolve, reject) => {
      ws.on('message', (d) => {
        const m = JSON.parse(String(d));
        messages.push(m);
        if (m.event === 'ready') {
          ws.send(Buffer.alloc(3200)); // 100 ms of 16 kHz 16-bit silence
          ws.send(Buffer.alloc(3200));
          setTimeout(() => ws.send(JSON.stringify({ event: 'end' })), 50);
        }
        if (m.event === 'done') resolve();
      });
      ws.on('error', reject);
    });
    ws.close();

    assert.equal(fake.seen.length, 2);
    assert.deepEqual(fake.seen.map((s) => s.mode).sort(), ['transcribe', 'translate']);
    for (const s of fake.seen) {
      assert.equal(s.key, 'test-key', 'the key is sent by the server, never by the phone');
      assert.equal(s.params.language_code, 'auto');
      assert.equal(s.params.sample_rate, '16000');
      assert.equal(s.params.encoding, 'linear16');
    }
    assert.ok(messages.some((m) => m.event === 'partial' && m.stream === 'original'));
    const finals = Object.fromEntries(messages.filter((m) => m.event === 'final').map((m) => [m.stream, m.text]));
    assert.equal(finals.original, 'குழந்தை பால் குடிக்கவில்லை, காய்ச்சல்.');
    assert.equal(finals.english, 'Baby is not feeding and has fever.');
    assert.ok(!JSON.stringify(messages).includes('test-key'));
  });

  it('saves the live transcript with the visit and the rules read it', async () => {
    const token = await ctx.login('asha-demo');
    const liveTranscript = { original: 'குழந்தை பால் குடிக்கவில்லை, காய்ச்சல்.', english: 'Baby is not feeding and has fever.', language: 'ta-IN', provider: 'sarvam', model: 'saaras:v4' };
    const record = buildCase({
      patient: { name: 'Baby of Lakshmi', ageValue: 8, ageUnit: 'days', sex: 'female' },
      assessment: { liveTranscript }
    });
    const res = await submitCase(ctx.baseUrl, token, record, { photo: null });
    assert.equal(res.status, 201);
    await ctx.services.processor.drain();
    const doctor = await ctx.login('doctor-demo');
    const { case: c } = await (await fetch(`${ctx.baseUrl}/api/doctor/cases/${record.id}`, { headers: authed(doctor) })).json();
    assert.deepEqual(c.assessment.liveTranscript, liveTranscript);
    assert.equal(c.triage.signs.not_feeding_well.state, 'yes');
    assert.equal(c.triage.level, 'URGENT');
  });

  it('reads negation in the live text like a typed note', () => {
    const r = triageAssessment({
      patient: { ageDays: 34 * 365, sex: 'male' },
      assessment: { liveTranscript: { original: '', english: 'Wound with pus on the leg. No fever.', provider: 'sarvam' } }
    });
    assert.equal(r.signs.wound_infected.source, 'live_voice');
    assert.equal(r.signs.fever.state, 'unknown');
    assert.equal(r.level, 'PRIORITY');
  });
});
