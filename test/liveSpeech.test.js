import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { attachLiveSpeech } from '../src/speech/geminiLive.js';
import { triageAssessment } from '../public/shared/triage.js';
import { authed, buildCase, startTestServer, submitCase } from './helpers.js';

// A fake Gemini Live session: activity start/end with manual VAD, input transcription while she speaks,
// then a spoken follow-up question (audio + output transcription) and turnComplete.
function fakeLive() {
  const seen = { audioBytes: 0, inputs: [], lang: null };
  const connect = async ({ lang, callbacks }) => {
    seen.lang = lang;
    setTimeout(() => callbacks.onmessage({ setupComplete: {} }), 0);
    return {
      sendRealtimeInput(input) {
        seen.inputs.push(Object.keys(input)[0]);
        if (input.audio) {
          if (!seen.audioBytes) callbacks.onmessage({ serverContent: { inputTranscription: { text: 'குழந்தை ' } } });
          seen.audioBytes += Buffer.from(input.audio.data, 'base64').length;
        }
        if (input.activityEnd) {
          callbacks.onmessage({ serverContent: { inputTranscription: { text: 'பால் குடிக்கவில்லை, காய்ச்சல்.' } } });
          callbacks.onmessage({ serverContent: { modelTurn: { parts: [{ inlineData: { data: Buffer.alloc(480).toString('base64'), mimeType: 'audio/pcm;rate=24000' } }] }, outputTranscription: { text: 'வலிப்பு உள்ளதா?' } } });
          callbacks.onmessage({ serverContent: { turnComplete: true } });
        }
      },
      close() {}
    };
  };
  return { seen, connect };
}

describe('live speech relay (Gemini Live)', () => {
  let live;
  let ctx;

  before(async () => {
    live = fakeLive();
    ctx = await startTestServer();
    attachLiveSpeech(ctx.server, {
      config: { model: 'gemini-3.8-live' },
      auth: ctx.services.auth,
      connect: live.connect,
      translate: async () => 'Baby is not feeding and has fever.',
      logger: { warn() {} }
    });
  });
  after(async () => {
    await ctx.close();
  });

  const liveUrl = (token) => `${ctx.baseUrl.replace('http', 'ws')}/api/speech/live?token=${encodeURIComponent(token)}`;

  it('needs Vertex AI or a Gemini key, and is off by default', () => {
    assert.throws(() => loadConfig({ SPEECH_PROVIDER: 'gemini-live' }), /GOOGLE_GENAI_USE_ENTERPRISE/);
    assert.throws(() => loadConfig({ SPEECH_PROVIDER: 'sarvam' }), /none or gemini-live/);
    assert.equal(loadConfig({ SPEECH_PROVIDER: 'gemini-live', GOOGLE_GENAI_USE_ENTERPRISE: 'true', GOOGLE_CLOUD_PROJECT: 'p' }).speech.model, 'gemini-3.8-live');
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

  it('relays audio to Gemini Live, returns live text, a spoken follow-up and English', async () => {
    const token = await ctx.login('asha-demo');
    const ws = new WebSocket(`${liveUrl(token)}&lang=ta`);
    const messages = [];
    let audioFrames = 0;
    await new Promise((resolve, reject) => {
      ws.on('message', (d, isBinary) => {
        if (isBinary) {
          audioFrames += 1;
          return;
        }
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

    assert.equal(live.seen.lang, 'ta');
    assert.equal(live.seen.audioBytes, 6400);
    assert.equal(live.seen.inputs[0], 'activityStart');
    assert.ok(live.seen.inputs.includes('activityEnd'));
    assert.equal(audioFrames, 1, 'spoken follow-up is relayed to the phone');
    assert.ok(messages.some((m) => m.event === 'partial' && m.stream === 'original'));
    assert.ok(messages.some((m) => m.event === 'followup' && m.text === 'வலிப்பு உள்ளதா?'));
    const finals = Object.fromEntries(messages.filter((m) => m.event === 'final').map((m) => [m.stream, m.text]));
    assert.equal(finals.original, 'குழந்தை பால் குடிக்கவில்லை, காய்ச்சல்.');
    assert.equal(finals.english, 'Baby is not feeding and has fever.');
  });

  it('saves the live transcript with the visit and the rules read it', async () => {
    const token = await ctx.login('asha-demo');
    const liveTranscript = { original: 'குழந்தை பால் குடிக்கவில்லை, காய்ச்சல்.', english: 'Baby is not feeding and has fever.', language: 'ta', provider: 'gemini-live', model: 'gemini-3.8-live', followUp: 'வலிப்பு உள்ளதா?' };
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
      assessment: { liveTranscript: { original: '', english: 'Wound with pus on the leg. No fever.', provider: 'gemini-live' } }
    });
    assert.equal(r.signs.wound_infected.source, 'live_voice');
    assert.equal(r.signs.fever.state, 'unknown');
    assert.equal(r.level, 'PRIORITY');
  });
});
