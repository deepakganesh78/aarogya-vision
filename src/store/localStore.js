import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { findAsha, findDoctor, PEOPLE } from '../patients.js';

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// File-backed store for local development and tests. Production uses GcpStore (Firestore + Cloud Storage).
export class LocalStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.casesDir = path.join(dataDir, 'cases');
    this.mediaDir = path.join(dataDir, 'media');
    this.patientsFile = path.join(dataDir, 'patients.json');
    this.cases = new Map();
    this.patients = new Map();
    this.locks = new Map();
  }

  async init() {
    await fs.mkdir(this.casesDir, { recursive: true });
    await fs.mkdir(this.mediaDir, { recursive: true });
    for (const name of await fs.readdir(this.casesDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const record = JSON.parse(await fs.readFile(path.join(this.casesDir, name), 'utf8'));
        this.cases.set(record.id, record);
      } catch (err) {
        console.error(`skipping unreadable case file ${name}: ${err.message}`);
      }
    }
    try {
      for (const p of JSON.parse(await fs.readFile(this.patientsFile, 'utf8'))) this.patients.set(p.id, p);
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`skipping unreadable patients file: ${err.message}`);
    }
    return this;
  }

  name = 'local';

  #assertId(id) {
    if (!ID_PATTERN.test(id)) throw new Error('invalid case id');
  }

  async #write(record) {
    const file = path.join(this.casesDir, `${record.id}.json`);
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(record, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }

  async get(id) {
    const record = this.cases.get(id);
    return record ? structuredClone(record) : null;
  }

  async listAll() {
    return [...this.cases.values()].map((r) => structuredClone(r));
  }

  async listByWorker(workerId) {
    return [...this.cases.values()].filter((r) => r.worker.id === workerId).map((r) => structuredClone(r));
  }

  async create(record) {
    this.#assertId(record.id);
    if (this.cases.has(record.id)) throw Object.assign(new Error('case already exists'), { code: 'ALREADY_EXISTS' });
    await this.#write(record);
    this.cases.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  // Serialized read-modify-write per case so concurrent updates (AI pipeline vs doctor) don't clobber each other.
  async update(id, mutate) {
    const previous = this.locks.get(id) || Promise.resolve();
    const run = previous.then(async () => {
      const current = this.cases.get(id);
      if (!current) throw new Error('case not found');
      const next = structuredClone(current);
      const result = (await mutate(next)) ?? next;
      result.updatedAt = new Date().toISOString();
      await this.#write(result);
      this.cases.set(id, structuredClone(result));
      return structuredClone(result);
    });
    const settled = run.catch(() => {});
    this.locks.set(id, settled);
    settled.then(() => {
      if (this.locks.get(id) === settled) this.locks.delete(id);
    });
    return run;
  }

  async saveMedia(id, kind, buffer, extension, _mimeType) {
    this.#assertId(id);
    const dir = path.join(this.mediaDir, id);
    await fs.mkdir(dir, { recursive: true });
    const file = `${kind}.${extension}`;
    await fs.writeFile(path.join(dir, file), buffer);
    return file;
  }

  async readMedia(id, file) {
    this.#assertId(id);
    if (!/^(photo|audio)\.[a-z0-9]+$/.test(file)) throw new Error('invalid media file');
    return fs.readFile(path.join(this.mediaDir, id, file));
  }

  async delete(id) {
    this.#assertId(id);
    await fs.rm(path.join(this.casesDir, `${id}.json`), { force: true });
    await fs.rm(path.join(this.mediaDir, id), { recursive: true, force: true });
    this.cases.delete(id);
  }

  async listByPatient(patientId) {
    return [...this.cases.values()]
      .filter((r) => r.patient?.id === patientId)
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
      .map((r) => structuredClone(r));
  }

  async getPatient(id) {
    const p = this.patients.get(id);
    return p ? structuredClone(p) : null;
  }

  async findPatientByKey(key) {
    if (!key) return null;
    const hit = [...this.patients.values()].find((p) => p.matchKey === key);
    return hit ? structuredClone(hit) : null;
  }

  async putPatient(p) {
    this.patients.set(p.id, structuredClone(p));
    const tmp = `${this.patientsFile}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify([...this.patients.values()], null, 2), 'utf8');
    await fs.rename(tmp, this.patientsFile);
    return p;
  }

  async listPatientsByWorker(workerId) {
    return [...this.patients.values()]
      .filter((p) => p.workerId === workerId)
      .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
      .map((p) => structuredClone(p));
  }

  async getAsha(id) {
    return findAsha(id);
  }

  async listAshas() {
    return PEOPLE.ashas;
  }

  async getDoctor(id) {
    return findDoctor(id);
  }
}
