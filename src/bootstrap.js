import { createApp } from './app.js';
import { createAnalytics, createBigQueryTable } from './analytics.js';
import { createAudit } from './audit.js';
import { createAuth } from './auth.js';
import { loadGuidelines } from './guidelines.js';
import { createProcessor } from './pipeline.js';
import { createGeminiProvider } from './ai/gemini.js';
import { createMockProvider } from './ai/mock.js';
import { LocalStore } from './store/localStore.js';
import { SqliteStore } from './store/sqliteStore.js';
import { createEvents } from './events.js';
import { buildFhirBundle } from './fhir.js';
import { createHealthcareFhir } from './healthcare.js';
import { createRagRetriever } from './rag.js';
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
    (config.store === 'gcp'
      ? await GcpStore.fromEnvironment(config.gcp)
      : config.store === 'local'
        ? await new LocalStore(config.dataDir).init()
        : await new SqliteStore(config.dataDir).init());
  const sink = config.auditSink === 'sqlite' && !store.writeAudit ? 'file' : config.auditSink;
  const audit = overrides.audit || createAudit({ sink, dataDir: config.dataDir, store });
  let events = overrides.events;
  if (!events) {
    let pubsub = null;
    if (config.pubsub) {
      const { PubSub } = await import('@google-cloud/pubsub');
      pubsub = new PubSub({ projectId: config.pubsub.projectId });
    }
    events = createEvents({ pubsub, topicName: config.pubsub?.topic });
  }
  const provider = 'provider' in overrides ? overrides.provider : createProvider(config.ai);
  const guidelines = loadGuidelines();
  const rag = 'rag' in overrides ? overrides.rag : config.rag ? await createRagRetriever(config.rag) : null;
  const fhirStore = 'fhirStore' in overrides ? overrides.fhirStore : config.healthcare ? await createHealthcareFhir(config.healthcare) : null;
  const auth = createAuth(config);
  const analytics =
    overrides.analytics ||
    createAnalytics({ table: config.analytics.dataset ? await createBigQueryTable(config.analytics) : null, salt: config.analytics.salt });
  const processor = createProcessor({ store, provider, guidelines, rag, fhirStore, audit, analytics, events, dataDir: config.dataDir, concurrency: config.ai.concurrency });
  const app = createApp({ config, store, audit, processor, provider, auth, guidelines, analytics, events });
  return { app, store, audit, provider, guidelines, rag, fhirStore, auth, processor, analytics, events };
}

// Data minimisation: delete cases (records + media + FHIR resources) older than the retention window.
export async function purgeExpired({ store, audit, retentionDays, fhirStore, now = Date.now(), logger = console }) {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const record of await store.listAll()) {
    if (Date.parse(record.receivedAt) < cutoff) {
      if (fhirStore) {
        try {
          await fhirStore.remove(buildFhirBundle(record));
        } catch (err) {
          logger.warn(`FHIR purge for ${record.id} failed: ${err.message}`);
        }
      }
      await store.delete(record.id);
      audit.log({ type: 'case.purged', caseId: record.id, retentionDays });
      removed += 1;
    }
  }
  return removed;
}
