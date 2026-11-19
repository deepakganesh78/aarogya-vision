import '/vendor/material.js';
import { DANGER_SIGNS, signLabel } from '/shared/dangerSigns.js';
import { describeReason, triageAssessment } from '/shared/triage.js';
import { LANGUAGES, applyTranslations, getLanguage, setLanguage, t } from './i18n.js';
import * as secure from './secure-store.js';
import { isRecordingSupported, preparePhoto, startRecording } from './media.js';
import { el, formatDate, setChildren } from './dom.js';
import { hydrateIcons, icon, setIcon } from './icons.js';

const SESSION_KEY = 'av_session';
const LANG_KEY = 'av_lang';
const MAX_RECORDING_SEC = 120;
const ANALYSIS_TIMEOUT_MS = 45_000;
const LEVEL_ICON = { URGENT: 'error', PRIORITY: 'warning', ROUTINE: 'check_circle' };
const URGENT_SIGNS = DANGER_SIGNS.filter((s) => s.level === 'URGENT');
const $ = (selector) => document.querySelector(selector);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  session: loadSession(),
  capture: null,
  recorder: null,
  syncing: null,
  serverCases: [],
  view: null,
  result: null,
  openItem: null
};

function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY));
    return s?.token && s.user?.role === 'worker' ? s : null;
  } catch {
    return null;
  }
}

function saveSession(session) {
  state.session = session;
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
  $('#sign-out').hidden = !session;
}

function show(viewId) {
  for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== viewId;
  state.view = viewId;
  window.scrollTo(0, 0);
}

function showError(node, message) {
  node.textContent = message;
  node.hidden = !message;
}

function renderNetwork() {
  const online = navigator.onLine;
  const pill = $('#net-status');
  pill.classList.toggle('offline', !online);
  setIcon(pill.querySelector('md-icon'), online ? 'cloud_done' : 'cloud_off');
  $('#net-text').textContent = online ? t('online') : t('offline_short');
  $('#offline-banner').hidden = online;
}

function authHeader() {
  return { Authorization: `Bearer ${state.session.token}` };
}

function ageText(ageDays) {
  return ageDays === null || ageDays === undefined ? t('age_unknown') : t('age_label', { n: ageDays });
}

// ---- Login -----------------------------------------------------------------------------------

async function handleLogin(event) {
  event.preventDefault();
  const errorNode = $('#login-error');
  showError(errorNode, '');
  if (!navigator.onLine) return showError(errorNode, t('login_offline'));
  const field = $('#access-code');
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: String(field.value).trim() }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.user?.role !== 'worker') return showError(errorNode, t('login_failed'));
    saveSession({ token: body.token, user: body.user });
    field.value = '';
    await goHome();
    syncAndRender();
  } catch {
    showError(errorNode, t('login_offline'));
  }
}

async function signOut() {
  saveSession(null);
  state.serverCases = [];
  await secure.clearCache().catch(() => {});
  show('view-login');
}

// ---- Home ------------------------------------------------------------------------------------

async function goHome() {
  show('view-home');
  if (state.serverCases.length === 0) {
    state.serverCases = (await secure.loadCache(`worker-cases:${state.session.user.id}`).catch(() => null)) || [];
  }
  await renderHome();
}

function levelAvatar(level) {
  return el('span', { slot: 'start', className: `level-avatar level-${level || 'PENDING'}` }, icon(level ? LEVEL_ICON[level] : 'schedule', { filled: Boolean(level) }));
}

async function renderHome() {
  if (!state.session) return;
  $('#user-name').textContent = state.session.user.name;
  const outbox = await secure.listOutbox().catch(() => []);
  const localIds = new Set(outbox.map((o) => o.id));

  const items = [
    ...outbox.map((o) => ({
      id: o.id,
      when: o.meta.capturedAt,
      pending: true,
      workerFlag: Boolean(o.meta.assessment?.workerFlag),
      status: o.state === 'failed' ? t('send_failed', { error: o.lastError || '' }) : t('waiting_to_send'),
      local: o
    })),
    ...state.serverCases.filter((c) => !localIds.has(c.id)).map((c) => ({ id: c.id, when: c.capturedAt, pending: false, status: t(`status_${c.status}`), server: c }))
  ].sort((a, b) => b.when.localeCompare(a.when));

  const list = $('#case-list');
  list.replaceChildren();
  $('#empty-state').hidden = items.length > 0;
  for (const item of items) {
    const level = item.server ? item.server.triage.level : item.workerFlag ? 'URGENT' : null;
    const row = el(
      'md-list-item',
      { type: 'button', className: 'case-item', dataset: { caseId: item.id, pending: String(item.pending) } },
      levelAvatar(level),
      el('div', { slot: 'headline' }, level ? t(`level_${level}`) : t('waiting_to_send')),
      el(
        'div',
        { slot: 'supporting-text' },
        item.server ? `${ageText(item.server.patient.ageDays)}. ` : '',
        level || item.local?.state === 'failed' ? el('span', { className: item.pending ? 'status pending' : 'status' }, item.status) : null
      ),
      el('div', { slot: 'trailing-supporting-text' }, formatDate(item.when, getLanguage()))
    );
    row.addEventListener('click', () => openCase(item));
    list.append(row);
  }
}

// ---- Shared rendering ------------------------------------------------------------------------

function levelSurface(level, { role } = {}) {
  return el(
    'div',
    { className: `level-surface level-${level}`, role },
    el('div', { className: 'level-heading' }, icon(LEVEL_ICON[level], { filled: true }), el('h1', { className: 'md-typescale-headline-small' }, t(`level_${level}`))),
    el('p', { className: 'md-typescale-body-large' }, t(`guidance_${level}`))
  );
}

function card(title, iconName, ...children) {
  return el(
    'md-outlined-card',
    { className: 'card' },
    el('div', { className: 'card-body' }, el('h2', { className: 'card-title md-typescale-title-medium' }, icon(iconName), title), ...children)
  );
}

function statusLine(text, kind) {
  const name = kind === 'done' ? 'cloud_done' : kind === 'pending' ? 'cloud_upload' : 'schedule';
  return el('p', { className: `status-line md-typescale-body-large ${kind || ''}`, id: 'delivery-status' }, icon(name), el('span', {}, text));
}

function dangerSignList() {
  return el('ul', { className: 'danger-list md-typescale-body-large' }, ...URGENT_SIGNS.map((s) => el('li', {}, signLabel(s.id, getLanguage()))));
}

function dangerReminderCard({ withGuidance = true } = {}) {
  return el(
    'md-filled-card',
    { className: 'card reminder' },
    el(
      'div',
      { className: 'card-body' },
      el('h2', { className: 'card-title md-typescale-title-medium' }, icon('warning'), t('danger_reminder_title')),
      dangerSignList(),
      withGuidance ? el('p', { className: 'md-typescale-body-medium' }, t('guidance_URGENT')) : null
    )
  );
}

function sourceChip(source) {
  const text = source === 'ai_voice' || source === 'voice_vitals' ? t('from_voice') : source === 'ai_photo' ? t('from_photo') : t('you_marked');
  return el('span', { className: 'source-chip md-typescale-label-medium' }, text);
}

function understoodCard(c) {
  if (c.aiStatus === 'failed' || c.aiStatus === 'disabled') {
    return card(t('understood'), 'star_shine', el('p', { className: 'md-typescale-body-large' }, t('ai_failed_worker')));
  }
  const rows = [];
  const row = (label, value, source) =>
    el('div', { className: 'fact' }, el('span', { className: 'fact__label md-typescale-body-medium' }, label), el('span', { className: 'fact__value md-typescale-title-medium' }, value), source ? sourceChip(source) : null);

  rows.push(row(t('age'), ageText(c.patient.ageDays), c.autofill.ageDays));
  if (c.patient.sex === 'female' || c.patient.sex === 'male') rows.push(row(t('sex'), t(c.patient.sex), c.autofill.sex));
  if (c.vitals.temperatureC != null) rows.push(row(t('temperature_label'), `${c.vitals.temperatureC} °C`, c.autofill.temperatureC || 'checklist'));
  if (c.vitals.breathsPerMin != null) rows.push(row(t('breaths_label'), String(c.vitals.breathsPerMin), c.autofill.breathsPerMin || 'checklist'));

  const present = Object.entries(c.triage.signs || {}).filter(([, s]) => s.state === 'yes');
  const flagged = c.triage.reasons.some((r) => r.code === 'worker_flag');

  return card(
    t('understood'),
    'star_shine',
    el('div', { className: 'facts' }, ...rows),
    el('h3', { className: 'md-typescale-title-small' }, t('danger_signs_found')),
    present.length || flagged
      ? el(
          'ul',
          { className: 'found-list md-typescale-body-large' },
          flagged ? el('li', {}, t('danger_flag'), ' ', sourceChip('checklist')) : null,
          ...present.map(([id, s]) => el('li', {}, signLabel(id, getLanguage()), ' ', sourceChip(s.source)))
        )
      : el('p', { className: 'md-typescale-body-large' }, t('none_found')),
    c.followUpQuestions?.length
      ? el('div', { className: 'stack-sm' }, el('h3', { className: 'md-typescale-title-small' }, t('doctor_may_ask')), el('ul', { className: 'found-list md-typescale-body-large' }, ...c.followUpQuestions.map((q) => el('li', {}, q))))
      : null
  );
}

function reasonsCard(triage) {
  const reasons = triage.reasons.filter((r) => r.level);
  if (reasons.length === 0) return null;
  return card(t('why'), 'fact_check', el('ul', { className: 'reasons md-typescale-body-medium' }, ...reasons.map((r) => el('li', {}, describeReason(r, getLanguage())))));
}

function replyCard(decision) {
  if (!decision) return null;
  const translated = decision.translated?.text;
  return el(
    'md-filled-card',
    { className: 'card doctor-reply' },
    el(
      'div',
      { className: 'card-body reply' },
      el('h2', { className: 'card-title md-typescale-title-medium' }, icon('stethoscope'), t('doctor_reply')),
      el('p', { className: 'outcome md-typescale-title-large' }, t(`outcome_${decision.outcome}`)),
      el('p', { className: 'instructions md-typescale-body-large' }, translated || decision.instructions),
      translated ? el('p', { className: 'md-typescale-body-small on-surface-variant' }, t('machine_translated')) : null,
      translated ? el('p', { className: 'original quote md-typescale-body-medium' }, decision.instructions) : null,
      decision.followUpDate ? el('p', { className: 'md-typescale-body-medium' }, t('follow_up_on', { date: decision.followUpDate })) : null,
      el('p', { className: 'md-typescale-body-small on-surface-variant' }, `${decision.by.name}, ${formatDate(decision.at, getLanguage())}`)
    )
  );
}

/** Content for a visit: either the analysed server case, or a locally saved one still waiting to send. */
function visitContent({ serverCase, localFlag, phase }) {
  if (serverCase && phase !== 'analysing') {
    return [
      replyCard(serverCase.decision),
      levelSurface(serverCase.triage.level, { role: 'alert' }),
      statusLine(serverCase.decision ? t('status_responded') : t('sent_to_doctor'), 'done'),
      phase === 'timeout' ? el('p', { className: 'md-typescale-body-medium on-surface-variant' }, t('ai_still_reading')) : understoodCard(serverCase),
      reasonsCard(serverCase.triage)
    ];
  }
  if (phase === 'sending' || phase === 'analysing') {
    return [
      localFlag ? levelSurface('URGENT', { role: 'alert' }) : null,
      el('div', { className: 'analysing' }, el('md-circular-progress', { indeterminate: true }), el('p', { className: 'md-typescale-title-medium' }, t('analysing')))
    ];
  }
  if (phase === 'timeout') {
    return [localFlag ? levelSurface('URGENT', { role: 'alert' }) : null, statusLine(t('sent_to_doctor'), 'done'), el('p', { className: 'md-typescale-body-medium on-surface-variant' }, t('ai_still_reading'))];
  }
  // Saved offline: no AI yet, so show the instant danger-sign reminder instead of a guessed level.
  return [localFlag ? levelSurface('URGENT', { role: 'alert' }) : null, statusLine(t('offline_saved'), 'pending'), dangerReminderCard({ withGuidance: !localFlag })];
}

// ---- Visit detail ----------------------------------------------------------------------------

function openCase(item) {
  state.openItem = item;
  renderCase();
  show('view-case');
}

function renderCase() {
  const item = state.openItem;
  if (!item) return;
  setChildren(
    $('#case-detail'),
    el('p', { className: 'md-typescale-body-medium on-surface-variant' }, formatDate(item.when, getLanguage())),
    ...visitContent(item.server ? { serverCase: item.server, phase: 'done' } : { localFlag: item.workerFlag, phase: 'offline' })
  );
}

// ---- Capture ---------------------------------------------------------------------------------

function setPhoto(blob) {
  const preview = $('#photo-preview');
  if (preview.src) URL.revokeObjectURL(preview.src);
  state.capture.photo = blob;
  if (blob) preview.src = URL.createObjectURL(blob);
  else preview.removeAttribute('src');
  $('#photo-item').hidden = !blob;
  $('#take-photo-label').textContent = t(blob ? 'retake_photo' : 'take_photo');
  $('#take-photo').classList.toggle('captured', Boolean(blob));
  updateAttachments();
}

function setAudio(blob, durationSec) {
  const player = $('#audio-preview');
  if (player.src) URL.revokeObjectURL(player.src);
  state.capture.audio = blob;
  state.capture.audioDurationSec = blob ? durationSec : null;
  if (blob) player.src = URL.createObjectURL(blob);
  else player.removeAttribute('src');
  player.hidden = !blob;
  $('#audio-item').hidden = !blob;
  $('#audio-duration').textContent = blob ? formatTimer(durationSec) : '';
  $('#record').classList.toggle('captured', Boolean(blob));
  $('#record-label').textContent = t(blob ? 'speak_again' : 'speak');
  updateAttachments();
}

function updateAttachments() {
  $('#attachments').hidden = !state.capture.photo && !state.capture.audio;
}

function formatTimer(sec) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function setRecordingUi(recording) {
  const tile = $('#record');
  tile.classList.toggle('recording', recording);
  setIcon($('#record-icon'), recording ? 'stop' : 'mic');
  $('#record-label').textContent = t(recording ? 'stop' : state.capture?.audio ? 'speak_again' : 'speak');
  $('#record-timer').textContent = recording ? '0:00' : '';
  $('#record-progress').hidden = !recording;
  if (recording) $('#record-progress').value = 0;
}

async function toggleRecording() {
  if (state.recorder) {
    const current = state.recorder;
    state.recorder = null;
    const { blob, durationSec } = await current.stop();
    setRecordingUi(false);
    setAudio(blob, durationSec);
    return;
  }
  $('#mic-error').hidden = true;
  try {
    const recorder = await startRecording({
      maxMs: MAX_RECORDING_SEC * 1000,
      onTick: (s) => {
        $('#record-timer').textContent = formatTimer(s);
        $('#record-progress').value = Math.min(1, s / MAX_RECORDING_SEC);
      }
    });
    state.recorder = recorder;
    setRecordingUi(true);
    recorder.finished.then(({ blob, durationSec }) => {
      if (state.recorder !== recorder) return;
      state.recorder = null;
      setRecordingUi(false);
      setAudio(blob, durationSec);
    });
  } catch {
    state.recorder = null;
    setRecordingUi(false);
    $('#mic-error').hidden = false;
  }
}

// md-switch binds its inner checkbox through an attribute, so once a user has toggled it, setting
// `selected = false` does not reset it. Swap in fresh elements so consent never carries over to the next visit.
function resetSwitch(id) {
  const fresh = document.createElement('md-switch');
  fresh.id = id;
  fresh.setAttribute('icons', '');
  $(`#${id}`).replaceWith(fresh);
}

function newCapture() {
  state.capture = { id: crypto.randomUUID(), photo: null, audio: null, audioDurationSec: null };
  resetSwitch('consent');
  resetSwitch('danger-flag');
  state.result = null;
  setChildren($('#result-card'));
  $('#notes').value = '';
  $('#notes').hidden = true;
  $('#danger-signs-list').hidden = true;
  setPhoto(null);
  setAudio(null, null);
  setRecordingUi(false);
  showError($('#capture-error'), '');
  const canRecord = isRecordingSupported();
  $('#record').disabled = !canRecord;
  $('#mic-error').hidden = canRecord;
  show('view-capture');
}

async function cancelCapture() {
  if (state.recorder) {
    const current = state.recorder;
    state.recorder = null;
    await current.stop();
  }
  goHome();
}

async function handleSend() {
  if (state.recorder) await toggleRecording();
  const c = state.capture;
  const notes = String($('#notes').value || '').trim();
  if (!c.photo && !c.audio && !notes) return showError($('#capture-error'), t('need_capture'));
  if (!$('#consent').selected) return showError($('#capture-error'), t('consent_required'));
  if (!secure.isSecureStorageAvailable()) return showError($('#capture-error'), t('storage_unavailable'));
  showError($('#capture-error'), '');

  const now = new Date().toISOString();
  const workerFlag = $('#danger-flag').selected;
  const meta = {
    id: c.id,
    capturedAt: now,
    language: getLanguage(),
    consent: { given: true, givenBy: 'family', method: 'verbal', at: now },
    assessment: { ...(workerFlag ? { workerFlag: true } : {}), ...(notes ? { notes } : {}) },
    audioDurationSec: c.audioDurationSec
  };
  const triage = triageAssessment(meta);
  try {
    await secure.addToOutbox({ id: meta.id, meta, triage, photo: c.photo, audio: c.audio });
  } catch {
    return showError($('#capture-error'), t('storage_unavailable'));
  }

  state.result = { id: meta.id, localFlag: workerFlag, phase: navigator.onLine ? 'sending' : 'offline', serverCase: null };
  renderResult();
  show('view-result');
  if (!navigator.onLine) return;

  const result = await sync();
  // A background sync may already have sent this visit, so check the outbox rather than this run's result.
  const stillQueued = (await secure.listOutbox()).some((o) => o.id === meta.id);
  if (!result.sent.includes(meta.id) && stillQueued) {
    state.result.phase = 'offline';
    return renderResult();
  }
  state.result.phase = 'analysing';
  renderResult();
  const analysed = await waitForAnalysis(meta.id);
  if (state.result?.id !== meta.id) return;
  state.result.serverCase = analysed.case;
  state.result.phase = analysed.done ? 'done' : 'timeout';
  renderResult();
}

async function waitForAnalysis(id) {
  const started = Date.now();
  let latest = null;
  while (Date.now() - started < ANALYSIS_TIMEOUT_MS) {
    try {
      const res = await fetch(`/api/worker/cases/${id}`, { headers: authHeader() });
      if (res.ok) {
        latest = (await res.json()).case;
        if (['done', 'failed', 'disabled'].includes(latest.aiStatus)) return { case: latest, done: true };
      }
    } catch {
      break;
    }
    await sleep(1500);
  }
  return { case: latest, done: false };
}

function renderResult() {
  if (!state.result) return;
  setChildren($('#result-card'), ...visitContent(state.result));
}

// ---- Sync ------------------------------------------------------------------------------------

async function refreshServerCases() {
  try {
    const res = await fetch('/api/worker/cases', { headers: authHeader() });
    if (res.status === 401) return 'auth';
    if (!res.ok) return 'error';
    const { cases } = await res.json();
    state.serverCases = cases;
    await secure.saveCache(`worker-cases:${state.session.user.id}`, cases);
    return 'ok';
  } catch {
    return 'offline';
  }
}

async function sendEntry(entry) {
  const full = await secure.loadOutboxEntry(entry.id);
  const form = new FormData();
  form.append('case', JSON.stringify(full.meta));
  if (full.photo) form.append('photo', full.photo, 'photo.jpg');
  if (full.audio) form.append('audio', full.audio, `voice.${full.audio.type.split('/')[1] || 'webm'}`);
  return fetch('/api/cases', { method: 'POST', headers: authHeader(), body: form });
}

function sync({ manual = false } = {}) {
  // Chain onto an in-flight run so a just-saved visit is always included in a fresh pass.
  if (state.syncing) return state.syncing.then(() => sync({ manual }));
  state.syncing = (async () => {
    const result = { sent: [], failed: [], offline: !navigator.onLine, authError: false };
    if (!state.session || !navigator.onLine) return result;
    $('#sync-progress').hidden = false;

    for (const entry of await secure.listOutbox()) {
      if (entry.state === 'failed' && !manual) continue;
      let res;
      try {
        res = await sendEntry(entry);
      } catch {
        result.offline = true;
        await secure.updateOutbox(entry.id, { attempts: entry.attempts + 1, lastError: 'network' });
        break;
      }
      if (res.ok) {
        await secure.removeFromOutbox(entry.id);
        result.sent.push(entry.id);
        continue;
      }
      if (res.status === 401) {
        result.authError = true;
        break;
      }
      const body = await res.json().catch(() => ({}));
      const lastError = body.error || `HTTP ${res.status}`;
      const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
      await secure.updateOutbox(entry.id, { state: permanent ? 'failed' : 'queued', attempts: entry.attempts + 1, lastError });
      if (permanent) result.failed.push(entry.id);
      else break;
    }

    if (!result.authError && !result.offline && (await refreshServerCases()) === 'auth') result.authError = true;
    if (result.authError) {
      saveSession(null);
      show('view-login');
      showError($('#login-error'), t('session_expired'));
    }
    return result;
  })().finally(() => {
    state.syncing = null;
    $('#sync-progress').hidden = true;
  });
  return state.syncing;
}

async function syncAndRender(options) {
  await sync(options);
  if (state.view === 'view-home') await renderHome();
}

// ---- Language & startup ----------------------------------------------------------------------

function rerender() {
  applyTranslations();
  renderNetwork();
  if (state.view === 'view-capture') {
    $('#take-photo-label').textContent = t(state.capture?.photo ? 'retake_photo' : 'take_photo');
    $('#record-label').textContent = t(state.recorder ? 'stop' : state.capture?.audio ? 'speak_again' : 'speak');
    setChildren($('#danger-signs-list'), dangerSignList());
  }
  if (state.view === 'view-home') renderHome();
  if (state.view === 'view-result') renderResult();
  if (state.view === 'view-case') renderCase();
}

function initLanguage() {
  const menu = $('#lang-menu');
  for (const { code, name } of LANGUAGES) {
    const item = el('md-menu-item', { dataset: { lang: code } }, el('div', { slot: 'headline' }, name));
    item.addEventListener('click', () => {
      localStorage.setItem(LANG_KEY, setLanguage(code));
      rerender();
    });
    menu.append(item);
  }
  setLanguage(localStorage.getItem(LANG_KEY) || 'en');
  $('#lang-button').addEventListener('click', () => {
    menu.open = !menu.open;
  });
}

function bindEvents() {
  $('#login-form').addEventListener('submit', handleLogin);
  $('#sign-out').addEventListener('click', signOut);
  $('#new-visit').addEventListener('click', newCapture);
  $('#sync-now').addEventListener('click', () => syncAndRender({ manual: true }));
  $('#cancel-capture').addEventListener('click', cancelCapture);
  $('#take-photo').addEventListener('click', () => $('#photo-input').click());
  $('#photo-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      setPhoto(await preparePhoto(file));
    } catch {
      setPhoto(null);
    }
  });
  $('#remove-photo').addEventListener('click', () => setPhoto(null));
  $('#record').addEventListener('click', toggleRecording);
  $('#remove-audio').addEventListener('click', () => setAudio(null, null));
  $('#type-instead').addEventListener('click', () => {
    $('#notes').hidden = false;
    $('#notes').focus();
  });
  $('#show-danger-signs').addEventListener('click', () => {
    const list = $('#danger-signs-list');
    setChildren(list, dangerSignList());
    list.hidden = !list.hidden;
  });
  $('#send-case').addEventListener('click', handleSend);
  $('#result-done').addEventListener('click', goHome);
  $('#case-back').addEventListener('click', goHome);
  window.addEventListener('online', () => {
    renderNetwork();
    syncAndRender();
  });
  window.addEventListener('offline', renderNetwork);
}

async function start() {
  hydrateIcons();
  initLanguage();
  applyTranslations();
  renderNetwork();
  bindEvents();
  $('#sign-out').hidden = !state.session;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (state.session) {
    await goHome();
    syncAndRender();
  } else {
    show('view-login');
  }
  setInterval(() => {
    if (state.session && navigator.onLine) syncAndRender();
  }, 20_000);
}

start();
