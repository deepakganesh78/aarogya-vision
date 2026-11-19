const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertId(id) {
  if (!ID_PATTERN.test(id)) throw new Error('invalid case id');
}

// Production store: case records in Firestore, photos and voice notes in a private Cloud Storage bucket.
// Both encrypt data at rest by default; deploy them in asia-south1 to keep data in India.
export class GcpStore {
  /**
   * @param {{firestore: import('@google-cloud/firestore').Firestore, storage: import('@google-cloud/storage').Storage, bucketName: string, collection?: string}} options
   */
  constructor({ firestore, storage, bucketName, collection = 'cases' }) {
    if (!bucketName) throw new Error('MEDIA_BUCKET is required for STORE=gcp');
    this.firestore = firestore;
    this.collection = firestore.collection(collection);
    this.bucket = storage.bucket(bucketName);
  }

  static async fromEnvironment({ bucketName, databaseId, collection }) {
    const [{ Firestore }, { Storage }] = await Promise.all([import('@google-cloud/firestore'), import('@google-cloud/storage')]);
    const firestore = new Firestore({ databaseId: databaseId || undefined, ignoreUndefinedProperties: true });
    return new GcpStore({ firestore, storage: new Storage(), bucketName, collection });
  }

  async init() {
    return this;
  }

  async get(id) {
    assertId(id);
    const snap = await this.collection.doc(id).get();
    return snap.exists ? snap.data() : null;
  }

  async listAll() {
    const snap = await this.collection.orderBy('receivedAt', 'desc').limit(500).get();
    return snap.docs.map((d) => d.data());
  }

  async listByWorker(workerId) {
    const snap = await this.collection.where('worker.id', '==', workerId).limit(200).get();
    return snap.docs.map((d) => d.data());
  }

  async create(record) {
    assertId(record.id);
    try {
      await this.collection.doc(record.id).create(record);
    } catch (err) {
      // gRPC status 6 = ALREADY_EXISTS
      if (err.code === 6) throw Object.assign(new Error('case already exists'), { code: 'ALREADY_EXISTS' });
      throw err;
    }
    return structuredClone(record);
  }

  // Firestore transactions may retry, so `mutate` must only depend on the record it is given.
  async update(id, mutate) {
    assertId(id);
    const ref = this.collection.doc(id);
    return this.firestore.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('case not found');
      const next = structuredClone(snap.data());
      const result = (await mutate(next)) ?? next;
      result.updatedAt = new Date().toISOString();
      tx.set(ref, result);
      return structuredClone(result);
    });
  }

  async saveMedia(id, kind, buffer, extension, mimeType) {
    assertId(id);
    const file = `${kind}.${extension}`;
    await this.bucket.file(`cases/${id}/${file}`).save(buffer, { contentType: mimeType, resumable: false });
    return file;
  }

  async readMedia(id, file) {
    assertId(id);
    if (!/^(photo|audio)\.[a-z0-9]+$/.test(file)) throw new Error('invalid media file');
    const [buffer] = await this.bucket.file(`cases/${id}/${file}`).download();
    return buffer;
  }

  async delete(id) {
    assertId(id);
    await this.bucket.deleteFiles({ prefix: `cases/${id}/` });
    await this.collection.doc(id).delete();
  }
}
