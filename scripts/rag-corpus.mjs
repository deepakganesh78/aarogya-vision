// Build (or update) the Vertex AI RAG Engine corpus of official guideline PDFs.
//   PROJECT_ID=... node scripts/rag-corpus.mjs
// Optional: RAG_LOCATION (default asia-south1), GUIDELINE_BUCKET (default <project>-aarogya-guidelines).
// Downloads every PDF in deploy/guideline-pdfs.txt into the bucket, creates the corpus once
// ("aarogya-guidelines"), imports the PDFs, and prints the corpus resource name for RAG_CORPUS.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Storage } from '@google-cloud/storage';
import { GoogleAuth } from 'google-auth-library';

const project = process.env.PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
if (!project) throw new Error('Set PROJECT_ID');
const location = process.env.RAG_LOCATION || 'asia-south1';
const bucketName = process.env.GUIDELINE_BUCKET || `${project}-aarogya-guidelines`;
const DISPLAY_NAME = 'aarogya-guidelines';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = `https://${location}-aiplatform.googleapis.com/v1`;
const parent = `projects/${project}/locations/${location}`;

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const client = await auth.getClient();

async function call(method, url, body) {
  const res = await client.request({ method, url, data: body, validateStatus: () => true });
  if (res.status >= 300) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(res.data).slice(0, 400)}`);
  return res.data;
}

async function waitFor(op) {
  for (let i = 0; !op.done && i < 180; i += 1) {
    await new Promise((r) => setTimeout(r, 5000));
    op = await call('GET', `${api}/${op.name}`);
  }
  if (!op.done) throw new Error(`operation ${op.name} did not finish`);
  if (op.error) throw new Error(`operation failed: ${JSON.stringify(op.error)}`);
  return op.response;
}

// 1. PDFs into Cloud Storage
const urls = (await fs.readFile(path.join(root, 'deploy', 'guideline-pdfs.txt'), 'utf8'))
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));
const bucket = new Storage({ projectId: project }).bucket(bucketName);
const uris = [];
for (const url of urls) {
  const name = `guidelines/${decodeURIComponent(url.split('/').pop())}`;
  const file = bucket.file(name);
  if (!(await file.exists())[0]) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Aarogya-Vision corpus builder)' } });
    if (!res.ok || !String(res.headers.get('content-type')).includes('pdf')) {
      console.warn(`skipped (not a PDF): ${url}`);
      continue;
    }
    await file.save(Buffer.from(await res.arrayBuffer()), { contentType: 'application/pdf', metadata: { metadata: { sourceUrl: url } } });
    console.log(`uploaded gs://${bucketName}/${name}`);
  }
  uris.push(`gs://${bucketName}/${name}`);
}
if (!uris.length) throw new Error('no PDFs to import');

// 2. Corpus (created once)
const list = await call('GET', `${api}/${parent}/ragCorpora`);
let corpus = (list.ragCorpora || []).find((c) => c.displayName === DISPLAY_NAME);
if (!corpus) {
  console.log(`creating RAG corpus in ${location}`);
  corpus = await waitFor(await call('POST', `${api}/${parent}/ragCorpora`, { displayName: DISPLAY_NAME, description: 'MoHFW / ICMR / WHO guideline PDFs for Aarogya-Vision' }));
}

// 3. The RAG Engine service agent (created with the first corpus) reads the PDFs from the bucket.
const projectNumber = process.env.PROJECT_NUMBER;
if (projectNumber) {
  const member = `serviceAccount:service-${projectNumber}@gcp-sa-vertex-rag.iam.gserviceaccount.com`;
  const [policy] = await bucket.iam.getPolicy({ requestedPolicyVersion: 3 });
  if (!policy.bindings.some((b) => b.role === 'roles/storage.objectViewer' && b.members.includes(member))) {
    policy.bindings.push({ role: 'roles/storage.objectViewer', members: [member] });
    await bucket.iam.setPolicy(policy);
    console.log(`granted ${member} read access to gs://${bucketName}`);
    await new Promise((r) => setTimeout(r, 30000)); // IAM propagation
  }
}

// 4. Import (files already in the corpus are skipped by RAG Engine)
console.log(`importing ${uris.length} PDF(s)`);
const imported = await waitFor(
  await call('POST', `${api}/${corpus.name}/ragFiles:import`, {
    importRagFilesConfig: {
      gcsSource: { uris },
      ragFileTransformationConfig: { ragFileChunkingConfig: { fixedLengthChunking: { chunkSize: 512, chunkOverlap: 100 } } }
    }
  })
);
console.log(`imported: ${JSON.stringify(imported)}`);
console.log(`RAG_CORPUS=${corpus.name}`);
