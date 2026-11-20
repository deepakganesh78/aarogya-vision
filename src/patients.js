import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ageToDays } from '../public/shared/dangerSigns.js';

// Demo ASHA workers and doctors (profile, village, PHC, assigned doctor). Same ids as the access codes.
const PEOPLE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'people.json');
export const PEOPLE = JSON.parse(fs.readFileSync(PEOPLE_FILE, 'utf8'));

export function findAsha(id) {
  return PEOPLE.ashas.find((a) => a.id === id) || null;
}

export function findDoctor(id) {
  return PEOPLE.doctors.find((d) => d.id === id) || null;
}

const PATIENT_ID = /^PT-[0-9A-F]{8}$/;

export function isPatientId(id) {
  return typeof id === 'string' && PATIENT_ID.test(id);
}

export function newPatientId() {
  return `PT-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/** The same patient for the same worker: name (case/space-insensitive) + sex. */
export function matchKey(workerId, name, sex) {
  const n = String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return n ? `${workerId}|${n}|${sex || ''}` : null;
}

/** Snapshot stored on each case: who the patient was at this visit. */
export function patientSnapshot(p, { returning, visit }) {
  return {
    id: p.id,
    name: p.name,
    ageValue: p.ageValue ?? null,
    ageUnit: p.ageUnit ?? null,
    ageDays: p.ageDays ?? null,
    sex: p.sex || 'unknown',
    pregnant: p.pregnant === true,
    pregnancyMonths: p.pregnant ? (p.pregnancyMonths ?? null) : null,
    returning,
    visit
  };
}

/**
 * Find this worker's patient (by id, else by name + sex) or register a new one, and count the visit.
 * `store` provides getPatient, findPatientByKey and putPatient.
 * @param {{id?: string, name: string, ageValue?: number|null, ageUnit?: string, sex?: string, pregnant?: boolean, pregnancyMonths?: number|null}} input
 */
export async function registerVisit(store, worker, input, now = new Date().toISOString()) {
  let existing = isPatientId(input.id) ? await store.getPatient(input.id) : null;
  if (existing && existing.workerId !== worker.id) existing = null;
  const key = matchKey(worker.id, input.name, input.sex);
  if (!existing && key) existing = await store.findPatientByKey(key);

  const female = input.sex === 'female';
  const details = {
    name: String(input.name || '').trim(),
    sex: input.sex || 'unknown',
    ageValue: input.ageValue ?? null,
    ageUnit: input.ageUnit || null,
    ageDays: ageToDays(input.ageValue, input.ageUnit),
    pregnant: female && input.pregnant === true,
    pregnancyMonths: female && input.pregnant === true ? (input.pregnancyMonths ?? null) : null
  };
  const patient = existing
    ? { ...existing, ...details, matchKey: key, lastSeen: now, visits: (existing.visits || 0) + 1 }
    : {
        id: newPatientId(),
        workerId: worker.id,
        matchKey: key,
        village: worker.village || null,
        ...details,
        firstSeen: now,
        lastSeen: now,
        visits: 1
      };
  await store.putPatient(patient);
  return { patient, snapshot: patientSnapshot(patient, { returning: Boolean(existing), visit: patient.visits }) };
}

/** What the worker's phone needs to list and pick a patient. */
export function patientListItem(p) {
  return {
    id: p.id,
    name: p.name,
    sex: p.sex,
    ageValue: p.ageValue,
    ageUnit: p.ageUnit,
    ageDays: p.ageDays,
    pregnant: Boolean(p.pregnant),
    pregnancyMonths: p.pregnancyMonths ?? null,
    village: p.village || null,
    visits: p.visits || 0,
    lastSeen: p.lastSeen,
    lastLevel: p.lastLevel || null
  };
}
