import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { GcpStore } from '../src/store/gcpStore.js';
import { authed, buildCase, startTestServer, submitCase } from './helpers.js';

// In-memory stand-ins for the subset of @google-cloud/firestore and @google-cloud/storage that GcpStore uses.
function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => o?.[k], obj);
}

function fakeFirestore() {
  // One map per collection (cases, patients, ...); `docs` is the cases collection the tests inspect.
  const maps = new Map();
  const mapFor = (name) => {
    if (!maps.has(name)) maps.set(name, new Map());
    return maps.get(name);
  };
  const docs = mapFor('cases');
  const snap = (data) => ({ exists: data !== undefined, data: () => structuredClone(data) });

  function query(store, filters = [], order = null, max = Infinity) {
    return {
      where: (field, op, value) => query(store, [...filters, { field, op, value }], order, max),
      orderBy: (field, dir = 'asc') => query(store, filters, { field, dir }, max),
      limit: (n) => query(store, filters, order, n),
      async get() {
        let rows = [...store.values()].filter((d) => filters.every((f) => f.op === '==' && getPath(d, f.field) === f.value));
        if (order) rows.sort((a, b) => (order.dir === 'desc' ? -1 : 1) * String(getPath(a, order.field)).localeCompare(String(getPath(b, order.field))));
        return { docs: rows.slice(0, max).map((d) => ({ data: () => structuredClone(d) })) };
      }
    };
  }

  const collections = new Map();
  const collectionFor = (name) => {
    if (collections.has(name)) return collections.get(name);
    const store = mapFor(name);
    const collection = {
      ...query(store),
      doc: (id) => ({
        id,
        store,
        get: async () => snap(store.get(id)),
        create: async (data) => {
          if (store.has(id)) throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
          store.set(id, structuredClone(data));
        },
        set: async (data) => store.set(id, structuredClone(data)),
        delete: async () => store.delete(id)
      })
    };
    collections.set(name, collection);
    return collection;
  };

  return {
    docs,
    collection: (name = 'cases') => collectionFor(name),
    async runTransaction(fn) {
      const writes = [];
      const result = await fn({ get: (ref) => ref.get(), set: (ref, data) => writes.push([ref, data]) });
      for (const [ref, data] of writes) ref.store.set(ref.id, structuredClone(data));
      return result;
    }
  };
}

function fakeStorage() {
  const objects = new Map();
  return {
    objects,
    bucket: () => ({
      file: (name) => ({
        save: async (buffer, opts) => objects.set(name, { buffer: Buffer.from(buffer), contentType: opts.contentType }),
        download: async () => [objects.get(name).buffer]
      }),
      deleteFiles: async ({ prefix }) => {
        for (const key of [...objects.keys()]) if (key.startsWith(prefix)) objects.delete(key);
      }
    })
  };
}

describe('GcpStore (Firestore + Cloud Storage)', () => {
  it('creates, rejects duplicates, updates transactionally, lists and deletes', async () => {
    const firestore = fakeFirestore();
    const storage = fakeStorage();
    const store = new GcpStore({ firestore, storage, bucketName: 'av-media' });
    const id = crypto.randomUUID();
    const record = { id, receivedAt: new Date().toISOString(), worker: { id: 'w1' }, history: [], media: {} };

    await store.create(record);
    await assert.rejects(store.create(record), (err) => err.code === 'ALREADY_EXISTS');

    const updated = await store.update(id, (r) => {
      r.status = 'awaiting_review';
    });
    assert.equal(updated.status, 'awaiting_review');
    assert.ok(updated.updatedAt);
    assert.equal((await store.get(id)).status, 'awaiting_review');

    assert.equal((await store.listByWorker('w1')).length, 1);
    assert.equal((await store.listByWorker('w2')).length, 0);

    const file = await store.saveMedia(id, 'photo', Buffer.from('img'), 'jpg', 'image/jpeg');
    assert.equal(storage.objects.get(`cases/${id}/photo.jpg`).contentType, 'image/jpeg');
    assert.deepEqual(await store.readMedia(id, file), Buffer.from('img'));
    await assert.rejects(store.readMedia(id, '../secrets.json'), /invalid media file/);

    await store.delete(id);
    assert.equal(await store.get(id), null);
    assert.equal(storage.objects.size, 0);
  });

  it('requires a media bucket', () => {
    assert.throws(() => new GcpStore({ firestore: fakeFirestore(), storage: fakeStorage(), bucketName: '' }), /MEDIA_BUCKET/);
  });

  it('runs the full intake → AI → decision flow on the GCP store', async () => {
    const store = new GcpStore({ firestore: fakeFirestore(), storage: fakeStorage(), bucketName: 'av-media' });
    const ctx = await startTestServer({ overrides: { store } });
    try {
      const worker = await ctx.login('asha-demo');
      const doctor = await ctx.login('doctor-demo');
      const record = buildCase();
      assert.equal((await submitCase(ctx.baseUrl, worker, record)).status, 201);
      await ctx.services.processor.drain();
      const detail = (await (await fetch(`${ctx.baseUrl}/api/doctor/cases/${record.id}`, { headers: authed(doctor) })).json()).case;
      assert.equal(detail.ai.status, 'done');
      assert.equal(detail.triage.level, 'URGENT');
      const photo = await fetch(`${ctx.baseUrl}/api/doctor/cases/${record.id}/media/photo`, { headers: authed(doctor) });
      assert.equal(photo.status, 200);
    } finally {
      await ctx.close();
    }
  });
});
