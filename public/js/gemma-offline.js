// Optional on-phone Gemma helper ("Gemma: offline danger-sign check on the phone").
// Google AI Edge MediaPipe LLM Inference runs Gemma 3 1B IT (int4, web .task) in the browser via WebGPU.
// ASSIST ONLY: it points the worker to danger signs her own note mentions. It never answers the checklist,
// never flips the danger switch, never changes urgency (public/shared/triage.js is the only source) and
// never diagnoses. The model downloads only when the worker opts in, into the Cache API, so it works offline.
import { buildGemmaPrompt, parseGemmaSigns } from '/shared/gemmaPrompt.js';
import { el, setChildren } from './dom.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

const MODEL_CACHE = 'av-gemma-model-v1';
const GENAI_DIR = '/vendor/genai';
const MAX_TOKENS = 2048;
const RUN_TIMEOUT_MS = 90_000;

let llm = null;
let llmLoading = null;

/** Shown only when the server configured a model and the browser has WebGPU and the Cache API. */
export function gemmaAvailable(config) {
  return Boolean(config?.gemma?.modelUrl && typeof navigator !== 'undefined' && navigator.gpu && 'caches' in window && window.ReadableStream);
}

async function cachedModel(url) {
  const cache = await caches.open(MODEL_CACHE);
  return cache.match(url);
}

async function downloadModel(url, onProgress) {
  navigator.storage?.persist?.().catch(() => {});
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok || !res.body) throw new Error(`model_fetch_${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const est = await navigator.storage?.estimate?.().catch(() => null);
  if (total && est?.quota && est.quota - (est.usage || 0) < total * 1.1) throw new Error('no_space');
  let loaded = 0;
  const counted = res.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        loaded += chunk.byteLength;
        onProgress(total ? Math.min(1, loaded / total) : null);
        controller.enqueue(chunk);
      }
    })
  );
  const cache = await caches.open(MODEL_CACHE);
  for (const key of await cache.keys()) await cache.delete(key);
  await cache.put(url, new Response(counted, { headers: { 'Content-Type': 'application/octet-stream' } }));
}

async function loadModel(url) {
  if (llm) return llm;
  llmLoading ||= (async () => {
    const cached = await cachedModel(url);
    if (!cached?.body) throw new Error('model_missing');
    const { LlmInference } = await import(`${GENAI_DIR}/genai_bundle.mjs`);
    const fileset = { wasmLoaderPath: `${GENAI_DIR}/genai_wasm_internal.js`, wasmBinaryPath: `${GENAI_DIR}/genai_wasm_internal.wasm` };
    llm = await LlmInference.createFromOptions(fileset, {
      baseOptions: { modelAssetBuffer: cached.body.getReader() },
      maxTokens: MAX_TOKENS,
      // Deterministic: the same note always gives the same suggestions.
      topK: 1,
      temperature: 0,
      randomSeed: 1
    });
    return llm;
  })().finally(() => {
    llmLoading = null;
  });
  return llmLoading;
}

async function removeModel() {
  llm?.close();
  llm = null;
  await caches.delete(MODEL_CACHE);
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), ms)))]).finally(() => clearTimeout(timer));
}

/**
 * Mount the helper into `container`.
 * @param {{container: HTMLElement, config: object, getNotes: () => string,
 *   getSigns: () => {id: string, label: string, en: string}[], onPick: (id: string) => void}} opts
 *   getSigns returns the danger signs on the worker's checklist (label in her language, en in English).
 * @returns {{render: () => void, reset: () => void}}
 */
export function mountGemmaHelper({ container, config, getNotes, getSigns, onPick }) {
  const url = config.gemma.modelUrl;
  // phase: idle | downloading | ready | starting | checking | result | error
  const ui = { phase: 'idle', progress: null, error: null, signs: null, message: null };
  let busy = false;

  const setUi = (patch) => {
    Object.assign(ui, patch);
    render();
  };

  async function download() {
    if (busy) return;
    busy = true;
    setUi({ phase: 'downloading', progress: 0, error: null });
    try {
      await downloadModel(url, (p) => {
        ui.progress = p;
        const bar = container.querySelector('md-linear-progress');
        const label = container.querySelector('.gemma-progress-label');
        if (bar) {
          bar.indeterminate = p === null;
          if (p !== null) bar.value = p;
        }
        if (label) label.textContent = t('gemma_downloading', { pct: p === null ? '' : `${Math.round(p * 100)}%` });
      });
      setUi({ phase: 'ready' });
    } catch (err) {
      await caches.delete(MODEL_CACHE).catch(() => {});
      setUi({ phase: 'idle', error: err?.message === 'no_space' ? 'gemma_no_space' : 'gemma_error' });
    } finally {
      busy = false;
    }
  }

  async function check() {
    if (busy) return;
    const notes = String(getNotes() || '').trim();
    if (!notes) return setUi({ message: 'gemma_need_note', signs: null });
    const candidates = getSigns();
    busy = true;
    try {
      if (!llm) setUi({ phase: 'starting', message: null });
      const model = await loadModel(url);
      setUi({ phase: 'checking', message: null });
      const prompt = buildGemmaPrompt({ notes, signs: candidates.map((s) => ({ id: s.id, label: s.en })) });
      const reply = await withTimeout(model.generateResponse(prompt), RUN_TIMEOUT_MS);
      setUi({ phase: 'result', signs: parseGemmaSigns(reply, candidates.map((s) => s.id)), error: null });
    } catch (err) {
      setUi({ phase: err?.message === 'model_missing' ? 'idle' : 'ready', error: 'gemma_error', signs: null });
    } finally {
      busy = false;
    }
  }

  async function remove() {
    if (busy) return;
    await removeModel().catch(() => {});
    setUi({ phase: 'idle', signs: null, error: null, message: null });
  }

  function button(kind, iconName, labelKey, onClick) {
    const b = el(kind, { type: 'button' }, iconName ? icon(iconName, { slot: 'icon' }) : null, t(labelKey));
    b.addEventListener('click', onClick);
    return b;
  }

  function resultBlock() {
    if (ui.phase !== 'result' || !ui.signs) return null;
    const labels = new Map(getSigns().map((s) => [s.id, s.label]));
    const shown = ui.signs.filter((id) => labels.has(id));
    const body = shown.length
      ? [
          el('p', { className: 'md-typescale-title-small' }, t('gemma_suggests')),
          el(
            'md-chip-set',
            {},
            ...shown.map((id) => {
              const chip = el('md-assist-chip', { label: labels.get(id) }, icon('warning', { slot: 'icon' }));
              chip.addEventListener('click', () => onPick(id));
              return chip;
            })
          ),
          el('p', { className: 'md-typescale-body-small on-surface-variant' }, t('gemma_tap_hint'))
        ]
      : [el('p', { className: 'md-typescale-body-medium' }, t('gemma_none'))];
    return el('div', { className: 'gemma-result', role: 'status' }, ...body);
  }

  function render() {
    const rows = [el('h2', { className: 'card-title md-typescale-title-small' }, icon('star_shine'), t('gemma_title'))];
    if (ui.phase === 'idle') {
      rows.push(
        el('p', { className: 'md-typescale-body-small on-surface-variant' }, t('gemma_download_hint')),
        el('div', { className: 'row' }, button('md-outlined-button', 'download', 'gemma_download', download))
      );
    } else if (ui.phase === 'downloading') {
      const pct = ui.progress === null ? '' : `${Math.round(ui.progress * 100)}%`;
      rows.push(
        el('md-linear-progress', { value: ui.progress ?? 0, indeterminate: ui.progress === null }),
        el('p', { className: 'gemma-progress-label md-typescale-body-small on-surface-variant', role: 'status' }, t('gemma_downloading', { pct }))
      );
    } else if (ui.phase === 'starting' || ui.phase === 'checking') {
      rows.push(
        el('md-linear-progress', { indeterminate: true }),
        el('p', { className: 'md-typescale-body-small on-surface-variant', role: 'status' }, t(ui.phase === 'starting' ? 'gemma_starting' : 'gemma_checking'))
      );
    } else {
      rows.push(
        el(
          'div',
          { className: 'row space-between' },
          button('md-outlined-button', 'fact_check', 'gemma_check', check),
          button('md-text-button', 'delete', 'gemma_remove', remove)
        ),
        resultBlock()
      );
    }
    const note = ui.error || ui.message;
    if (note) rows.push(el('p', { className: `md-typescale-body-small ${ui.error ? 'error-text' : 'on-surface-variant'}`, role: 'alert' }, t(note)));
    // Always labelled: AI-generated, on-device, verify.
    if (ui.phase !== 'idle') rows.push(el('p', { className: 'gemma-disclaimer md-typescale-body-small on-surface-variant' }, icon('info'), t('gemma_disclaimer')));
    setChildren(container, el('md-outlined-card', { className: 'card gemma-card' }, el('div', { className: 'card-body' }, ...rows)));
  }

  function reset() {
    if (busy) return;
    if (ui.phase === 'result') ui.phase = 'ready';
    ui.signs = null;
    ui.message = null;
    ui.error = null;
    render();
  }

  container.hidden = false;
  render();
  cachedModel(url)
    .then((hit) => {
      if (hit && ui.phase === 'idle') setUi({ phase: 'ready' });
    })
    .catch(() => {});
  return { render, reset };
}
