import crypto from 'node:crypto';
import { mergeAiFindings, triageAssessment } from '../public/shared/triage.js';
import { applyAutofill } from './autofill.js';
import { signLabel } from '../public/shared/dangerSigns.js';
import { buildFhirBundle, saveFhirBundle } from './fhir.js';
import { workerSteps } from './guidelines.js';
import { ragQuery } from './rag.js';
import { cleanAiOutput } from './safety.js';

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function safeError(err) {
  const message = String(err?.name === 'AbortError' ? 'AI request timed out' : err?.message || err);
  return message.slice(0, 300);
}

/**
 * The four pipeline stages map to the deck's reusable skills:
 *   1. read            - provider.analyze(): Gemini reads photo + voice + checklist together
 *   2. find guideline  - guidelines.retrieve(): cite curated MoHFW / WHO guidance (authoritative);
 *                        rag.retrieve(): supplementary passages from the guideline PDFs (Vertex AI RAG Engine)
 *   3. flag urgency    - mergeAiFindings(): deterministic rules; AI can only raise the level
 *   4. build record    - persist the case, and write it as FHIR R4 (Cloud Healthcare API in production)
 */
export function createProcessor({ store, provider, guidelines, rag, fhirStore, audit, analytics, events, dataDir, concurrency = 2, logger = console }) {
  const queue = [];
  const queued = new Set();
  let active = 0;
  let idleResolvers = [];

  function notifyIdle() {
    if (active === 0 && queue.length === 0) {
      for (const resolve of idleResolvers) resolve();
      idleResolvers = [];
    }
  }

  function pump() {
    while (active < concurrency && queue.length > 0) {
      const id = queue.shift();
      queued.delete(id);
      active += 1;
      processCase(id)
        .catch((err) => logger.error(`processing ${id} failed: ${safeError(err)}`))
        .finally(() => {
          active -= 1;
          pump();
          notifyIdle();
        });
    }
  }

  function enqueue(id) {
    if (!queued.has(id)) {
      queued.add(id);
      queue.push(id);
    }
    pump();
  }

  function drain() {
    if (active === 0 && queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => idleResolvers.push(resolve));
  }

  async function loadMedia(record, kind) {
    const meta = record.media?.[kind];
    if (!meta) return null;
    return { mimeType: meta.mimeType, buffer: await store.readMedia(record.id, meta.file) };
  }

  async function processCase(id) {
    const record = await store.get(id);
    if (!record) return;
    const hasMedia = Boolean(record.media?.photo || record.media?.audio);
    const startedAt = new Date().toISOString();
    // Always work from what the worker sent, so re-processing never treats earlier AI fills as worker input.
    const submitted = record.submitted || { patient: record.patient, assessment: record.assessment };
    const asSubmitted = { ...record, patient: { ageDays: null, sex: 'unknown', ...submitted.patient }, assessment: { ...submitted.assessment } };
    let ai;

    if (record.ai?.status === 'skipped') {
      ai = record.ai;
    } else if (!provider) {
      ai = { status: 'disabled', reason: 'No AI provider configured' };
    } else {
      await store.update(id, (r) => {
        r.ai = { status: 'processing', provider: provider.name, model: provider.model, startedAt };
        if (r.status === 'received') r.status = 'processing';
      });
      try {
        const [photo, audio] = await Promise.all([loadMedia(record, 'photo'), loadMedia(record, 'audio')]);
        const analysed = await provider.analyze({ caseRecord: asSubmitted, photo, audio });
        const raw = analysed.raw;
        // No-diagnosis filter on AI text the doctor sees (summary, photo notes, questions).
        const { output, removed } = cleanAiOutput(analysed.output);
        if (removed) audit.log({ type: 'ai.safety_filtered', caseId: id, removed });
        ai = {
          status: 'done',
          provider: provider.name,
          model: analysed.model || provider.model,
          promptVersion: provider.promptVersion,
          startedAt,
          completedAt: new Date().toISOString(),
          output,
          findings: output.findings
        };
        audit.log({ type: 'ai.output', caseId: id, provider: provider.name, model: provider.model, promptVersion: provider.promptVersion, outputSha256: sha256(raw) });
      } catch (err) {
        ai = { status: 'failed', provider: provider.name, model: provider.model, startedAt, completedAt: new Date().toISOString(), error: safeError(err) };
        audit.log({ type: 'ai.failed', caseId: id, provider: provider.name, model: provider.model, error: ai.error });
      }
    }

    const { patient, assessment, autofill } = applyAutofill(submitted, ai.status === 'done' ? ai.output : null);
    const triage = mergeAiFindings(triageAssessment({ patient, assessment, autofill }), ai, { hasMedia });
    const signIds = [...new Set(triage.reasons.filter((r) => r.signId).map((r) => r.signId))];
    const topSignIds = [...new Set(triage.reasons.filter((r) => r.signId && r.level === triage.level).map((r) => r.signId))];
    const text = [ai.output?.transcriptEnglish, assessment.notes].filter(Boolean).join(' ');
    const refs = guidelines.retrieve({ signIds, topSignIds, text, level: triage.level, context: triage.context });
    let passages = null;
    if (rag) {
      const ctx = triage.context || {};
      const ageGroup = ctx.pregnant ? 'pregnancy' : ctx.youngInfant ? 'young infant 0-59 days' : ctx.under5 ? 'child under 5' : null;
      try {
        passages = await rag.retrieve(ragQuery({ signLabels: signIds.map((s) => signLabel(s)), level: triage.level, ageGroup }));
        audit.log({ type: 'rag.retrieved', caseId: id, corpus: rag.corpus, count: passages.length });
      } catch (err) {
        logger.warn(`RAG retrieval for ${id} failed: ${safeError(err)}`);
      }
    }

    const updated = await store.update(id, (r) => {
      r.patient = patient;
      r.assessment = assessment;
      r.autofill = autofill;
      r.ai = ai;
      r.triage = triage;
      r.guidelines = refs;
      if (passages) r.guidelinePassages = passages;
      r.workerSteps = workerSteps(refs);
      if (r.status === 'received' || r.status === 'processing') r.status = 'awaiting_review';
      r.history.push({ at: new Date().toISOString(), event: ai.status === 'done' ? 'ai_summary_ready' : `ai_${ai.status}`, by: 'system' });
    });
    audit.log({ type: 'case.triaged', caseId: id, level: triage.level, rulesVersion: triage.rulesVersion, aiStatus: ai.status });
    if (updated.patient?.id && store.getPatient) {
      const p = await store.getPatient(updated.patient.id);
      if (p) await store.putPatient({ ...p, lastLevel: triage.level, lastCaseId: id });
    }
    try {
      const asha = await store.getAsha?.(updated.worker.id);
      if (fhirStore) {
        await fhirStore.upsert(buildFhirBundle(updated, { asha }));
        audit.log({ type: 'fhir.written', caseId: id });
      } else if (dataDir) {
        await saveFhirBundle(dataDir, updated, asha);
      }
    } catch (err) {
      logger.error(`FHIR export for ${id} failed: ${safeError(err)}`);
    }
    events?.publish({ type: 'case.triaged', caseId: id, level: triage.level, workerId: updated.worker.id });
    await analytics?.triaged(updated);
  }

  async function resumePending() {
    const all = await store.listAll();
    for (const r of all) {
      if (r.ai?.status === 'pending' || r.ai?.status === 'processing') enqueue(r.id);
    }
  }

  return { enqueue, drain, resumePending, processCase };
}
