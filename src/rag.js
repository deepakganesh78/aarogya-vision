// Supplementary guideline passages from the MoHFW / ICMR / WHO PDFs indexed in a Vertex AI RAG Engine
// corpus. Clinical safety: these are shown to the doctor as "retrieved passages, verify against the
// source". The authoritative citations stay the curated, deterministic ones from guidelines.js, and
// passages never change urgency. The query carries danger-sign labels and the triage level only, no
// patient details or free text.

const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export function ragQuery({ signLabels = [], level, ageGroup }) {
  const parts = [ageGroup, ...signLabels].filter(Boolean);
  if (!parts.length) return '';
  return `Home-visit management and referral guidance for: ${parts.join('; ')}${level ? ` (triage level ${level})` : ''}`;
}

/**
 * @param {{corpus: string, topK?: number, maxDistance?: number, fetchImpl?: typeof fetch, auth?: {getClient: Function}}} options
 * corpus: full resource name projects/<p>/locations/<loc>/ragCorpora/<id>
 */
export async function createRagRetriever({ corpus, topK = 3, fetchImpl = fetch, auth }) {
  const m = /^projects\/([^/]+)\/locations\/([^/]+)\/ragCorpora\/[^/]+$/.exec(corpus || '');
  if (!m) throw new Error('RAG_CORPUS must be projects/<project>/locations/<location>/ragCorpora/<id>');
  const [, project, location] = m;
  if (!auth) {
    const { GoogleAuth } = await import('google-auth-library');
    auth = new GoogleAuth({ scopes: [SCOPE] });
  }
  const client = await auth.getClient();
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}:retrieveContexts`;

  async function retrieve(text, { timeoutMs = 8000 } = {}) {
    if (!text) return [];
    const headers = await client.getRequestHeaders();
    const authHeader = typeof headers.get === 'function' ? headers.get('authorization') : headers.Authorization || headers.authorization;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vertex_rag_store: { rag_resources: [{ rag_corpus: corpus }] },
        query: { text, rag_retrieval_config: { top_k: topK } }
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) throw new Error(`RAG Engine ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const body = await res.json();
    return (body.contexts?.contexts || []).slice(0, topK).map((c) => ({
      text: String(c.text || '').slice(0, 1200),
      source: c.sourceDisplayName || String(c.sourceUri || '').split('/').pop() || 'guideline PDF',
      sourceUri: c.sourceUri || null,
      score: typeof c.score === 'number' ? c.score : typeof c.distance === 'number' ? c.distance : null
    }));
  }

  return { retrieve, corpus };
}
