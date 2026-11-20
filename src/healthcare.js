import crypto from 'node:crypto';

// Writes each case's FHIR R4 bundle to a Cloud Healthcare API FHIR store (asia-south1).
// The bundle from buildFhirBundle() uses urn:uuid references for POST; here every entry gets a stable
// id derived from the case id and is sent as PUT, so re-processing a case updates the same resources
// (the store must have enableUpdateCreate=true). The purge deletes them with the same ids.

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

function fhirId(urn) {
  const raw = String(urn).replace(/^urn:uuid:/, '').replace(/[^A-Za-z0-9.-]/g, '-');
  return raw.length <= 64 ? raw : crypto.createHash('sha256').update(raw).digest('hex').slice(0, 64);
}

/** Turn a POST transaction bundle into an idempotent PUT transaction with resolved references. */
export function toUpsertBundle(bundle) {
  const map = new Map(bundle.entry.map((e) => [e.fullUrl, `${e.resource.resourceType}/${fhirId(e.fullUrl)}`]));
  const json = JSON.stringify(bundle.entry.map((e) => e.resource), (key, value) =>
    key === 'reference' && map.has(value) ? map.get(value) : value
  );
  const resources = JSON.parse(json);
  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: resources.map((resource, i) => {
      const ref = map.get(bundle.entry[i].fullUrl);
      return { resource: { ...resource, id: ref.split('/')[1] }, request: { method: 'PUT', url: ref } };
    })
  };
}

/** Delete-all transaction for the resources a case's bundle created. */
export function toDeleteBundle(bundle) {
  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: bundle.entry.map((e) => ({ request: { method: 'DELETE', url: `${e.resource.resourceType}/${fhirId(e.fullUrl)}` } }))
  };
}

/**
 * @param {{project: string, location: string, dataset: string, fhirStore: string, fetchImpl?: typeof fetch, auth?: {getClient: Function}}} options
 */
export async function createHealthcareFhir({ project, location, dataset, fhirStore, fetchImpl = fetch, auth }) {
  if (!auth) {
    const { GoogleAuth } = await import('google-auth-library');
    auth = new GoogleAuth({ scopes: [SCOPE] });
  }
  const client = await auth.getClient();
  const base = `https://healthcare.googleapis.com/v1/projects/${project}/locations/${location}/datasets/${dataset}/fhirStores/${fhirStore}/fhir`;

  async function execute(bundle) {
    const headers = await client.getRequestHeaders();
    const authHeader = typeof headers.get === 'function' ? headers.get('authorization') : headers.Authorization || headers.authorization;
    const res = await fetchImpl(base, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/fhir+json;charset=utf-8' },
      body: JSON.stringify(bundle)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Healthcare API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  return {
    upsert: (bundle) => execute(toUpsertBundle(bundle)),
    remove: (bundle) => execute(toDeleteBundle(bundle))
  };
}
