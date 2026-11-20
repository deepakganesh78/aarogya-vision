import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { createServices } from '../src/bootstrap.js';
import { SIGN_IDS } from '../public/shared/dangerSigns.js';

export const FAKE_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
export const FAKE_WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 2)]);

export async function startTestServer({ env = {}, overrides = {} } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'av-test-'));
  const config = loadConfig({ AI_PROVIDER: 'mock', DATA_DIR: dataDir, SESSION_SECRET: 'test-secret', ...env });
  const services = await createServices(config, overrides);
  const server = await new Promise((resolve) => {
    const s = services.app.listen(0, () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function login(code) {
    const res = await fetch(`${baseUrl}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const body = await res.json();
    return body.token;
  }

  async function close() {
    await services.processor.drain();
    await services.audit.flush();
    await new Promise((resolve) => server.close(resolve));
    services.store.close?.();
    await fs.rm(dataDir, { recursive: true, force: true });
  }

  return { baseUrl, services, config, login, close, dataDir, server };
}

export function buildCase(overrides = {}) {
  const now = new Date().toISOString();
  const signs = Object.fromEntries(SIGN_IDS.map((id) => [id, 'no']));
  return {
    id: crypto.randomUUID(),
    capturedAt: now,
    language: 'ta',
    consent: { given: true, givenBy: 'mother', method: 'verbal', at: now },
    patient: { ageDays: 8, sex: 'female' },
    assessment: { signs, temperatureC: null, breathsPerMin: null, notes: 'Baby feels hot and is not feeding. Red skin around the navel.' },
    audioDurationSec: 12,
    ...overrides
  };
}

export async function submitCase(baseUrl, token, record, { photo = FAKE_JPEG, audio = FAKE_WEBM, photoType = 'image/jpeg', audioType = 'audio/webm;codecs=opus' } = {}) {
  const form = new FormData();
  form.append('case', JSON.stringify(record));
  if (photo) form.append('photo', new Blob([photo], { type: photoType }), 'photo.jpg');
  if (audio) form.append('audio', new Blob([audio], { type: audioType }), 'voice.webm');
  return fetch(`${baseUrl}/api/cases`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
}

export function authed(token) {
  return { Authorization: `Bearer ${token}` };
}
