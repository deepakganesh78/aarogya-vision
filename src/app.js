import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { levelRank, triageAssessment } from '../public/shared/triage.js';
import { applyAutofill } from './autofill.js';
import { buildFhirBundle } from './fhir.js';
import { patientListItem, registerVisit } from './patients.js';
import { CaseSubmission, DecisionInput, identifyMedia } from './validation.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const OPEN_STATUSES = new Set(['received', 'processing', 'awaiting_review']);

export const PROTOTYPE_NOTICE =
  'Prototype for demonstration with synthetic or role-play cases only. Not for clinical use. AI output is a documentation aid; the doctor makes every clinical decision.';

function createLoginLimiter({ max = 10, windowMs = 5 * 60 * 1000 } = {}) {
  const attempts = new Map();
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const entry = attempts.get(key);
    if (!entry || now - entry.start > windowMs) {
      attempts.set(key, { start: now, count: 1 });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) return res.status(429).json({ error: 'too_many_attempts' });
    next();
  };
}

function workerView(record) {
  return {
    id: record.id,
    capturedAt: record.capturedAt,
    receivedAt: record.receivedAt,
    status: record.status,
    language: record.language,
    patient: record.patient,
    vitals: { temperatureC: record.assessment?.temperatureC ?? null, breathsPerMin: record.assessment?.breathsPerMin ?? null },
    autofill: record.autofill || {},
    aiStatus: record.ai?.status || 'pending',
    workerSteps: record.workerSteps || null,
    followUpQuestions: (record.ai?.output?.followUpQuestions || []).map((q) => q.workerLanguage).filter(Boolean),
    triage: { level: record.triage.level, reasons: record.triage.reasons, incomplete: record.triage.incomplete, signs: record.triage.signs },
    decision: record.decision
      ? {
          outcome: record.decision.outcome,
          instructions: record.decision.instructions,
          translated: record.decision.translated || null,
          followUpDate: record.decision.followUpDate || null,
          at: record.decision.at,
          by: { name: record.decision.by.name }
        }
      : null
  };
}

function doctorListItem(record) {
  return {
    id: record.id,
    capturedAt: record.capturedAt,
    receivedAt: record.receivedAt,
    status: record.status,
    worker: record.worker,
    patient: record.patient,
    language: record.language,
    triage: { level: record.triage.level, reasons: record.triage.reasons },
    aiStatus: record.ai?.status || 'pending',
    hasPhoto: Boolean(record.media?.photo),
    hasAudio: Boolean(record.media?.audio),
    decisionOutcome: record.decision?.outcome || null,
    decidedAt: record.decision?.at || null
  };
}

function sortForQueue(records) {
  return records.sort((a, b) => {
    const open = Number(OPEN_STATUSES.has(b.status)) - Number(OPEN_STATUSES.has(a.status));
    if (open !== 0) return open;
    const level = levelRank(b.triage.level) - levelRank(a.triage.level);
    if (level !== 0) return level;
    return OPEN_STATUSES.has(a.status) ? a.receivedAt.localeCompare(b.receivedAt) : b.receivedAt.localeCompare(a.receivedAt);
  });
}

/**
 * @param {{config: object, store: object, audit: object, processor: object, provider: object|null, auth: object, guidelines: object}} deps
 */
export function createApp({ config, store, audit, processor, provider, auth, guidelines, analytics, events }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          styleSrcElem: ["'self'"],
          // Material Web (Lit) sets some component styles via style attributes on first render.
          // Only attributes are allowed inline; <style> elements, scripts and script attributes stay blocked.
          styleSrcAttr: ["'unsafe-inline'"],
          imgSrc: ["'self'", 'blob:', 'data:'],
          mediaSrc: ["'self'", 'blob:'],
          connectSrc: ["'self'"],
          workerSrc: ["'self'"],
          manifestSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.isProd ? [] : null
        }
      },
      crossOriginEmbedderPolicy: false
    })
  );
  app.use((req, res, next) => {
    res.set('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
    next();
  });

  const api = express.Router();
  api.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  api.use(express.json({ limit: '32kb' }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: Math.max(config.maxPhotoBytes, config.maxAudioBytes), files: 2, fields: 1, fieldSize: 64 * 1024 }
  }).fields([
    { name: 'photo', maxCount: 1 },
    { name: 'audio', maxCount: 1 }
  ]);

  const requireWorker = auth.requireRole('worker');
  const requireDoctor = auth.requireRole('doctor');

  api.get('/health', (req, res) => res.json({ ok: true }));

  api.get('/config', (req, res) => {
    res.json({
      notice: PROTOTYPE_NOTICE,
      ai: { provider: config.ai.provider, model: config.ai.provider === 'gemini' ? String(config.ai.model).split(',')[0].trim() : null },
      usingDemoCodes: config.usingDemoCodes,
      // Live text while the worker speaks (Sarvam, local testing only).
      liveSpeech: config.speech?.provider === 'sarvam' ? { provider: 'sarvam', model: config.speech.model, localOnly: true } : null,
      guidelineNotice: guidelines.notice
    });
  });

  api.post('/login', createLoginLimiter(), (req, res) => {
    const user = auth.findUserByCode(req.body?.code);
    if (!user) {
      audit.log({ type: 'auth.failed', ip: req.ip });
      return res.status(401).json({ error: 'invalid_code' });
    }
    audit.log({ type: 'auth.login', actor: user.id, role: user.role });
    res.json({ token: auth.issueToken(user), user });
  });

  api.get('/me', auth.requireRole(null), (req, res) => res.json({ user: req.user }));

  // Profile card: the ASHA's village, block, PHC and assigned doctor (or the doctor's facility).
  api.get('/profile', auth.requireRole(null), async (req, res) => {
    if (req.user.role === 'worker') {
      const asha = (await store.getAsha?.(req.user.id)) || null;
      const doctor = asha?.doctorId ? (await store.getDoctor?.(asha.doctorId)) || null : null;
      return res.json({ user: req.user, asha, doctor });
    }
    res.json({ user: req.user, doctor: (await store.getDoctor?.(req.user.id)) || null });
  });

  // ---- Worker ---------------------------------------------------------------------------------

  api.post('/cases', requireWorker, upload, async (req, res) => {
    let parsedJson;
    try {
      parsedJson = JSON.parse(req.body?.case || '');
    } catch {
      return res.status(400).json({ error: 'invalid_case_json' });
    }
    const parsed = CaseSubmission.safeParse(parsedJson);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_case', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    const submission = parsed.data;

    const existing = await store.get(submission.id);
    if (existing) {
      if (existing.worker.id !== req.user.id) return res.status(409).json({ error: 'id_conflict' });
      return res.status(200).json({ duplicate: true, case: workerView(existing) });
    }

    const media = {};
    for (const kind of ['photo', 'audio']) {
      const file = req.files?.[kind]?.[0];
      if (!file) continue;
      const limit = kind === 'photo' ? config.maxPhotoBytes : config.maxAudioBytes;
      if (file.size > limit) return res.status(413).json({ error: `${kind}_too_large` });
      const type = identifyMedia(kind, file.mimetype, file.buffer);
      if (!type) return res.status(400).json({ error: `${kind}_unsupported_type` });
      media[kind] = { mimeType: type.mimeType, ext: type.ext, size: file.size, buffer: file.buffer };
    }

    const now = new Date().toISOString();
    if (!media.photo && !media.audio && !submission.assessment?.notes?.trim()) return res.status(400).json({ error: 'empty_case' });
    // Patient register: find this worker's patient (by id, or name + sex) or add a new one, and count the visit.
    const asha = (await store.getAsha?.(req.user.id)) || {};
    let patientIn = submission.patient || {};
    if (patientIn.name && store.putPatient) {
      const { snapshot } = await registerVisit(store, { id: req.user.id, village: asha.village }, patientIn, submission.capturedAt);
      patientIn = snapshot;
    }
    const submitted = { patient: patientIn, assessment: submission.assessment || {} };
    const { patient, assessment } = applyAutofill(submitted, null);
    const record = {
      id: submission.id,
      capturedAt: submission.capturedAt,
      receivedAt: now,
      updatedAt: now,
      worker: { id: req.user.id, name: req.user.name, ...(asha.village ? { village: asha.village } : {}) },
      language: submission.language,
      consent: submission.consent,
      submitted,
      patient,
      assessment,
      autofill: {},
      audioDurationSec: submission.audioDurationSec ?? null,
      media: { photo: null, audio: null },
      status: 'received',
      ai: { status: 'pending' },
      triage: triageAssessment({ patient, assessment }),
      guidelines: [],
      decision: null,
      history: [{ at: now, event: 'received', by: req.user.id }]
    };

    for (const [kind, m] of Object.entries(media)) {
      const file = await store.saveMedia(record.id, kind, m.buffer, m.ext, m.mimeType);
      record.media[kind] = { file, mimeType: m.mimeType, size: m.size };
    }

    try {
      await store.create(record);
    } catch (err) {
      if (err.code === 'ALREADY_EXISTS') {
        const raced = await store.get(record.id);
        if (raced && raced.worker.id === req.user.id) return res.status(200).json({ duplicate: true, case: workerView(raced) });
        return res.status(409).json({ error: 'id_conflict' });
      }
      throw err;
    }
    audit.log({ type: 'case.created', actor: req.user.id, caseId: record.id, patientId: record.patient.id || null, level: record.triage.level, hasPhoto: Boolean(media.photo), hasAudio: Boolean(media.audio) });
    events?.publish({ type: 'case.created', caseId: record.id, level: record.triage.level, workerId: req.user.id });
    processor.enqueue(record.id);
    res.status(201).json({ case: workerView(record) });
  });

  api.get('/worker/cases', requireWorker, async (req, res) => {
    const records = await store.listByWorker(req.user.id);
    records.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    res.json({ cases: records.map(workerView) });
  });

  api.get('/worker/patients', requireWorker, async (req, res) => {
    const patients = store.listPatientsByWorker ? await store.listPatientsByWorker(req.user.id) : [];
    res.json({ patients: patients.map(patientListItem) });
  });

  api.get('/worker/cases/:id', requireWorker, async (req, res) => {
    const record = await store.get(req.params.id).catch(() => null);
    if (!record || record.worker.id !== req.user.id) return res.status(404).json({ error: 'not_found' });
    res.json({ case: workerView(record) });
  });

  // ---- Doctor ---------------------------------------------------------------------------------

  api.get('/doctor/cases', requireDoctor, async (req, res) => {
    const view = ['open', 'responded', 'all'].includes(req.query.view) ? req.query.view : 'open';
    let records = await store.listAll();
    if (view === 'open') records = records.filter((r) => OPEN_STATUSES.has(r.status));
    if (view === 'responded') records = records.filter((r) => r.status === 'responded');
    res.json({ cases: sortForQueue(records).map(doctorListItem) });
  });

  // KPIs for the dashboard header.
  api.get('/doctor/stats', requireDoctor, async (req, res) => {
    const all = await store.listAll();
    const now = Date.now();
    const open = all.filter((r) => OPEN_STATUSES.has(r.status));
    const oldest = open.reduce((acc, r) => (!acc || r.receivedAt < acc.receivedAt ? r : acc), null);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const repliedToday = all.filter((r) => r.decision && Date.parse(r.decision.at) >= today.getTime());
    const replyMins = repliedToday.map((r) => (Date.parse(r.decision.at) - Date.parse(r.receivedAt)) / 60000).filter((m) => m >= 0).sort((a, b) => a - b);
    res.json({
      waiting: open.length,
      urgentWaiting: open.filter((r) => r.triage.level === 'URGENT').length,
      oldestWaiting: oldest ? { id: oldest.id, name: oldest.patient?.name || null, minutes: Math.round((now - Date.parse(oldest.receivedAt)) / 60000) } : null,
      repliedToday: repliedToday.length,
      medianReplyMinutes: replyMins.length ? Math.round(replyMins[Math.floor(replyMins.length / 2)]) : null,
      receivedToday: all.filter((r) => Date.parse(r.receivedAt) >= today.getTime()).length
    });
  });

  // Live updates: server-sent events. EventSource cannot send headers, so the token comes as a query parameter.
  api.get('/doctor/events', (req, res) => {
    const user = auth.verifyToken(String(req.query.token || ''));
    if (!user || user.role !== 'doctor') return res.status(401).json({ error: 'unauthorized' });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    res.write('retry: 5000\n\n');
    const send = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    const unsubscribe = events ? events.subscribe(send) : () => {};
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  // Earlier visits of the same patient.
  api.get('/doctor/patients/:id/cases', requireDoctor, async (req, res) => {
    const patient = store.getPatient ? await store.getPatient(req.params.id) : null;
    if (!patient) return res.status(404).json({ error: 'not_found' });
    const records = store.listByPatient ? await store.listByPatient(patient.id) : [];
    res.json({
      patient: {
        id: patient.id,
        name: patient.name,
        sex: patient.sex,
        ageValue: patient.ageValue,
        ageUnit: patient.ageUnit,
        pregnant: patient.pregnant,
        pregnancyMonths: patient.pregnancyMonths,
        village: patient.village,
        visits: patient.visits,
        firstSeen: patient.firstSeen
      },
      history: records.map((r) => ({
        id: r.id,
        receivedAt: r.receivedAt,
        level: r.triage.level,
        status: r.status,
        signs: r.triage.reasons.filter((x) => x.signId).map((x) => x.signId),
        decision: r.decision ? { outcome: r.decision.outcome, instructions: r.decision.instructions, at: r.decision.at, by: r.decision.by.name } : null
      }))
    });
  });

  api.get('/doctor/cases/:id/fhir', requireDoctor, async (req, res) => {
    const record = await store.get(req.params.id).catch(() => null);
    if (!record) return res.status(404).json({ error: 'not_found' });
    audit.log({ type: 'case.fhir_exported', actor: req.user.id, caseId: record.id });
    res.set('Content-Disposition', `attachment; filename="case-${record.id}.fhir.json"`);
    res.type('application/fhir+json').send(JSON.stringify(buildFhirBundle(record, { asha: await store.getAsha?.(record.worker.id) }), null, 2));
  });

  api.get('/doctor/cases/:id', requireDoctor, async (req, res) => {
    const record = await store.get(req.params.id).catch(() => null);
    if (!record) return res.status(404).json({ error: 'not_found' });
    audit.log({ type: 'case.viewed', actor: req.user.id, caseId: record.id });
    const asha = (await store.getAsha?.(record.worker.id)) || null;
    res.json({ case: record, asha, guidelineNotice: guidelines.notice });
  });

  api.get('/doctor/cases/:id/media/:kind', requireDoctor, async (req, res) => {
    const { kind } = req.params;
    if (kind !== 'photo' && kind !== 'audio') return res.status(404).json({ error: 'not_found' });
    const record = await store.get(req.params.id).catch(() => null);
    const meta = record?.media?.[kind];
    if (!meta) return res.status(404).json({ error: 'not_found' });
    const buffer = await store.readMedia(record.id, meta.file);
    audit.log({ type: 'media.viewed', actor: req.user.id, caseId: record.id, kind });
    res.set('Content-Type', meta.mimeType);
    res.set('Content-Disposition', 'inline');
    res.send(buffer);
  });

  api.post('/doctor/cases/:id/decision', requireDoctor, async (req, res) => {
    const parsed = DecisionInput.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_decision', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    const existing = await store.get(req.params.id).catch(() => null);
    if (!existing) return res.status(404).json({ error: 'not_found' });

    const decision = {
      outcome: parsed.data.outcome,
      instructions: parsed.data.instructions,
      followUpDate: parsed.data.followUpDate ?? null,
      by: { id: req.user.id, name: req.user.name },
      at: new Date().toISOString(),
      translated: null
    };

    if (existing.language !== 'en' && provider?.translate) {
      try {
        const text = await provider.translate(decision.instructions, existing.language);
        decision.translated = { lang: existing.language, text, machine: true, provider: provider.name, model: provider.model };
      } catch (err) {
        decision.translationError = String(err.message || err).slice(0, 200);
      }
    }

    const updated = await store.update(existing.id, (r) => {
      r.decision = decision;
      r.status = 'responded';
      r.history.push({ at: decision.at, event: `decision_${decision.outcome}`, by: req.user.id });
    });
    audit.log({ type: 'decision.recorded', actor: req.user.id, caseId: existing.id, outcome: decision.outcome, translated: Boolean(decision.translated) });
    analytics?.decided(updated);
    events?.publish({ type: 'case.decided', caseId: existing.id, level: updated.triage.level, workerId: updated.worker.id });
    res.json({ case: updated });
  });

  api.post('/doctor/cases/:id/reprocess', requireDoctor, async (req, res) => {
    const existing = await store.get(req.params.id).catch(() => null);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    await store.update(existing.id, (r) => {
      r.ai = { status: 'pending' };
      r.history.push({ at: new Date().toISOString(), event: 'reprocess_requested', by: req.user.id });
    });
    audit.log({ type: 'case.reprocess', actor: req.user.id, caseId: existing.id });
    processor.enqueue(existing.id);
    res.status(202).json({ ok: true });
  });

  api.use((req, res) => res.status(404).json({ error: 'not_found' }));

  app.use('/api', api);

  app.get('/doctor', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'doctor.html')));
  app.get('/offline-test', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'offline-test.html')));
  app.use(
    express.static(PUBLIC_DIR, {
      setHeaders(res) {
        res.set('Cache-Control', 'no-cache');
      }
    })
  );

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: err.code.toLowerCase() });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
