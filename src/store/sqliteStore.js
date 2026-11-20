import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PEOPLE } from '../patients.js';

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Local database: one SQLite file (DATA_DIR/aarogya.db), built into Node, nothing to install.
// Tables: ashas, doctors, patients, cases, audit. Photos and voice notes stay as files under DATA_DIR/media.
// Production uses GcpStore (Firestore + Cloud Storage) with the same interface.
export class SqliteStore {
  name = 'sqlite';

  constructor(dataDir) {
    this.dataDir = dataDir;
    this.mediaDir = path.join(dataDir, 'media');
    this.file = path.join(dataDir, 'aarogya.db');
    this.locks = new Map();
  }

  async init() {
    await fs.mkdir(this.mediaDir, { recursive: true });
    const db = new DatabaseSync(this.file);
    this.db = db;
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS ashas    (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS doctors  (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS patients (
        id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, match_key TEXT, name TEXT, last_seen TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS patients_worker ON patients(worker_id, last_seen);
      CREATE INDEX IF NOT EXISTS patients_key ON patients(match_key);
      CREATE TABLE IF NOT EXISTS cases (
        id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, patient_id TEXT, received_at TEXT NOT NULL,
        status TEXT, level TEXT, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS cases_worker ON cases(worker_id, received_at);
      CREATE INDEX IF NOT EXISTS cases_patient ON cases(patient_id, received_at);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT, case_id TEXT, data TEXT NOT NULL);
    `);
    // Demo people are (re)loaded from src/people.json on every start.
    const upAsha = db.prepare('INSERT OR REPLACE INTO ashas (id, data) VALUES (?, ?)');
    const upDoctor = db.prepare('INSERT OR REPLACE INTO doctors (id, data) VALUES (?, ?)');
    for (const a of PEOPLE.ashas) upAsha.run(a.id, JSON.stringify(a));
    for (const d of PEOPLE.doctors) upDoctor.run(d.id, JSON.stringify(d));

    this.q = {
      getCase: db.prepare('SELECT data FROM cases WHERE id = ?'),
      insertCase: db.prepare('INSERT INTO cases (id, worker_id, patient_id, received_at, status, level, data) VALUES (?, ?, ?, ?, ?, ?, ?)'),
      updateCase: db.prepare('UPDATE cases SET patient_id = ?, received_at = ?, status = ?, level = ?, data = ? WHERE id = ?'),
      allCases: db.prepare('SELECT data FROM cases ORDER BY received_at DESC LIMIT 1000'),
      workerCases: db.prepare('SELECT data FROM cases WHERE worker_id = ? ORDER BY received_at DESC LIMIT 500'),
      patientCases: db.prepare('SELECT data FROM cases WHERE patient_id = ? ORDER BY received_at DESC'),
      deleteCase: db.prepare('DELETE FROM cases WHERE id = ?'),
      getPatient: db.prepare('SELECT data FROM patients WHERE id = ?'),
      patientByKey: db.prepare('SELECT data FROM patients WHERE match_key = ? ORDER BY last_seen DESC LIMIT 1'),
      putPatient: db.prepare('INSERT OR REPLACE INTO patients (id, worker_id, match_key, name, last_seen, data) VALUES (?, ?, ?, ?, ?, ?)'),
      workerPatients: db.prepare('SELECT data FROM patients WHERE worker_id = ? ORDER BY last_seen DESC LIMIT 1000'),
      getAsha: db.prepare('SELECT data FROM ashas WHERE id = ?'),
      allAshas: db.prepare('SELECT data FROM ashas ORDER BY id'),
      getDoctor: db.prepare('SELECT data FROM doctors WHERE id = ?'),
      audit: db.prepare('INSERT INTO audit (at, type, case_id, data) VALUES (?, ?, ?, ?)'),
      auditAll: db.prepare('SELECT data FROM audit ORDER BY id')
    };
    return this;
  }

  #assertId(id) {
    if (!ID_PATTERN.test(id)) throw new Error('invalid case id');
  }

  #parse(row) {
    return row ? JSON.parse(row.data) : null;
  }

  // ---- Cases -----------------------------------------------------------------------------------

  async get(id) {
    return this.#parse(this.q.getCase.get(id));
  }

  async listAll() {
    return this.q.allCases.all().map((r) => this.#parse(r));
  }

  async listByWorker(workerId) {
    return this.q.workerCases.all(workerId).map((r) => this.#parse(r));
  }

  async listByPatient(patientId) {
    return this.q.patientCases.all(patientId).map((r) => this.#parse(r));
  }

  async create(record) {
    this.#assertId(record.id);
    try {
      this.q.insertCase.run(record.id, record.worker.id, record.patient?.id || null, record.receivedAt, record.status, record.triage?.level || null, JSON.stringify(record));
    } catch (err) {
      if (/UNIQUE|PRIMARY KEY/i.test(String(err.message))) throw Object.assign(new Error('case already exists'), { code: 'ALREADY_EXISTS' });
      throw err;
    }
    return structuredClone(record);
  }

  // Serialized read-modify-write per case so concurrent updates (AI pipeline vs doctor) don't clobber each other.
  async update(id, mutate) {
    const previous = this.locks.get(id) || Promise.resolve();
    const run = previous.then(async () => {
      const current = this.#parse(this.q.getCase.get(id));
      if (!current) throw new Error('case not found');
      const result = (await mutate(current)) ?? current;
      result.updatedAt = new Date().toISOString();
      this.q.updateCase.run(result.patient?.id || null, result.receivedAt, result.status, result.triage?.level || null, JSON.stringify(result), id);
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
    this.q.deleteCase.run(id);
    await fs.rm(path.join(this.mediaDir, id), { recursive: true, force: true });
  }

  // ---- Patients --------------------------------------------------------------------------------

  async getPatient(id) {
    return this.#parse(this.q.getPatient.get(id));
  }

  async findPatientByKey(key) {
    return key ? this.#parse(this.q.patientByKey.get(key)) : null;
  }

  async putPatient(p) {
    this.q.putPatient.run(p.id, p.workerId, p.matchKey || null, p.name || '', p.lastSeen || p.firstSeen, JSON.stringify(p));
    return p;
  }

  async listPatientsByWorker(workerId) {
    return this.q.workerPatients.all(workerId).map((r) => this.#parse(r));
  }

  // ---- People ----------------------------------------------------------------------------------

  async getAsha(id) {
    return this.#parse(this.q.getAsha.get(String(id)));
  }

  async listAshas() {
    return this.q.allAshas.all().map((r) => this.#parse(r));
  }

  async getDoctor(id) {
    return this.#parse(this.q.getDoctor.get(String(id)));
  }

  // ---- Audit -----------------------------------------------------------------------------------

  writeAudit(entry) {
    this.q.audit.run(entry.at, entry.type || null, entry.caseId || null, JSON.stringify(entry));
  }

  readAudit() {
    return this.q.auditAll.all().map((r) => this.#parse(r));
  }

  close() {
    this.db?.close();
  }
}
