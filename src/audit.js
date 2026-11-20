import fs from 'node:fs/promises';
import path from 'node:path';

// Append-only audit trail of logins, case access, AI outputs and doctor decisions.
// sink "file": JSONL under DATA_DIR (local dev/tests).
// sink "sqlite": the audit table in the local SQLite database.
// sink "cloud-logging": structured JSON on stdout, which Cloud Run ships to Cloud Logging.
// Events carry IDs and hashes, never transcripts, photos or other health content.
export function createAudit({ sink = 'file', dataDir, store } = {}) {
  const file = dataDir ? path.join(dataDir, 'audit.jsonl') : null;
  let chain = Promise.resolve();

  function log(event) {
    const entry = { at: new Date().toISOString(), ...event };
    if (sink === 'sqlite') {
      try {
        store.writeAudit(entry);
      } catch (err) {
        console.error('audit write failed', err.message);
      }
      return Promise.resolve();
    }
    if (sink === 'cloud-logging') {
      process.stdout.write(
        JSON.stringify({ severity: 'NOTICE', message: `audit ${event.type}`, 'logging.googleapis.com/labels': { component: 'audit' }, audit: entry }) + '\n'
      );
      return Promise.resolve();
    }
    chain = chain
      .then(() => fs.appendFile(file, JSON.stringify(entry) + '\n', 'utf8'))
      .catch((err) => console.error('audit write failed', err.message));
    return chain;
  }

  async function read(filterFn = () => true) {
    if (sink === 'sqlite') return store.readAudit().filter(filterFn);
    if (sink !== 'file') throw new Error('audit read is only available for the file and sqlite sinks');
    await chain;
    let text = '';
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter(filterFn);
  }

  return { log, read, flush: () => chain };
}
