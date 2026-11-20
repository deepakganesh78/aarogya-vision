import { z } from 'zod';
import { SIGN_IDS } from '../public/shared/dangerSigns.js';

const SignState = z.enum(['yes', 'no', 'unknown']);

const signsShape = Object.fromEntries(SIGN_IDS.map((id) => [id, SignState.optional()]));

export const CaseSubmission = z
  .object({
    id: z.uuid(),
    capturedAt: z.iso.datetime(),
    language: z.enum(['en', 'hi', 'ta']),
    consent: z
      .object({
        given: z.literal(true),
        givenBy: z.enum(['family', 'mother', 'father', 'other_caregiver']),
        method: z.literal('verbal'),
        at: z.iso.datetime()
      })
      .strict(),
    // Patient details are required: name, age (value and unit) and sex. Pregnancy is asked only for women.
    patient: z
      .object({
        // Existing patient picked from the worker's list. A new patient has no id yet; the server assigns one.
        id: z.string().regex(/^PT-[0-9A-F]{8}$/).optional(),
        name: z.string().trim().min(1).max(80),
        ageValue: z.number().min(0).max(120),
        ageUnit: z.enum(['days', 'weeks', 'months', 'years']),
        ageDays: z.number().int().min(0).max(43800).nullable().optional(),
        sex: z.enum(['female', 'male']),
        pregnant: z.boolean().optional(),
        pregnancyMonths: z.number().int().min(1).max(10).nullable().optional(),
        reference: z.string().trim().max(40).optional()
      })
      .strict()
      .refine((p) => !p.pregnant || p.sex === 'female', { message: 'only a female patient can be pregnant', path: ['pregnant'] }),
    assessment: z
      .object({
        signs: z.object(signsShape).strict().optional(),
        temperatureC: z.number().min(25).max(45).nullable().optional(),
        breathsPerMin: z.number().int().min(0).max(200).nullable().optional(),
        notes: z.string().max(1000).optional(),
        workerFlag: z.boolean().optional(),
        // Live text made while the worker spoke (Gemini Live). followUp is accepted only from older app
        // versions that asked spoken follow-up questions; the current app never sends it.
        liveTranscript: z
          .object({
            original: z.string().max(4000),
            english: z.string().max(4000),
            language: z.string().max(20).nullable().optional(),
            provider: z.literal('gemini-live'),
            model: z.string().max(40).nullable().optional(),
            followUp: z.string().max(1000).nullable().optional()
          })
          .strict()
          .optional()
      })
      .strict()
      .optional(),
    audioDurationSec: z.number().min(0).max(300).nullable().optional()
  })
  .strict();

// The doctor's decision. Medicines are chosen and dosed by the doctor (never suggested by AI); the
// dashboard also writes them into the instructions so the ASHA receives them in her language.
const DecisionMedicine = z
  .object({
    name: z.string().trim().min(1).max(80),
    dose: z.string().trim().max(60).optional(),
    how: z.string().trim().max(80).optional(),
    days: z.number().int().min(1).max(90).nullable().optional()
  })
  .strict();

export const DecisionInput = z
  .object({
    outcome: z.enum(['refer_now', 'home_care_follow_up', 'need_more_info', 'no_action']),
    instructions: z.string().trim().min(1).max(1500),
    followUpDate: z.iso.date().nullable().optional(),
    medicines: z.array(DecisionMedicine).max(8).optional(),
    referTo: z.string().trim().min(1).max(120).nullable().optional(),
    // The doctor's own assessment (provisional diagnosis), kept in the record; not sent to the ASHA.
    assessment: z.string().trim().max(1000).optional()
  })
  .strict()
  .refine((d) => !d.referTo || d.outcome === 'refer_now', { message: 'referTo needs outcome refer_now', path: ['referTo'] });

// The doctor sends the prescribed medicines: one bike collects from each stop, then goes to the patient.
// Stop and courier names come from the dashboard's (simulated) stock map.
export const DispatchInput = z
  .object({
    stops: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(60),
            name: z.string().trim().min(1).max(80),
            kind: z.enum(['phc', 'hwc', 'shop']),
            items: z.array(z.string().trim().min(1).max(80)).min(1).max(12),
            km: z.number().min(0).max(500).nullable().optional()
          })
          .strict()
      )
      .min(1)
      .max(6),
    courier: z.object({ id: z.string().trim().min(1).max(20), name: z.string().trim().min(1).max(60) }).strict(),
    distanceKm: z.number().min(0).max(500),
    etaMin: z.number().int().min(0).max(600),
    missing: z.array(z.string().trim().min(1).max(80)).max(12).optional()
  })
  .strict();

const PHOTO_TYPES = {
  'image/jpeg': { ext: 'jpg', check: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', check: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': { ext: 'webp', check: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' }
};

const AUDIO_TYPES = {
  'audio/webm': { ext: 'webm', check: (b) => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) },
  'audio/ogg': { ext: 'ogg', check: (b) => b.toString('ascii', 0, 4) === 'OggS' },
  'audio/mp4': { ext: 'm4a', check: (b) => b.toString('ascii', 4, 8) === 'ftyp' },
  'audio/wav': { ext: 'wav', check: (b) => b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE' },
  'audio/mpeg': { ext: 'mp3', check: (b) => b.toString('ascii', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) }
};

const AUDIO_ALIASES = { 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/x-m4a': 'audio/mp4', 'audio/mp3': 'audio/mpeg' };

function baseType(mime) {
  return String(mime || '').split(';')[0].trim().toLowerCase();
}

/** Returns {mimeType, ext} when the declared type is allowed and the bytes match it, otherwise null. */
export function identifyMedia(kind, declaredMime, buffer) {
  if (!buffer || buffer.length < 12) return null;
  let mime = baseType(declaredMime);
  const table = kind === 'photo' ? PHOTO_TYPES : AUDIO_TYPES;
  if (kind === 'audio') mime = AUDIO_ALIASES[mime] || mime;
  const entry = table[mime];
  if (!entry || !entry.check(buffer)) return null;
  return { mimeType: mime, ext: entry.ext };
}
