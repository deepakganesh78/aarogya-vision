import crypto from 'node:crypto';
import path from 'node:path';

const DEMO_ACCESS_CODES = [
  { code: 'asha-demo', role: 'worker', id: 'asha-001', name: 'Parvati (ASHA, demo)' },
  { code: 'asha-demo-2', role: 'worker', id: 'asha-002', name: 'Meena (ASHA, demo)' },
  { code: 'doctor-demo', role: 'doctor', id: 'dr-001', name: 'Dr. R. Senthil (demo)' }
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

// A same-origin path ("/models/gemma.task") or an absolute https URL (http only outside production).
function parseGemmaModelUrl(raw, isProd) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('GEMMA_MODEL_URL must be an https URL or a same-origin path starting with /');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !isProd)) throw new Error('GEMMA_MODEL_URL must use https');
  return url.href;
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

  // sqlite = one local database file (default for development); local = JSON files; gcp = Firestore + Cloud Storage.
  // Live speech while the worker speaks: Gemini Live API (live text in her language only, no spoken replies).
  const speechProvider = env.SPEECH_PROVIDER || 'none';
  if (!['none', 'gemini-live'].includes(speechProvider)) throw new Error('SPEECH_PROVIDER must be none or gemini-live');
  if (speechProvider === 'gemini-live' && !enterprise && !env.GEMINI_API_KEY) {
    throw new Error('SPEECH_PROVIDER=gemini-live needs GOOGLE_GENAI_USE_ENTERPRISE=true or GEMINI_API_KEY');
  }

  const gemmaModelUrl = parseGemmaModelUrl(env.GEMMA_MODEL_URL, isProd);

  // Demo: sign the ASHA and the doctor in without an access code. On by default outside production;
  // in production only when AUTO_LOGIN=true is set explicitly (synthetic-data demo deployments).
  if (env.AUTO_LOGIN && !['true', 'false'].includes(env.AUTO_LOGIN)) throw new Error('AUTO_LOGIN must be true or false');
  const autoLogin = env.AUTO_LOGIN ? env.AUTO_LOGIN === 'true' : !isProd;

  const store = env.STORE || (isProd ? 'gcp' : 'sqlite');
  if (!['sqlite', 'local', 'gcp'].includes(store)) throw new Error('STORE must be sqlite, local or gcp');

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
    auditSink: env.AUDIT_SINK || (store === 'gcp' ? 'cloud-logging' : store === 'sqlite' ? 'sqlite' : 'file'),
    analytics: {
      projectId: env.GOOGLE_CLOUD_PROJECT,
      dataset: env.BIGQUERY_DATASET,
      table: env.BIGQUERY_TABLE || 'triage_events',
      salt: env.ANALYTICS_SALT
    },
    accessCodes: parseAccessCodes(env.ACCESS_CODES, isProd),
    usingDemoCodes: !env.ACCESS_CODES,
    autoLogin,
    sessionSecret,
    tokenTtlSec: Number(env.TOKEN_TTL_SEC) || 12 * 60 * 60,
    retentionDays: Number(env.RETENTION_DAYS) || 30,
    maxPhotoBytes: 8 * 1024 * 1024,
    maxAudioBytes: 10 * 1024 * 1024,
    speech: {
      provider: speechProvider,
      model: env.LIVE_MODEL || 'gemini-3.8-live',
      apiKey: env.GEMINI_API_KEY,
      enterprise,
      project: env.GOOGLE_CLOUD_PROJECT,
      location: env.LIVE_LOCATION || env.GOOGLE_CLOUD_LOCATION || 'asia-south1',
      // Behind Firebase Hosting (no WebSockets), the phone opens the live socket on the Cloud Run URL directly.
      wsUrl: env.LIVE_WS_URL && /^wss:\/\/[^/]+\/?$/.test(env.LIVE_WS_URL) ? env.LIVE_WS_URL.replace(/\/$/, '') : null
    },
    // Cloud Pub/Sub topic for case events (urgent alerts + fan-out across Cloud Run instances).
    pubsub: env.PUBSUB_TOPIC ? { topic: env.PUBSUB_TOPIC, projectId: env.GOOGLE_CLOUD_PROJECT } : null,
    // Cloud Healthcare API FHIR R4 store. Without it, bundles are saved under DATA_DIR/fhir.
    healthcare: env.FHIR_STORE
      ? {
          project: env.GOOGLE_CLOUD_PROJECT,
          location: env.HEALTHCARE_LOCATION || 'asia-south1',
          dataset: env.HEALTHCARE_DATASET || 'aarogya',
          fhirStore: env.FHIR_STORE
        }
      : null,
    // Vertex AI RAG Engine corpus of guideline PDFs (supplementary passages for the doctor).
    rag: env.RAG_CORPUS ? { corpus: env.RAG_CORPUS, topK: Number(env.RAG_TOP_K) || 3 } : null,
    // Optional on-phone Gemma helper (MediaPipe LLM Inference). Hidden when unset.
    gemma: gemmaModelUrl ? { modelUrl: gemmaModelUrl } : null,
    ai: {
      provider,
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL || 'gemini-3.8-flash',
      enterprise,
      project: env.GOOGLE_CLOUD_PROJECT,
      location: env.GOOGLE_CLOUD_LOCATION || 'asia-south1',
      // Per model: with fallbacks in GEMINI_MODEL, a slow model gives way to the next one.
      timeoutMs: Number(env.AI_TIMEOUT_MS) || 30_000,
      concurrency: Number(env.AI_CONCURRENCY) || 2
    }
  };
}
