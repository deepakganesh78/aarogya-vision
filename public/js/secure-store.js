// Encrypted on-device storage for cases waiting to be sent, plus an encrypted cache of the
// worker's synced cases. Uses AES-GCM with a non-extractable key kept in IndexedDB, so the raw
// key cannot be read out by scripts; it protects data at rest in the browser profile.

const DB_NAME = 'aarogya-vision';
const DB_VERSION = 1;

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let dbPromise;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('keys');
        db.createObjectStore('outbox', { keyPath: 'id' });
        db.createObjectStore('cache');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function withStore(name, mode, fn) {
  const db = await openDb();
  const tx = db.transaction(name, mode);
  const result = await fn(tx.objectStore(name));
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return result;
}

let keyPromise;
function getKey() {
  if (!keyPromise) {
    keyPromise = (async () => {
      const existing = await withStore('keys', 'readonly', (s) => promisify(s.get('device')));
      if (existing) return existing;
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await withStore('keys', 'readwrite', (s) => promisify(s.put(key, 'device')));
      return key;
    })();
  }
  return keyPromise;
}

async function encrypt(bytes) {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
  return { iv, data };
}

async function decrypt({ iv, data }) {
  const key = await getKey();
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function encryptJson(obj) {
  return encrypt(encoder.encode(JSON.stringify(obj)));
}

async function decryptJson(box) {
  return JSON.parse(decoder.decode(await decrypt(box)));
}

async function encryptBlob(blob) {
  if (!blob) return null;
  const box = await encrypt(await blob.arrayBuffer());
  return { ...box, type: blob.type };
}

async function decryptBlob(box) {
  if (!box) return null;
  return new Blob([await decrypt(box)], { type: box.type });
}

export function isSecureStorageAvailable() {
  return Boolean(window.indexedDB && window.crypto?.subtle && window.isSecureContext);
}

/** @param {{id: string, meta: object, triage: object, photo: Blob|null, audio: Blob|null}} entry */
export async function addToOutbox({ id, meta, triage, photo, audio }) {
  const record = {
    id,
    savedAt: new Date().toISOString(),
    state: 'queued',
    attempts: 0,
    lastError: null,
    meta: await encryptJson({ meta, triage }),
    photo: await encryptBlob(photo),
    audio: await encryptBlob(audio)
  };
  await withStore('outbox', 'readwrite', (s) => promisify(s.put(record)));
}

export async function listOutbox() {
  const records = await withStore('outbox', 'readonly', (s) => promisify(s.getAll()));
  const out = [];
  for (const r of records) {
    const { meta, triage } = await decryptJson(r.meta);
    out.push({ id: r.id, savedAt: r.savedAt, state: r.state, attempts: r.attempts, lastError: r.lastError, meta, triage });
  }
  return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export async function loadOutboxEntry(id) {
  const r = await withStore('outbox', 'readonly', (s) => promisify(s.get(id)));
  if (!r) return null;
  const { meta } = await decryptJson(r.meta);
  return { meta, photo: await decryptBlob(r.photo), audio: await decryptBlob(r.audio) };
}

export async function updateOutbox(id, patch) {
  await withStore('outbox', 'readwrite', async (s) => {
    const r = await promisify(s.get(id));
    if (r) await promisify(s.put({ ...r, ...patch }));
  });
}

export async function removeFromOutbox(id) {
  await withStore('outbox', 'readwrite', (s) => promisify(s.delete(id)));
}

export async function saveCache(name, value) {
  const box = await encryptJson(value);
  await withStore('cache', 'readwrite', (s) => promisify(s.put(box, name)));
}

export async function loadCache(name) {
  const box = await withStore('cache', 'readonly', (s) => promisify(s.get(name)));
  return box ? decryptJson(box) : null;
}

export async function clearCache() {
  await withStore('cache', 'readwrite', (s) => promisify(s.clear()));
}
