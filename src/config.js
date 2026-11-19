import crypto from 'node:crypto';
import path from 'node:path';

const DEMO_ACCESS_CODES = [
  { code: 'asha-demo', role: 'worker', id: 'asha-001', name: 'Lakshmi (ASHA, demo)' },
  { code: 'asha-demo-2', role: 'worker', id: 'asha-002', name: 'Meena (ASHA, demo)' },
  { code: 'doctor-demo', role: 'doctor', id: 'dr-001', name: 'Dr. Priya (demo)' }
];

function parseAccessCodes(raw, isProd) {
  if (!raw) {
    if (isProd) throw new Error('ACCESS_CODES is required when NODE_ENV=production');
    return DEMO_ACCESS_CODES;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('ACCESS_CODES must be a JSON array of {code, role, id, name}');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('ACCESS_CODES must be a non-empty JSON array');
  for (const entry of parsed) {
    if (!entry.code || !entry.id || !entry.name || !['worker', 'doctor'].includes(entry.role)) {
      throw new Error('Each ACCESS_CODES entry needs code, id, name and role ("worker" or "doctor")');
    }
    if (isProd && String(entry.code).length < 12) throw new Error('Production access codes must be at least 12 characters');
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const isProd = env.NODE_ENV === 'production';

  let sessionSecret = env.SESSION_SECRET;
  if (!sessionSecret) {
    if (isProd) throw new Error('SESSION_SECRET is required when NODE_ENV=production');
    sessionSecret = crypto.randomBytes(32).toString('hex');
  }

  const enterprise = env.GOOGLE_GENAI_USE_ENTERPRISE === 'true';
  const provider = env.AI_PROVIDER || (env.GEMINI_API_KEY || enterprise ? 'gemini' : 'none');
  if (!['gemini', 'mock', 'none'].includes(provider)) throw new Error('AI_PROVIDER must be gemini, mock or none');
  if (provider === 'mock' && isProd) throw new Error('AI_PROVIDER=mock is not allowed in production');

  const store = env.STORE || (isProd ? 'gcp' : 'local');
  if (!['local', 'gcp'].includes(store)) throw new Error('STORE must be local or gcp');

  return {
    isProd,
    port: Number(env.PORT) || 8080,
    dataDir: path.resolve(env.DATA_DIR || '.localdata'),
    store,
    gcp: {
      bucketName: env.MEDIA_BUCKET,
      databaseId: env.FIRESTORE_DATABASE,
      collection: env.FIRESTORE_COLLECTION || 'cases'
    },
    auditSink: env.AUDIT_SINK || (store === 'gcp' ? 'cloud-logging' : 'file'),
    analytics: {
      projectId: env.GOOGLE_CLOUD_PROJECT,
      dataset: env.BIGQUERY_DATASET,
      table: env.BIGQUERY_TABLE || 'triage_events',
      salt: env.ANALYTICS_SALT
    },
    accessCodes: parseAccessCodes(env.ACCESS_CODES, isProd),
    usingDemoCodes: !env.ACCESS_CODES,
    sessionSecret,
    tokenTtlSec: Number(env.TOKEN_TTL_SEC) || 12 * 60 * 60,
    retentionDays: Number(env.RETENTION_DAYS) || 30,
    maxPhotoBytes: 8 * 1024 * 1024,
    maxAudioBytes: 10 * 1024 * 1024,
    ai: {
      provider,
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL || 'gemini-3.8-flash',
      enterprise,
      project: env.GOOGLE_CLOUD_PROJECT,
      location: env.GOOGLE_CLOUD_LOCATION || 'asia-south1',
      timeoutMs: Number(env.AI_TIMEOUT_MS) || 60_000,
      concurrency: Number(env.AI_CONCURRENCY) || 2
    }
  };
}
