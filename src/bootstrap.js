import { createApp } from './app.js';
import { createAnalytics, createBigQueryTable } from './analytics.js';
import { createAudit } from './audit.js';
import { createAuth } from './auth.js';
import { loadGuidelines } from './guidelines.js';
import { createProcessor } from './pipeline.js';
import { createGeminiProvider } from './ai/gemini.js';
import { createMockProvider } from './ai/mock.js';
import { LocalStore } from './store/localStore.js';
import { GcpStore } from './store/gcpStore.js';

export function createProvider(aiConfig) {
  if (aiConfig.provider === 'gemini') return createGeminiProvider({ config: aiConfig });
  if (aiConfig.provider === 'mock') return createMockProvider();
  return null;
}

/** Wire all services. `overrides` lets tests inject a provider or store. */
export async function createServices(config, overrides = {}) {
  const store =
    overrides.store ||
    (config.store === 'gcp' ? await GcpStore.fromEnvironment(config.gcp) : await new LocalStore(config.dataDir).init());
  const audit = overrides.audit || createAudit({ sink: config.auditSink, dataDir: config.dataDir });
  const provider = 'provider' in overrides ? overrides.provider : createProvider(config.ai);
  const guidelines = loadGuidelines();
  const auth = createAuth(config);
  const analytics =
    overrides.analytics ||
    createAnalytics({ table: config.analytics.dataset ? await createBigQueryTable(config.analytics) : null, salt: config.analytics.salt });
  const processor = createProcessor({ store, provider, guidelines, audit, analytics, concurrency: config.ai.concurrency });
  const app = createApp({ config, store, audit, processor, provider, auth, guidelines, analytics });
  return { app, store, audit, provider, guidelines, auth, processor, analytics };
}

// Data minimisation: delete cases (records + media) older than the retention window.
export async function purgeExpired({ store, audit, retentionDays, now = Date.now() }) {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const record of await store.listAll()) {
    if (Date.parse(record.receivedAt) < cutoff) {
      await store.delete(record.id);
      audit.log({ type: 'case.purged', caseId: record.id, retentionDays });
      removed += 1;
    }
  }
  return removed;
}
