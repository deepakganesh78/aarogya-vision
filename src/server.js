import { loadConfig } from './config.js';
import { createServices, purgeExpired } from './bootstrap.js';
import { attachLiveSpeech, geminiLiveConnector } from './speech/geminiLive.js';

const config = loadConfig();
const services = await createServices(config);

const server = services.app.listen(config.port, () => {
  console.log(`Aarogya-Vision listening on http://localhost:${config.port}`);
  console.log(`  store=${config.store} ai=${config.ai.provider}${config.ai.provider === 'gemini' ? ` model=${config.ai.model}` : ''}`);
  if (config.usingDemoCodes) console.log('  using DEMO access codes: worker "asha-demo", doctor "doctor-demo"');
});

if (config.speech.provider === 'gemini-live') {
  attachLiveSpeech(server, {
    config: config.speech,
    auth: services.auth,
    audit: services.audit,
    connect: geminiLiveConnector(config.speech),
    translate: services.provider?.translateTranscript
  });
  console.log(`  live speech: Gemini Live ${config.speech.model} (${config.speech.enterprise ? `Vertex AI ${config.speech.location}` : 'Gemini API'})`);
}

try {
  await services.events.start?.();
  if (config.pubsub) console.log(`  events: Pub/Sub topic ${config.pubsub.topic}`);
} catch (err) {
  console.error(`Pub/Sub fan-out unavailable, using this instance only: ${err.message}`);
}

await services.processor.resumePending();

async function runRetention() {
  try {
    const removed = await purgeExpired({ store: services.store, audit: services.audit, retentionDays: config.retentionDays, fhirStore: services.fhirStore });
    if (removed) console.log(`retention: purged ${removed} case(s) older than ${config.retentionDays} days`);
  } catch (err) {
    console.error('retention purge failed', err.message);
  }
}
await runRetention();
const retentionTimer = setInterval(runRetention, 6 * 60 * 60 * 1000);
retentionTimer.unref();

function shutdown() {
  services.events.stop?.().catch(() => {});
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
