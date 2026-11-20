import '/vendor/material.js';
import { ageToDays, applicableSigns, patientContext, signLabel, signLevel } from '/shared/dangerSigns.js';
import { skinPatternLabel } from '/shared/skinPatterns.js';
import { describeReason, triageAssessment } from '/shared/triage.js';
import { LANGUAGES, applyTranslations, getLanguage, setLanguage, t } from './i18n.js';
import * as secure from './secure-store.js';
import { isRecordingSupported, preparePhoto, startRecording } from './media.js';
import { startLiveSpeech } from './live-speech.js';
import { el, formatDate, setChildren } from './dom.js';
import { hydrateIcons, icon, setIcon } from './icons.js';
import { gemmaAvailable, mountGemmaHelper } from './gemma-offline.js';

const SESSION_KEY = 'av_session';
const LANG_KEY = 'av_lang';
const MAX_RECORDING_SEC = 120;
const ANALYSIS_TIMEOUT_MS = 45_000;
const LEVEL_ICON = { URGENT: 'error', PRIORITY: 'warning', ROUTINE: 'check_circle' };
const SPEECH_LANG = { en: 'en-IN', hi: 'hi-IN', ta: 'ta-IN' };
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
  openItem: null,
  profile: null,
  patients: [],
  patient: null,
  editing: null,
  appConfig: null,
  live: null,
  seenReplies: null, // replies she has opened (persisted per worker)
  alertedReplies: new Set(), // replies already alerted in this session
  replyAlertCase: null
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

function ageText(p) {
  if (!p) return t('age_unknown');
  if (p.ageValue !== null && p.ageValue !== undefined && p.ageUnit) return `${p.ageValue} ${t(`unit_${p.ageUnit}`)}`;
  return p.ageDays === null || p.ageDays === undefined ? t('age_unknown') : t('age_label', { n: p.ageDays });
}

/** "24 years · Female · Pregnant, 7 months" */
function patientMeta(p) {
  if (!p) return '';
  const parts = [ageText(p)];
  if (p.sex === 'female' || p.sex === 'male') parts.push(t(p.sex));
  if (p.pregnant) parts.push(p.pregnancyMonths ? t('pregnant_months', { n: p.pregnancyMonths }) : t('pregnant_short'));
  return parts.join(' · ');
}

function withDays(p) {
  return p ? { ...p, ageDays: ageToDays(p.ageValue, p.ageUnit) ?? p.ageDays ?? null } : p;
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
    loadProfile();
    refreshPatients();
    await goHome();
    syncAndRender();
  } catch {
    showError(errorNode, t('login_offline'));
  }
}

async function signOut() {
  saveSession(null);
  state.serverCases = [];
  state.profile = null;
  state.patients = [];
  state.seenReplies = null;
  state.alertedReplies.clear();
  hideReplyAlert();
  await secure.clearCache().catch(() => {});
  show('view-login');
}

/** Demo auto sign-in (no access code) when the server allows it. Returns true when signed in. */
async function autoLogin() {
  if (!state.appConfig?.autoLogin || !navigator.onLine) return false;
  try {
    const res = await fetch('/api/login/auto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'worker' }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.user?.role !== 'worker') return false;
    saveSession({ token: body.token, user: body.user });
    return true;
  } catch {
    return false;
  }
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

// ---- Doctor replies: colour by the doctor's decision, highlight until read, notify on arrival -------
// Draft clinical wording and colours: refer now is serious (red), home care with follow-up is yellow,
// a request for more information needs the ASHA to act (blue), no further action is green.
const REPLY_TONE = { refer_now: 'urgent', home_care_follow_up: 'followup', need_more_info: 'info', no_action: 'ok' };
const replyTone = (decision) => REPLY_TONE[decision?.outcome] || 'info';
const replyKey = (c) => (c?.decision ? `${c.id}@${c.decision.at}` : null);
const seenRepliesKey = () => `av_seen_replies:${state.session?.user.id || ''}`;

function loadSeenReplies() {
  try {
    const raw = localStorage.getItem(seenRepliesKey());
    return raw ? new Set(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}
function saveSeenReplies() {
  localStorage.setItem(seenRepliesKey(), JSON.stringify([...state.seenReplies].slice(-300)));
}
function isUnreadReply(c) {
  return Boolean(c?.decision && state.seenReplies && !state.seenReplies.has(replyKey(c)));
}
function markReplySeen(c) {
  if (!isUnreadReply(c)) return;
  state.seenReplies.add(replyKey(c));
  saveSeenReplies();
  if (state.replyAlertCase === c.id) hideReplyAlert();
}

/** After each sync: alert once for every reply not seen yet (replies already there on first use are not alerted). */
function checkReplies() {
  if (!state.session) return;
  const replied = state.serverCases.filter((c) => c.decision);
  if (!state.seenReplies) {
    state.seenReplies = loadSeenReplies();
    if (!state.seenReplies) {
      state.seenReplies = new Set(replied.map(replyKey));
      saveSeenReplies();
      return;
    }
  }
  const open = state.view === 'view-case' ? state.openItem?.server?.id : null;
  for (const c of replied) if (c.id === open) markReplySeen(c);
  const fresh = replied.filter((c) => isUnreadReply(c) && !state.alertedReplies.has(replyKey(c)));
  if (!fresh.length) return;
  for (const c of fresh) state.alertedReplies.add(replyKey(c));
  fresh.sort((a, b) => b.decision.at.localeCompare(a.decision.at));
  notifyReply(fresh[0], fresh.length);
}

function notifyReply(c, count) {
  const title = t('reply_title');
  const body = count > 1 ? t('reply_more', { n: count }) : t('reply_body', { name: c.patient?.name || patientMeta(c.patient), outcome: t(`outcome_${c.decision.outcome}`) });
  state.replyAlertCase = c.id;
  const view = el('md-filled-button', {}, t('view_reply'));
  view.addEventListener('click', () => openCaseById(c.id));
  const close = el('md-icon-button', { ariaLabel: t('dismiss') }, icon('close'));
  close.addEventListener('click', hideReplyAlert);
  const box = $('#reply-alert');
  box.className = `reply-alert reply-alert--${replyTone(c.decision)}`;
  setChildren(box, el('span', { className: 'reply-alert__icon' }, icon('stethoscope')), el('div', { className: 'reply-alert__text' }, el('strong', { className: 'md-typescale-title-small' }, title), el('span', { className: 'md-typescale-body-medium' }, body)), view, close);
  box.hidden = false;
  navigator.vibrate?.([120, 60, 120]);
  // A system notification too, when she has allowed them (shown even when the app is in the background).
  if ('Notification' in window && Notification.permission === 'granted' && navigator.serviceWorker) {
    navigator.serviceWorker.ready
      .then((reg) => reg.showNotification(title, { body, tag: `reply-${c.id}`, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { caseId: c.id }, renotify: true }))
      .catch(() => {});
  }
}

function hideReplyAlert() {
  state.replyAlertCase = null;
  $('#reply-alert').hidden = true;
}

/** Ask once, from a tap (sending a visit), so replies can arrive as phone notifications. */
function askNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}

function openCaseById(id) {
  hideReplyAlert();
  const c = state.serverCases.find((x) => x.id === id);
  if (c) openCase({ id: c.id, when: c.capturedAt, pending: false, status: t(`status_${c.status}`), server: c });
}

// ---- Profile card --------------------------------------------------------------------------

async function loadProfile() {
  const key = `worker-profile:${state.session.user.id}`;
  if (!state.profile) state.profile = await secure.loadCache(key).catch(() => null);
  renderProfile();
  try {
    const res = await fetch('/api/profile', { headers: authHeader() });
    if (!res.ok) return;
    state.profile = await res.json();
    await secure.saveCache(key, state.profile).catch(() => {});
    renderProfile();
  } catch {
    // offline: keep the cached profile
  }
}

function renderProfile() {
  const p = state.profile;
  const card = $('#profile-card');
  if (!p?.asha) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  $('#profile-name').textContent = `${p.asha.name} · ASHA`;
  $('#profile-place').textContent = t('profile_place', p.asha);
  $('#profile-phc').textContent = p.asha.phc ? t('profile_phc', p.asha) : '';
  $('#profile-stats').textContent = p.asha.households && p.asha.since ? t('profile_stats', p.asha) : '';
  // Cases go to whichever doctor is on the dashboard; show how many are online (only known online).
  $('#profile-doctor').textContent = '';
  const watch = $('#doctor-watch');
  const n = p.doctorsOnline;
  watch.hidden = typeof n !== 'number' || !navigator.onLine;
  watch.classList.toggle('away', !n);
  $('#doctor-watch-text').textContent = n ? t('doctors_online', { n }) : t('doctors_away');
}

async function renderHome() {
  if (!state.session) return;
  $('#user-name').textContent = state.session.user.name;
  renderProfile();
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
    const unread = isUnreadReply(item.server);
    const tone = item.server?.decision ? replyTone(item.server.decision) : null;
    const row = el(
      'md-list-item',
      { type: 'button', className: `case-item${tone ? ` case-item--replied case-item--${tone}` : ''}${unread ? ' case-item--unread' : ''}`, dataset: { caseId: item.id, pending: String(item.pending) } },
      levelAvatar(level),
      el('div', { slot: 'headline' }, itemName(item) || (level ? t(`level_${level}`) : t('waiting_to_send')), unread ? el('span', { className: 'reply-badge' }, t('new_reply')) : null),
      el(
        'div',
        { slot: 'supporting-text' },
        itemName(item) ? `${level ? t(`level_${level}`) : t('waiting_to_send')}. ` : '',
        item.server ? `${patientMeta(item.server.patient)}. ` : '',
        level || item.local?.state === 'failed' ? el('span', { className: item.pending ? 'status pending' : 'status' }, item.status) : null,
        el('span', { className: 'case-item__date' }, formatDate(item.when, getLanguage()))
      ),
      el('div', { slot: 'trailing-supporting-text' }, formatDate(item.when, getLanguage()))
    );
    row.addEventListener('click', () => openCase(item));
    list.append(row);
  }
}

function itemName(item) {
  return item.server?.patient?.name || item.local?.meta?.patient?.name || '';
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

/** Signs that mean "refer now" for this patient (age group, pregnancy). */
function dangerSignList(patient = state.view === 'view-capture' ? formPatient() : state.patient) {
  const p = withDays(patient) || {};
  const ctx = patientContext(p);
  const urgent = applicableSigns(p).filter((s) => signLevel(s, ctx) === 'URGENT');
  return el('ul', { className: 'danger-list md-typescale-body-large' }, ...urgent.map((s) => el('li', { dataset: { sign: s.id } }, signLabel(s.id, getLanguage()))));
}

// ---- Read aloud ------------------------------------------------------------------------------

function stopReading() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

function readAloud(lines, button) {
  if (!('speechSynthesis' in window)) return;
  const synth = window.speechSynthesis;
  if (synth.speaking) {
    synth.cancel();
    return;
  }
  const lang = SPEECH_LANG[getLanguage()] || 'en-IN';
  const voice = synth.getVoices().find((v) => v.lang === lang) || synth.getVoices().find((v) => v.lang.startsWith(lang.slice(0, 2)));
  const label = button.querySelector('span');
  lines.forEach((line, i) => {
    const u = new SpeechSynthesisUtterance(line);
    u.lang = lang;
    if (voice) u.voice = voice;
    u.rate = 0.9;
    if (i === 0) u.onstart = () => (label.textContent = t('stop_reading'));
    if (i === lines.length - 1) u.onend = u.onerror = () => (label.textContent = t('read_aloud'));
    synth.speak(u);
  });
}

/** "What to do now": curated steps from the cited guideline, in the worker's language, with read-aloud. */
function stepsCard(c) {
  const ws = c.workerSteps;
  const steps = ws?.[getLanguage()] || ws?.en;
  if (!steps?.length) return null;
  const button = el('md-outlined-button', { type: 'button' }, icon('volume_up', { slot: 'icon' }), el('span', {}, t('read_aloud')));
  button.addEventListener('click', () => readAloud([t('what_to_do'), ...steps], button));
  if (!('speechSynthesis' in window)) button.hidden = true;
  return el(
    'md-outlined-card',
    { className: 'card' },
    el(
      'div',
      { className: 'card-body' },
      el('div', { className: 'row space-between' }, el('h2', { className: 'card-title md-typescale-title-medium' }, icon('fact_check'), t('what_to_do')), button),
      el('ol', { className: 'steps md-typescale-body-large' }, ...steps.map((s) => el('li', {}, s))),
      el('p', { className: 'md-typescale-body-small on-surface-variant' }, t('steps_source', { title: ws.title }))
    )
  );
}

function patientHeader(p) {
  if (!p?.name) return null;
  return el(
    'div',
    { className: 'patient-chip' },
    icon('person'),
    el(
      'div',
      { className: 'patient-chip__text' },
      el('div', { className: 'md-typescale-title-medium' }, p.name),
      el('div', { className: 'md-typescale-body-medium on-surface-variant' }, patientMeta(p), p.returning ? ` · ${t('returning', { n: p.visit })}` : '')
    ),
    el('span', {})
  );
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
  const text = source === 'ai_voice' || source === 'voice_vitals' || source === 'live_voice' ? t('from_voice') : source === 'ai_photo' ? t('from_photo') : t('you_marked');
  return el('span', { className: 'source-chip md-typescale-label-medium' }, text);
}

function understoodCard(c) {
  if (c.aiStatus === 'failed' || c.aiStatus === 'disabled') {
    return card(t('understood'), 'star_shine', el('p', { className: 'md-typescale-body-large' }, t('ai_failed_worker')));
  }
  const rows = [];
  const row = (label, value, source) =>
    el('div', { className: 'fact' }, el('span', { className: 'fact__label md-typescale-body-medium' }, label), el('span', { className: 'fact__value md-typescale-title-medium' }, value), source ? sourceChip(source) : null);

  rows.push(row(t('age'), ageText(c.patient), c.autofill.ageDays));
  if (c.patient.sex === 'female' || c.patient.sex === 'male') rows.push(row(t('sex'), t(c.patient.sex), c.autofill.sex));
  if (c.patient.pregnant) rows.push(row(t('pregnant'), c.patient.pregnancyMonths ? t('months_n', { n: c.patient.pregnancyMonths }) : '✓', 'checklist'));
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
    { className: `card doctor-reply doctor-reply--${replyTone(decision)}` },
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

/** Medicines the doctor sent by bike: on the way (from where, about how long) or delivered. */
function deliveryCard(dispatch) {
  if (!dispatch) return null;
  const delivered = dispatch.status === 'delivered';
  const items = [...new Set(dispatch.stops.flatMap((s) => s.items))];
  return el(
    'md-outlined-card',
    { className: 'card medicine-delivery' },
    el(
      'div',
      { className: 'card-body' },
      el('h2', { className: 'card-title md-typescale-title-medium' }, icon(delivered ? 'check_circle' : 'electric_moped'), t(delivered ? 'meds_delivered' : 'meds_on_the_way')),
      el(
        'p',
        { className: 'md-typescale-body-large' },
        delivered
          ? t('meds_delivered_at', { time: formatDate(dispatch.deliveredAt || dispatch.at, getLanguage()) })
          : t('meds_coming', { name: dispatch.courier.name, places: dispatch.stops.map((s) => s.name).join(', '), min: dispatch.etaMin })
      ),
      el('ul', { className: 'md-typescale-body-medium' }, ...items.map((name) => el('li', {}, name))),
      el('p', { className: 'md-typescale-body-small on-surface-variant' }, t('meds_check'))
    )
  );
}

/** Content for a visit: either the analysed server case, or a locally saved one still waiting to send. */
function visitContent({ serverCase, localFlag, localLevel, localPatient, phase }) {
  if (serverCase && phase !== 'analysing') {
    return [
      patientHeader(serverCase.patient),
      replyCard(serverCase.decision),
      deliveryCard(serverCase.dispatch),
      levelSurface(serverCase.triage.level, { role: 'alert' }),
      statusLine(serverCase.decision ? t('status_responded') : t('sent_to_doctor'), 'done'),
      stepsCard(serverCase),
      phase === 'timeout' ? el('p', { className: 'md-typescale-body-medium on-surface-variant' }, t('ai_still_reading')) : understoodCard(serverCase),
      reasonsCard(serverCase.triage)
    ];
  }
  if (phase === 'sending' || phase === 'analysing') {
    return [
      patientHeader(localPatient),
      localFlag ? levelSurface('URGENT', { role: 'alert' }) : null,
      el('div', { className: 'analysing' }, el('md-circular-progress', { indeterminate: true }), el('p', { className: 'md-typescale-title-medium' }, t('analysing')))
    ];
  }
  if (phase === 'timeout') {
    return [localFlag ? levelSurface('URGENT', { role: 'alert' }) : null, statusLine(t('sent_to_doctor'), 'done'), el('p', { className: 'md-typescale-body-medium on-surface-variant' }, t('ai_still_reading'))];
  }
  // Saved offline: no AI yet, so show the rules level from the phone (or the danger-sign reminder).
  const offlineLevel = localLevel && localLevel !== 'ROUTINE' ? localLevel : localFlag ? 'URGENT' : null;
  return [
    patientHeader(localPatient),
    offlineLevel ? levelSurface(offlineLevel, { role: 'alert' }) : null,
    statusLine(t('offline_saved'), 'pending'),
    dangerReminderCard({ withGuidance: !offlineLevel })
  ];
}

// ---- Visit detail ----------------------------------------------------------------------------

function openCase(item) {
  state.openItem = item;
  if (item.server) markReplySeen(item.server);
  renderCase();
  show('view-case');
}

function renderCase() {
  const item = state.openItem;
  if (!item) return;
  setChildren(
    $('#case-detail'),
    el('p', { className: 'md-typescale-body-medium on-surface-variant' }, formatDate(item.when, getLanguage())),
    ...visitContent(
      item.server
        ? { serverCase: item.server, phase: 'done' }
        : { localFlag: item.workerFlag, localLevel: item.local?.triage?.level, localPatient: item.local?.meta?.patient, phase: 'offline' }
    )
  );
}

// ---- Patient details (top of the visit screen) ----------------------------------------------

async function refreshPatients() {
  if (!state.session) return;
  const key = `worker-patients:${state.session.user.id}`;
  if (state.patients.length === 0) state.patients = (await secure.loadCache(key).catch(() => null)) || [];
  try {
    const res = await fetch('/api/worker/patients', { headers: authHeader() });
    if (!res.ok) return;
    const { patients } = await res.json();
    // Keep patients added offline (no id yet) until the server knows them.
    const known = new Set(patients.map((p) => `${p.name.toLowerCase()}|${p.sex}`));
    const pending = state.patients.filter((p) => !p.id && !known.has(`${p.name.toLowerCase()}|${p.sex}`));
    state.patients = [...pending, ...patients];
    await secure.saveCache(key, state.patients).catch(() => {});
  } catch {
    // offline: keep the cached list
  }
}

function startVisit() {
  stopReading();
  state.patient = null;
  newCapture();
  fillPatientForm(null);
  setPatientOpen();
  refreshPatients();
}

/** Matching patients under the name field: tap one to fill in her details (a returning patient). */
function renderSuggestions() {
  const box = $('#patient-suggestions');
  const q = String($('#p-name').value || '').trim().toLowerCase();
  const picked = state.editing && state.editing.name.toLowerCase() === q;
  const items = q && !picked ? state.patients.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 5) : [];
  box.replaceChildren();
  box.hidden = items.length === 0;
  for (const p of items) {
    const row = el(
      'md-list-item',
      { type: 'button' },
      levelAvatar(p.lastLevel),
      el('div', { slot: 'headline' }, p.name),
      el('div', { slot: 'supporting-text' }, `${patientMeta(p)}${p.visits ? ` · ${t('visits_n', { n: p.visits })}` : ''}`)
    );
    row.addEventListener('click', () => {
      fillPatientForm(p);
      box.hidden = true;
      $('#p-age').focus();
    });
    box.append(row);
  }
}

function renderPatientStatus() {
  const badge = $('#patient-status');
  const name = String($('#p-name').value || '').trim().toLowerCase();
  if (!name) {
    badge.hidden = true;
    return;
  }
  const same = state.editing && state.editing.name.toLowerCase() === name;
  if (!same) state.editing = null;
  badge.hidden = false;
  badge.textContent = same ? t('returning_short', { n: (state.editing.visits || 0) + 1 }) : t('new_patient');
}

function setSex(sex) {
  for (const chip of document.querySelectorAll('#p-sex md-filter-chip')) chip.selected = chip.dataset.sex === sex;
  $('#p-preg-row').hidden = sex !== 'female';
  if (sex !== 'female') resetPregnant(false);
  updateMonths();
}

function currentSex() {
  return [...document.querySelectorAll('#p-sex md-filter-chip')].find((c) => c.selected)?.dataset.sex || null;
}

// Fresh switch each time (see resetSwitch), re-bound so turning it on shows the months picker.
function resetPregnant(selected) {
  resetSwitch('p-pregnant');
  const sw = $('#p-pregnant');
  sw.selected = selected;
  sw.addEventListener('change', updateMonths);
  sw.addEventListener('input', updateMonths);
}

function updateMonths() {
  const show = currentSex() === 'female' && $('#p-pregnant').selected;
  $('#p-months').hidden = !show;
}

function buildMonthOptions(selected) {
  const select = $('#p-months');
  select.replaceChildren(
    ...Array.from({ length: 9 }, (_, i) =>
      el('md-select-option', { value: String(i + 1), selected: selected === i + 1 }, el('div', { slot: 'headline' }, i === 0 ? t('month_one') : t('months_n', { n: i + 1 })))
    )
  );
}

/** Fill the patient card: empty for a new patient, or with an existing patient's details. */
function fillPatientForm(p = null) {
  state.editing = p;
  showError($('#patient-error'), '');
  $('#p-name').value = p?.name || '';
  $('#p-age').value = p?.ageValue ?? '';
  $('#p-unit').value = p?.ageUnit || 'years';
  resetPregnant(Boolean(p?.pregnant));
  buildMonthOptions(p?.pregnancyMonths ?? null);
  setSex(p?.sex === 'female' || p?.sex === 'male' ? p.sex : null);
  $('#patient-suggestions').hidden = true;
  renderPatientStatus();
}

/** What the card says now, without checking it (for the danger-sign list). */
function formPatient() {
  const ageRaw = String($('#p-age').value || '').trim();
  const sex = currentSex();
  const pregnant = sex === 'female' && $('#p-pregnant').selected;
  return {
    name: String($('#p-name').value || '').trim().slice(0, 80),
    ageValue: ageRaw === '' ? null : Number(ageRaw),
    ageUnit: $('#p-unit').value || 'years',
    sex,
    pregnant,
    pregnancyMonths: pregnant ? Number($('#p-months').value) || null : null
  };
}

/**
 * Check the patient card before sending. Name, age and sex are required; pregnancy months only when
 * she is pregnant. Returns { patient } or null after showing what is missing.
 */
function readPatient() {
  const f = formPatient();
  const err = $('#patient-error');
  const fail = (key, field) => {
    showError(err, t(key));
    $('#patient-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    field?.focus?.();
    return null;
  };
  if (!f.name) return fail('need_name', $('#p-name'));
  if (f.ageValue === null || !Number.isFinite(f.ageValue) || f.ageValue < 0 || f.ageValue > 120) return fail('need_age', $('#p-age'));
  if (!f.sex) return fail('need_sex');
  if (f.pregnant && !f.pregnancyMonths) return fail('need_months');
  showError(err, '');
  const same = state.editing && state.editing.name.toLowerCase() === f.name.toLowerCase() && state.editing.sex === f.sex;
  return { patient: { ...(same && state.editing.id ? { id: state.editing.id } : {}), ...f, visits: same ? state.editing.visits || 0 : 0 } };
}

/** The patient card is required, so it is always open. */
function setPatientOpen() {
  $('#patient-card').classList.remove('collapsed');
  $('#patient-toggle').setAttribute('aria-expanded', 'true');
}

/** Remember a patient added offline so the worker can pick them again before the next sync. */
function rememberPatient(p) {
  const key = (x) => `${x.name.toLowerCase()}|${x.sex}`;
  const rest = state.patients.filter((x) => (p.id ? x.id !== p.id : key(x) !== key(p)));
  state.patients = [{ ...p, visits: (p.visits || 0) + 1, lastSeen: new Date().toISOString() }, ...rest];
  secure.saveCache(`worker-patients:${state.session.user.id}`, state.patients).catch(() => {});
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
  checkPhoto(blob);
}

// ---- Rash photo check: how the skin looks (AI hint for the worker only, never a diagnosis) ----------
// Not saved with the visit and never changes the urgency level; the doctor names any disease.

async function checkPhoto(blob) {
  const token = Symbol('photo-check');
  state.photoCheck = { token, status: blob ? 'checking' : null, result: null };
  renderPhotoCheck();
  if (!blob) return;
  if (!navigator.onLine || !state.session) {
    state.photoCheck.status = 'offline';
    return renderPhotoCheck();
  }
  let status = 'failed';
  let result = null;
  try {
    const form = new FormData();
    form.append('photo', blob, 'photo.jpg');
    const res = await fetch('/api/worker/photo-check', { method: 'POST', headers: authHeader(), body: form });
    if (res.ok) {
      result = await res.json();
      status = 'done';
    }
  } catch {
    status = navigator.onLine ? 'failed' : 'offline';
  }
  if (state.photoCheck?.token !== token) return; // a newer photo replaced this one
  state.photoCheck = { token, status, result };
  renderPhotoCheck();
}

function renderPhotoCheck() {
  const cardNode = $('#photo-check');
  const pc = state.photoCheck;
  cardNode.hidden = !pc?.status;
  if (!pc?.status) return setChildren($('#photo-check-body'));
  const lang = getLanguage();
  const title = el('h2', { className: 'card-title md-typescale-title-medium' }, icon('image'), t('photo_check_title'));
  if (pc.status === 'checking') return setChildren($('#photo-check-body'), title, el('md-linear-progress', { indeterminate: true }), el('p', { className: 'md-typescale-body-medium' }, t('photo_check_checking')));
  if (pc.status !== 'done') return setChildren($('#photo-check-body'), title, el('p', { className: 'md-typescale-body-medium on-surface-variant' }, t(pc.status === 'offline' ? 'photo_check_offline' : 'photo_check_failed')));
  const r = pc.result;
  const checks = r.checks.map((id) => signLabel(id, lang)).filter(Boolean);
  setChildren(
    $('#photo-check-body'),
    title,
    el('p', { className: 'photo-check__pattern md-typescale-title-large' }, skinPatternLabel(r.pattern, lang)),
    r.confidence === 'low' && !r.retake ? el('p', { className: 'md-typescale-body-small on-surface-variant' }, t('photo_check_unsure')) : null,
    r.retake ? el('p', { className: 'md-typescale-body-medium' }, t('photo_check_retake')) : null,
    lang === 'en' && r.features.length ? el('ul', { className: 'md-typescale-body-medium' }, ...r.features.map((f) => el('li', {}, f))) : null,
    checks.length ? el('p', { className: 'md-typescale-body-medium' }, t('photo_check_look_for')) : null,
    checks.length ? el('ul', { className: 'photo-check__signs md-typescale-body-medium' }, ...checks.map((c) => el('li', {}, c))) : null,
    checks.length ? el('p', { className: 'md-typescale-body-medium' }, t('photo_check_danger')) : null,
    el('p', { className: 'md-typescale-body-small on-surface-variant' }, `${t('photo_check_hint')}${r.provider === 'mock' ? ' [MOCK]' : ''}`)
  );
}

function setAudio(blob, durationSec) {
  state.capture.audio = blob;
  state.capture.audioDurationSec = blob ? durationSec : null;
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

// ---- Live text and spoken follow-up questions while speaking (Gemini Live) ------------------

async function loadAppConfig() {
  try {
    state.appConfig = await (await fetch('/api/config')).json();
  } catch {
    // offline: no live text
  }
}

function liveAvailable() {
  return Boolean(state.appConfig?.liveSpeech && navigator.onLine && state.session && window.AudioWorkletNode);
}

// Live text goes straight into the note box (she can edit it), like the first prototype.
// One small line under it shows the status while listening, then the English translation.
function setLiveLine(text) {
  const line = $('#live-english');
  line.textContent = text || '';
  line.hidden = !text;
}

function setLiveStatus(status) {
  state.capture.liveStatus = status;
  if (status === 'done') return;
  const text = { connecting: t('live_connecting'), live: t('live_listening'), asking: t('live_asking'), unavailable: t('live_unavailable') }[status] || '';
  setLiveLine(text);
}

function renderLive(text) {
  const notes = $('#notes');
  const base = state.capture.notesBase || '';
  if (!text) {
    if (state.capture.liveWritten) notes.value = base;
    state.capture.liveWritten = false;
    setLiveLine('');
    return;
  }
  if (text.original) {
    notes.value = `${base}${base ? ' ' : ''}${text.original}`.slice(0, 1000);
    state.capture.liveWritten = true;
  }
  const differs = text.english && text.english.trim().toLowerCase() !== (text.original || '').trim().toLowerCase();
  const lines = [];
  if (text.followUp) lines.push(t('live_followup_prefix', { text: text.followUp }));
  if (differs) lines.push(t('live_english_prefix', { text: text.english }));
  if (!text.interim || lines.length) setLiveLine(lines.join('\n'));
}

async function startLive(stream) {
  state.capture.liveTranscript = null;
  state.capture.notesBase = state.capture.liveWritten ? state.capture.notesBase || '' : String($('#notes').value || '').trim();
  try {
    state.live = await startLiveSpeech({
      stream,
      token: state.session.token,
      lang: getLanguage(),
      wsUrl: state.appConfig?.liveSpeech?.wsUrl || null,
      onUpdate: (text) => renderLive(text),
      onStatus: (status) => setLiveStatus(status)
    });
  } catch {
    state.live = null;
    setLiveStatus('unavailable');
  }
}

async function stopLive() {
  const live = state.live;
  state.live = null;
  if (!live) return;
  const text = await live.stop();
  if (text.original || text.english) {
    state.capture.liveTranscript = {
      original: text.original.slice(0, 4000),
      english: text.english.slice(0, 4000),
      language: text.language,
      provider: 'gemini-live',
      model: state.appConfig?.liveSpeech?.model || null,
      followUp: text.followUp ? text.followUp.slice(0, 1000) : null
    };
    renderLive({ ...text, interim: false });
  } else {
    renderLive(null);
  }
}

// The voice note is ready as soon as the recorder stops; the live follow-up and English text arrive after.
async function toggleRecording() {
  if (state.recorder) {
    const current = state.recorder;
    state.recorder = null;
    const liveDone = stopLive();
    const { blob, durationSec } = await current.stop();
    setRecordingUi(false);
    setAudio(blob, durationSec);
    await liveDone;
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
    if (liveAvailable()) startLive(recorder.stream);
    recorder.finished.then(async ({ blob, durationSec }) => {
      if (state.recorder !== recorder) return;
      state.recorder = null;
      const liveDone = stopLive();
      setRecordingUi(false);
      setAudio(blob, durationSec);
      await liveDone;
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
  state.capture = { id: crypto.randomUUID(), photo: null, audio: null, audioDurationSec: null, liveTranscript: null, liveStatus: null, notesBase: '', liveWritten: false };
  renderLive(null);
  resetSwitch('consent');
  resetSwitch('danger-flag');
  state.result = null;
  setChildren($('#result-card'));
  $('#notes').value = '';
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
  state.live?.cancel();
  state.live = null;
  if (state.recorder) {
    const current = state.recorder;
    state.recorder = null;
    await current.stop();
  }
  goHome();
}

async function handleSend() {
  askNotificationPermission();
  if (state.recorder) await toggleRecording();
  const c = state.capture;
  const checked = readPatient();
  if (!checked) return;
  state.patient = checked.patient;
  const notes = String($('#notes').value || '').trim().slice(0, 1000);
  if (!c.photo && !c.audio && !notes) return showError($('#capture-error'), t('need_capture'));
  if (!$('#consent').selected) return showError($('#capture-error'), t('consent_required'));
  if (!secure.isSecureStorageAvailable()) return showError($('#capture-error'), t('storage_unavailable'));
  showError($('#capture-error'), '');

  const now = new Date().toISOString();
  const workerFlag = $('#danger-flag').selected;
  const p = state.patient;
  const patient = p
    ? {
        ...(p.id ? { id: p.id } : {}),
        ...(p.name ? { name: p.name } : {}),
        ...(p.ageValue !== null && p.ageValue !== undefined ? { ageValue: p.ageValue, ageUnit: p.ageUnit, ageDays: ageToDays(p.ageValue, p.ageUnit) } : {}),
        ...(p.sex ? { sex: p.sex } : {}),
        ...(p.pregnant ? { pregnant: true, pregnancyMonths: p.pregnancyMonths } : {})
      }
    : undefined;
  const meta = {
    id: c.id,
    capturedAt: now,
    language: getLanguage(),
    consent: { given: true, givenBy: 'family', method: 'verbal', at: now },
    ...(patient ? { patient } : {}),
    assessment: {
      ...(workerFlag ? { workerFlag: true } : {}),
      ...(notes ? { notes } : {}),
      ...(c.audio && c.liveTranscript ? { liveTranscript: c.liveTranscript } : {})
    },
    audioDurationSec: c.audioDurationSec
  };
  const triage = triageAssessment(meta);
  try {
    await secure.addToOutbox({ id: meta.id, meta, triage, photo: c.photo, audio: c.audio });
  } catch {
    return showError($('#capture-error'), t('storage_unavailable'));
  }

  if (p?.name) rememberPatient(p);
  state.result = { id: meta.id, localFlag: workerFlag, localLevel: triage.level, localPatient: patient, phase: navigator.onLine ? 'sending' : 'offline', serverCase: null };
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
        if (['done', 'failed', 'disabled', 'skipped'].includes(latest.aiStatus)) return { case: latest, done: true };
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
    if (!result.authError && !result.offline && result.sent.length) refreshPatients();
    if (result.authError) {
      saveSession(null);
      if (await autoLogin()) {
        $('#sign-out').hidden = false;
        loadProfile();
        return result;
      }
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
  checkReplies();
  if (state.view === 'view-home') await renderHome();
  // An open visit picks up the doctor's reply and the medicine bike without leaving the screen.
  if (state.view === 'view-case' && state.openItem?.server) {
    const fresh = state.serverCases?.find((c) => c.id === state.openItem.server.id);
    if (fresh && JSON.stringify(fresh) !== JSON.stringify(state.openItem.server)) {
      state.openItem.server = fresh;
      renderCase();
    }
  }
}

// ---- Offline Gemma helper (on-phone, assist only) ---------------------------------------------
// Gemma only points to signs the note mentions. It never answers the checklist, never flips the danger
// switch and never changes urgency: the rules in /shared/triage.js stay the only source.

let gemmaHelper = null;
const GEMMA_KEY = 'av_gemma';

// Remember the server's Gemma setting so the helper also shows when the app starts offline.
function gemmaConfig() {
  if (state.appConfig) {
    if (state.appConfig.gemma?.modelUrl) localStorage.setItem(GEMMA_KEY, JSON.stringify({ modelUrl: state.appConfig.gemma.modelUrl }));
    else localStorage.removeItem(GEMMA_KEY);
    return state.appConfig;
  }
  try {
    const gemma = JSON.parse(localStorage.getItem(GEMMA_KEY) || 'null');
    return gemma?.modelUrl ? { gemma } : null;
  } catch {
    return null;
  }
}

function checklistSigns() {
  const p = withDays(formPatient()) || {};
  const ctx = patientContext(p);
  return applicableSigns(p)
    .filter((s) => signLevel(s, ctx) === 'URGENT')
    .map((s) => ({ id: s.id, label: signLabel(s.id, getLanguage()), en: signLabel(s.id, 'en') }));
}

function gemmaNotes() {
  const notes = String($('#notes').value || '').trim();
  const english = state.capture?.liveTranscript?.english?.trim();
  return english && !notes.includes(english) ? `${notes}\n${english}` : notes;
}

// Open the danger-sign list and point to the sign. Read-only: nothing is answered for the worker.
function showSign(id) {
  const list = $('#danger-signs-list');
  setChildren(list, dangerSignList());
  list.hidden = false;
  const item = [...list.querySelectorAll('li')].find((li) => li.dataset.sign === id);
  if (!item) return;
  item.classList.add('gemma-highlight');
  item.tabIndex = -1;
  item.scrollIntoView({ block: 'center', behavior: 'smooth' });
  item.focus({ preventScroll: true });
}

function setupGemma() {
  const config = gemmaConfig();
  if (gemmaHelper || !gemmaAvailable(config)) return;
  gemmaHelper = mountGemmaHelper({ container: $('#gemma-helper'), config, getNotes: gemmaNotes, getSigns: checklistSigns, onPick: showSign });
  $('#new-visit').addEventListener('click', () => gemmaHelper.reset());
}

// ---- Language & startup ----------------------------------------------------------------------

function rerender() {
  applyTranslations();
  renderNetwork();
  if (state.view === 'view-capture') {
    $('#take-photo-label').textContent = t(state.capture?.photo ? 'retake_photo' : 'take_photo');
    $('#record-label').textContent = t(state.recorder ? 'stop' : state.capture?.audio ? 'speak_again' : 'speak');
    setChildren($('#danger-signs-list'), dangerSignList());
    gemmaHelper?.render();
  }
  if (state.view === 'view-home') renderHome();
  if (state.view === 'view-capture') {
    buildMonthOptions(Number($('#p-months').value) || null);
    renderPatientStatus();
    if (state.capture?.liveStatus) setLiveStatus(state.capture.liveStatus);
    renderPhotoCheck();
  }
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
  $('#new-visit').addEventListener('click', startVisit);
  $('#patient-toggle').addEventListener('click', () => $('#p-name').focus());
  $('#p-name').addEventListener('input', () => {
    renderPatientStatus();
    renderSuggestions();
    showError($('#patient-error'), '');
  });
  for (const chip of document.querySelectorAll('#p-sex md-filter-chip')) {
    chip.addEventListener('click', () => {
      setSex(chip.dataset.sex);
      renderPatientStatus();
    });
  }
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
  $('#remove-audio').addEventListener('click', () => {
    setAudio(null, null);
    state.capture.liveTranscript = null;
    renderLive(null);
  });
  $('#show-danger-signs').addEventListener('click', () => {
    const list = $('#danger-signs-list');
    setChildren(list, dangerSignList());
    list.hidden = !list.hidden;
  });
  $('#send-case').addEventListener('click', handleSend);
  $('#result-done').addEventListener('click', () => {
    stopReading();
    goHome();
  });
  $('#case-back').addEventListener('click', () => {
    stopReading();
    goHome();
  });
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
  const configReady = loadAppConfig();
  configReady.then(setupGemma);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  if (!state.session) {
    await configReady;
    await autoLogin();
  }
  $('#sign-out').hidden = !state.session;
  // Opened from the doctor dashboard's phone button: a way back.
  $('#back-to-dashboard').hidden = new URLSearchParams(location.search).get('from') !== 'live';
  if (state.session) {
    loadProfile();
    refreshPatients();
    await goHome();
    syncAndRender();
  } else {
    show('view-login');
  }
  setInterval(() => {
    if (state.session && navigator.onLine) syncAndRender();
  }, 20_000);
  // Back in the foreground: check for replies at once.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.session && navigator.onLine) syncAndRender();
  });
  // Tapping a "doctor replied" notification opens that visit.
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'open-case' && e.data.caseId) openCaseById(e.data.caseId);
  });
  const hash = /^#case=([^&]+)$/.exec(location.hash);
  if (hash && state.session) {
    history.replaceState(null, '', location.pathname + location.search);
    syncAndRender().then(() => openCaseById(decodeURIComponent(hash[1])));
  }
  // Keep "your doctor is watching now" fresh.
  setInterval(() => {
    if (state.session && navigator.onLine) loadProfile();
  }, 30_000);
}

start();
