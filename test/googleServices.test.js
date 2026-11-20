import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createEvents } from '../src/events.js';
import { buildFhirBundle } from '../src/fhir.js';
import { createHealthcareFhir, toUpsertBundle } from '../src/healthcare.js';
import { createRagRetriever, ragQuery } from '../src/rag.js';
import { authed, buildCase, startTestServer, submitCase } from './helpers.js';

const fakeAuth = { getClient: async () => ({ getRequestHeaders: async () => new Headers({ authorization: 'Bearer t' }) }) };

describe('Cloud Healthcare API FHIR store', () => {
  const record = {
    id: 'c1',
    worker: { id: 'asha-001', name: 'ASHA' },
    patient: { name: 'Baby', sex: 'female' },
    consent: { given: true, at: '2026-11-20T00:00:00Z' },
    triage: { level: 'URGENT', reasons: [], signs: { fever: { state: 'yes', source: 'checklist' } } }
  };

  it('turns the bundle into idempotent PUTs with resolved references', () => {
    const upsert = toUpsertBundle(buildFhirBundle(record));
    const patient = upsert.entry.find((e) => e.resource.resourceType === 'Patient');
    assert.deepEqual(patient.request, { method: 'PUT', url: 'Patient/c1-patient' });
    assert.equal(patient.resource.id, 'c1-patient');
    const encounter = upsert.entry.find((e) => e.resource.resourceType === 'Encounter');
    assert.equal(encounter.resource.subject.reference, 'Patient/c1-patient');
    assert.ok(!JSON.stringify(upsert).includes('urn:uuid:'));
  });

  it('posts the transaction to the FHIR store', async () => {
    const calls = [];
    const fhir = await createHealthcareFhir({
      project: 'p', location: 'asia-south1', dataset: 'd', fhirStore: 's', auth: fakeAuth,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response('{"resourceType":"Bundle"}', { status: 200 });
      }
    });
    await fhir.upsert(buildFhirBundle(record));
    assert.equal(calls[0].url, 'https://healthcare.googleapis.com/v1/projects/p/locations/asia-south1/datasets/d/fhirStores/s/fhir');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer t');
    assert.match(calls[0].init.headers['Content-Type'], /application\/fhir\+json/);
  });
});

describe('Pub/Sub events', () => {
  function fakePubSub() {
    const published = [];
    let handler;
    const subscription = { on: (ev, fn) => ev === 'message' && (handler = fn), close: async () => {}, delete: async () => {} };
    const topic = { publishMessage: async (m) => published.push(m), createSubscription: async () => [subscription] };
    return { published, pubsub: { topic: () => topic }, deliver: (m) => handler(m) };
  }

  it('publishes events with an urgent attribute and fans in other instances', async () => {
    const fake = fakePubSub();
    const events = createEvents({ pubsub: fake.pubsub, topicName: 't' });
    await events.start();
    const got = [];
    events.subscribe((e) => got.push(e));
    events.publish({ type: 'case.triaged', caseId: 'c1', level: 'URGENT' });
    assert.equal(fake.published[0].attributes.urgent, 'true');
    assert.equal(got.length, 1);

    const ack = () => {};
    fake.deliver({ ack, attributes: fake.published[0].attributes, data: Buffer.from(JSON.stringify(fake.published[0].json)) });
    assert.equal(got.length, 1, 'own messages are not delivered twice');
    fake.deliver({ ack, attributes: { origin: 'other' }, data: Buffer.from(JSON.stringify({ type: 'case.created', caseId: 'c2' })) });
    assert.equal(got[1].caseId, 'c2');
  });
});

describe('Vertex AI RAG Engine passages', () => {
  it('queries with sign labels only and maps contexts', async () => {
    let body;
    const rag = await createRagRetriever({
      corpus: 'projects/p/locations/asia-south1/ragCorpora/1',
      auth: fakeAuth,
      fetchImpl: async (url, init) => {
        body = JSON.parse(init.body);
        assert.equal(url, 'https://asia-south1-aiplatform.googleapis.com/v1/projects/p/locations/asia-south1:retrieveContexts');
        return new Response(JSON.stringify({ contexts: { contexts: [{ text: 'Refer urgently.', sourceUri: 'gs://b/guidelines/hbnc.pdf', score: 0.2 }] } }));
      }
    });
    const out = await rag.retrieve(ragQuery({ signLabels: ['Convulsions (fits)'], level: 'URGENT', ageGroup: 'young infant' }));
    assert.match(body.query.text, /Convulsions/);
    assert.deepEqual(out[0], { text: 'Refer urgently.', source: 'hbnc.pdf', sourceUri: 'gs://b/guidelines/hbnc.pdf', score: 0.2 });
  });

  it('adds passages to the case but never changes urgency, and survives a RAG failure', async () => {
    const queries = [];
    let fail = false;
    const rag = {
      corpus: 'c',
      retrieve: async (q) => {
        queries.push(q);
        if (fail) throw new Error('down');
        return [{ text: 'Passage', source: 'x.pdf' }];
      }
    };
    const ctx = await startTestServer({ overrides: { rag } });
    try {
      const token = await ctx.login('asha-demo');
      const doctor = await ctx.login('doctor-demo');
      for (const failing of [false, true]) {
        fail = failing;
        const record = buildCase();
        assert.equal((await submitCase(ctx.baseUrl, token, record)).status, 201);
        await ctx.services.processor.drain();
        const { case: c } = await (await fetch(`${ctx.baseUrl}/api/doctor/cases/${record.id}`, { headers: authed(doctor) })).json();
        assert.equal(c.triage.level, 'URGENT');
        assert.ok(c.guidelines.length > 0, 'curated citations stay');
        assert.equal(Boolean(c.guidelinePassages), !failing);
      }
      assert.ok(!queries.some((q) => q.includes('Baby feels hot')), 'free-text notes are not sent to RAG');
    } finally {
      await ctx.close();
    }
  });
});
