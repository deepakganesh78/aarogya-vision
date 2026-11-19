import '/vendor/material.js';
import { DANGER_SIGNS, signLabel } from '/shared/dangerSigns.js';
import { describeReason } from '/shared/triage.js';
import { appendChildren, el, formatDate, setChildren } from './dom.js';
import { hydrateIcons, icon } from './icons.js';

const SESSION_KEY = 'av_doctor_session';
const LEVEL_TEXT = { URGENT: 'Urgent', PRIORITY: 'Review today', ROUTINE: 'Routine' };
const LEVEL_ICON = { URGENT: 'error', PRIORITY: 'warning', ROUTINE: 'check_circle' };
const STATUS_TEXT = { received: 'Received', processing: 'AI summary in progress', awaiting_review: 'Awaiting review', responded: 'Responded' };
const OUTCOMES = [
  ['refer_now', 'Refer now to a facility'],
  ['home_care_follow_up', 'Home care with follow-up visit'],
  ['need_more_info', 'Need more information from the ASHA'],
  ['no_action', 'No further action']
];
const SOURCE_TEXT = { checklist: 'ASHA', vitals: 'Measured vitals', voice_vitals: 'Stated in voice note, read by AI', age_rule: 'Age rule', ai_voice: 'AI, from voice note', ai_photo: 'AI, from photo', system: 'System' };
const LANG_NAME = { en: 'English', hi: 'Hindi', ta: 'Tamil' };
const VIEWS = ['open', 'responded', 'all'];

const $ = (s) => document.querySelector(s);
const state = { session: loadSession(), view: 'open', selectedId: null, seenUrgent: null, blobUrls: [], pollTimer: null };

function loadSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY));
    return s?.token && s.user?.role === 'doctor' ? s : null;
  } catch {
    return null;
  }
}

function setSession(session) {
  state.session = session;
  if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else sessionStorage.removeItem(SESSION_KEY);
}

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${state.session.token}` } });
  if (res.status === 401) {
    signOut('Your session expired. Please sign in again.');
    throw new Error('unauthorized');
  }
  return res;
}

function show(id) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== id;
}

function patientLine(p) {
  const who = p.sex === 'female' || p.sex === 'male' ? p.sex : 'infant';
  const age = p.ageDays != null ? `${p.ageDays}-day-old ${who}` : `${who === 'infant' ? 'Infant' : who[0].toUpperCase() + who.slice(1)}, age not given`;
  return `${age}${p.reference ? ` (${p.reference})` : ''}`;
}

const VALUE_SOURCE = { ai_voice: 'voice note, AI', ai_photo: 'photo, AI', voice_vitals: 'stated in voice note, AI', vitals: 'measured', age_rule: 'age rule' };

function withSource(text, source) {
  return VALUE_SOURCE[source] ? `${text} (${VALUE_SOURCE[source]})` : text;
}

function signOut(message = '') {
  setSession(null);
  clearInterval(state.pollTimer);
  revokeBlobs();
  $('#sign-out').hidden = true;
  $('#doctor-name').textContent = '';
  const err = $('#login-error');
  err.textContent = message;
  err.hidden = !message;
  show('view-login');
}

async function handleLogin(event) {
  event.preventDefault();
  const err = $('#login-error');
  err.hidden = true;
  const field = $('#access-code');
  const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: String(field.value).trim() }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.user?.role !== 'doctor') {
    err.textContent = 'That code did not work for a doctor account.';
    err.hidden = false;
    return;
  }
  setSession({ token: body.token, user: body.user });
  field.value = '';
  startDashboard();
}

async function loadConfig() {
  const res = await fetch('/api/config');
  const config = await res.json();
  const ai = config.ai;
  const text = ai.provider === 'gemini' ? `Gemini: ${ai.model}` : ai.provider === 'mock' ? 'AI: MOCK stub (no model)' : 'AI: off';
  $('#ai-badge-text').textContent = text;
  $('#ai-badge').classList.toggle('offline', ai.provider !== 'gemini');
  $('#prototype-banner').textContent = config.notice;
}

// ---- Queue -----------------------------------------------------------------------------------

function levelAvatar(level, slot = 'start') {
  return el('span', { slot, className: `level-avatar level-${level}` }, icon(LEVEL_ICON[level], { filled: true }));
}

function levelLabel(level) {
  return el('span', { className: `level-label level-${level}` }, LEVEL_TEXT[level]);
}

async function refreshQueue() {
  let cases;
  try {
    const res = await api(`/api/doctor/cases?view=${state.view}`);
    cases = (await res.json()).cases;
  } catch {
    return;
  }
  $('#queue-updated').textContent = `Updated ${new Date().toLocaleTimeString('en-IN', { timeStyle: 'short' })}`;
  detectNewUrgent(cases);

  const list = $('#queue');
  list.replaceChildren();
  $('#queue-empty').hidden = cases.length > 0;
  for (const c of cases) {
    const media = [c.hasPhoto ? 'photo' : null, c.hasAudio ? 'voice' : null].filter(Boolean).join(' + ') || 'checklist only';
    const item = el(
      'md-list-item',
      { type: 'button', className: 'queue-item', 'aria-current': String(c.id === state.selectedId), dataset: { caseId: c.id } },
      levelAvatar(c.triage.level),
      el('div', { slot: 'overline' }, LEVEL_TEXT[c.triage.level]),
      el('div', { slot: 'headline' }, patientLine(c.patient)),
      el('div', { slot: 'supporting-text' }, `${c.worker.name}. ${STATUS_TEXT[c.status] || c.status}, AI ${c.aiStatus}, ${media}`),
      el('div', { slot: 'trailing-supporting-text' }, new Date(c.receivedAt).toLocaleTimeString('en-IN', { timeStyle: 'short' }))
    );
    item.addEventListener('click', () => selectCase(c.id));
    list.append(item);
  }
}

function detectNewUrgent(cases) {
  const urgent = cases.filter((c) => c.triage.level === 'URGENT' && c.status !== 'responded');
  if (state.seenUrgent) {
    const fresh = urgent.filter((c) => !state.seenUrgent.has(c.id));
    if (fresh.length) {
      $('#alert-text').textContent = `New urgent case${fresh.length > 1 ? 's' : ''} from ${fresh.map((c) => c.worker.name).join(', ')}`;
      $('#alert-banner').hidden = false;
      document.title = '(!) Aarogya-Vision · Doctor review';
    }
  }
  state.seenUrgent = new Set([...(state.seenUrgent || []), ...urgent.map((c) => c.id)]);
}

// ---- Case detail -----------------------------------------------------------------------------

function revokeBlobs() {
  for (const url of state.blobUrls) URL.revokeObjectURL(url);
  state.blobUrls = [];
}

async function loadMedia(id, kind) {
  const res = await api(`/api/doctor/cases/${id}/media/${kind}`);
  if (!res.ok) return null;
  const url = URL.createObjectURL(await res.blob());
  state.blobUrls.push(url);
  return url;
}

function card(title, iconName, ...children) {
  return el(
    'md-outlined-card',
    { className: 'card' },
    el('div', { className: 'card-body' }, el('h2', { className: 'card-title md-typescale-title-medium' }, icon(iconName), title), ...children)
  );
}

function aiChip(record) {
  return el('span', { className: 'ai-chip' }, icon('star_shine'), record.ai.provider === 'mock' ? 'AI-generated, MOCK' : `AI-generated, ${record.ai.model}`);
}

function reasonsCard(record) {
  const items = record.triage.reasons
    .filter((r) => r.level)
    .map((r) =>
      el(
        'li',
        {},
        levelLabel(r.level),
        ' ',
        describeReason(r, 'en'),
        el('span', { className: 'on-surface-variant' }, ` (${SOURCE_TEXT[r.source] || r.source})`),
        r.verify ? el('span', { className: 'verify' }, ' Verify.') : null,
        r.evidence ? el('div', { className: 'md-typescale-body-small on-surface-variant' }, `Evidence: ${r.evidence}`) : null
      )
    );
  const incomplete = record.triage.incomplete || [];
  return card(
    'Why this urgency',
    'fact_check',
    el('p', { className: 'md-typescale-body-small on-surface-variant' }, `Deterministic rules (${record.triage.rulesVersion}). AI findings can raise the level but never lower it.`),
    items.length ? el('ul', { className: 'reasons md-typescale-body-medium' }, ...items) : el('p', {}, 'No danger sign recorded.'),
    incomplete.length ? el('p', { className: 'md-typescale-body-medium' }, el('strong', {}, 'Not mentioned yet: '), incomplete.map((id) => signLabel(id)).join('; ')) : null
  );
}

function aiCard(record) {
  const ai = record.ai || { status: 'pending' };
  if (ai.status === 'pending' || ai.status === 'processing') {
    return card('AI summary', 'star_shine', el('md-linear-progress', { indeterminate: true }), el('p', { className: 'on-surface-variant' }, 'Preparing the summary. The photo, voice note and checklist are available now.'));
  }
  if (ai.status === 'disabled') return card('AI summary', 'star_shine', el('p', { className: 'on-surface-variant' }, 'AI is not configured on this server. Review the raw inputs.'));
  if (ai.status === 'failed') {
    const retry = el('md-outlined-button', {}, icon('refresh', { slot: 'icon' }), 'Retry AI summary');
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      await api(`/api/doctor/cases/${record.id}/reprocess`, { method: 'POST' });
      setTimeout(() => selectCase(record.id), 1500);
    });
    return card(
      'AI summary',
      'star_shine',
      el('div', { className: 'error-banner' }, icon('error'), `AI summary unavailable: ${ai.error}`),
      el('p', {}, 'Review the photo and voice note directly.'),
      el('div', { className: 'row' }, retry)
    );
  }
  const o = ai.output;
  return card(
    'AI summary',
    'star_shine',
    el('div', { className: 'row' }, aiChip(record)),
    el('p', { className: 'md-typescale-body-large' }, o.summaryForDoctor),
    o.missingInformation.length
      ? el('div', {}, el('h3', { className: 'md-typescale-title-small' }, 'Missing information'), el('ul', { className: 'reasons' }, ...o.missingInformation.map((m) => el('li', {}, m))))
      : null,
    o.followUpQuestions.length
      ? el(
          'div',
          {},
          el('h3', { className: 'md-typescale-title-small' }, 'Suggested follow-up questions'),
          el('ul', { className: 'reasons' }, ...o.followUpQuestions.map((q) => el('li', {}, q.english, el('div', { className: 'md-typescale-body-small on-surface-variant' }, q.workerLanguage))))
        )
      : null,
    o.photoObservations.length
      ? el(
          'div',
          {},
          el('h3', { className: 'md-typescale-title-small' }, `Photo observations (quality: ${o.photoQuality})`),
          el('ul', { className: 'reasons' }, ...o.photoObservations.map((p) => el('li', {}, p)))
        )
      : null,
    o.uncertaintyNotes ? el('p', { className: 'on-surface-variant' }, el('strong', {}, 'Uncertainty: '), o.uncertaintyNotes) : null
  );
}

function transcriptCard(record) {
  const o = record.ai?.output;
  if (!o || (!o.transcriptOriginal && !o.transcriptEnglish)) return null;
  return card(
    'Voice note transcript',
    'graphic_eq',
    el('div', { className: 'row' }, aiChip(record), el('span', { className: 'md-typescale-body-small on-surface-variant' }, `Detected language: ${o.languageDetected}`)),
    el('div', { className: 'transcript' }, o.transcriptOriginal),
    el('h3', { className: 'md-typescale-title-small' }, 'English'),
    el('div', { className: 'transcript' }, o.transcriptEnglish)
  );
}

function checklistCard(record) {
  const signs = record.triage.signs || {};
  const auto = record.autofill || {};
  const items = DANGER_SIGNS.map((s) => {
    const entry = signs[s.id] || { state: 'unknown' };
    const text = entry.state === 'unknown' ? 'Not mentioned' : entry.state === 'yes' ? 'Yes' : 'No';
    return el('div', { className: 'item md-typescale-body-medium' }, el('span', {}, s.label.en), el('span', { className: `state-${entry.state}` }, withSource(text, entry.source)));
  });
  const a = record.assessment;
  const p = record.patient;
  return card(
    'Danger signs and vitals',
    'fact_check',
    el('p', { className: 'md-typescale-body-small on-surface-variant' }, 'Values marked "AI" were read from the voice note or photo by Gemini. Confirm them with the ASHA.'),
    el(
      'dl',
      { className: 'kv md-typescale-body-medium' },
      el('dt', {}, 'Age'),
      el('dd', {}, p.ageDays != null ? withSource(`${p.ageDays} days`, auto.ageDays) : 'Not given'),
      el('dt', {}, 'Temperature'),
      el('dd', {}, a.temperatureC != null ? withSource(`${a.temperatureC} °C`, auto.temperatureC || 'vitals') : 'Not given'),
      el('dt', {}, 'Breaths per minute'),
      el('dd', {}, a.breathsPerMin != null ? withSource(String(a.breathsPerMin), auto.breathsPerMin || 'vitals') : 'Not given'),
      el('dt', {}, 'ASHA danger switch'),
      el('dd', {}, a.workerFlag ? 'On: ASHA saw a danger sign' : 'Off'),
      el('dt', {}, 'Consent'),
      el('dd', {}, `Verbal, given by ${record.consent.givenBy.replace('_', ' ')}, ${formatDate(record.consent.at)}`)
    ),
    el('div', { className: 'checklist' }, ...items),
    a.notes ? el('p', { className: 'md-typescale-body-medium' }, el('strong', {}, 'Typed note: '), a.notes) : null
  );
}

function guidelinesCard(record, notice) {
  if (!record.guidelines?.length) return card('Guideline references', 'menu_book', el('p', { className: 'on-surface-variant' }, 'No guideline matched yet.'));
  return card(
    'Guideline references',
    'menu_book',
    el('p', { className: 'md-typescale-body-small on-surface-variant' }, notice),
    ...record.guidelines.map((g) =>
      el(
        'div',
        { className: 'guideline' },
        el('h3', { className: 'md-typescale-title-small' }, g.title),
        el('p', { className: 'md-typescale-body-medium' }, g.summary),
        el('p', { className: 'md-typescale-body-medium' }, el('em', {}, g.action)),
        el(
          'p',
          { className: 'source md-typescale-body-small' },
          `Source: ${g.source.publisher}, ${g.source.document}${g.source.year ? ` (${g.source.year})` : ''}. `,
          g.source.url?.startsWith('https://') ? el('a', { href: g.source.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open source') : null
        )
      )
    )
  );
}

function decisionCard(record) {
  const body = el('div', { className: 'card-body' }, el('h2', { className: 'card-title md-typescale-title-medium' }, icon('send'), record.decision ? 'Your decision' : 'Record your decision'));
  if (record.decision) {
    const d = record.decision;
    appendChildren(
      body,
      el('p', { className: 'md-typescale-title-medium' }, OUTCOMES.find(([v]) => v === d.outcome)?.[1] || d.outcome),
      el('p', { className: 'transcript' }, d.instructions),
      d.translated
        ? el(
            'div',
            { className: 'stack-sm' },
            el('p', { className: 'md-typescale-title-small' }, `What the ASHA sees (${LANG_NAME[d.translated.lang]}, machine-translated by ${d.translated.provider === 'mock' ? 'MOCK' : d.translated.model})`),
            el('p', { className: 'transcript' }, d.translated.text)
          )
        : d.translationError
          ? el('div', { className: 'error-banner' }, icon('error'), `Translation failed (${d.translationError}). The ASHA sees your original text.`)
          : null,
      d.followUpDate ? el('p', {}, `Follow-up: ${d.followUpDate}`) : null,
      el('p', { className: 'md-typescale-body-small on-surface-variant' }, `${d.by.name}, ${formatDate(d.at)}`),
      el('md-divider', {})
    );
  }

  const form = el('form', { className: 'stack' });
  const radios = el(
    'div',
    { className: 'radio-list', role: 'radiogroup', 'aria-label': 'Outcome' },
    ...OUTCOMES.map(([value, label], i) =>
      el('label', { className: 'radio-row md-typescale-body-large' }, el('md-radio', { id: `outcome-${value}`, name: 'outcome', value, checked: i === 0 && !record.decision }), label)
    )
  );
  const translationNote = record.language !== 'en' ? ` The ASHA sees a machine translation into ${LANG_NAME[record.language]} with your original text.` : '';
  const instructions = el('md-outlined-text-field', {
    id: 'instructions',
    type: 'textarea',
    rows: 4,
    maxLength: 1500,
    required: true,
    label: 'Instructions for the ASHA',
    supportingText: `Clear next steps.${translationNote}`
  });
  const followUp = el('md-outlined-text-field', { id: 'follow-up', type: 'date', label: 'Follow-up date', supportingText: 'Optional' });
  const error = el('div', { className: 'error-banner', role: 'alert', hidden: true });
  const submit = el('md-filled-button', { type: 'submit', id: 'send-decision' }, icon('send', { slot: 'icon' }), record.decision ? 'Update decision' : 'Send to ASHA');
  appendChildren(form, el('h3', { className: 'md-typescale-title-small' }, 'Outcome'), radios, instructions, followUp, error, el('div', { className: 'row' }, submit));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const outcome = [...form.querySelectorAll('md-radio')].find((r) => r.checked)?.value;
    const text = String(instructions.value || '').trim();
    if (!outcome || !text) {
      error.textContent = 'Choose an outcome and write instructions.';
      error.hidden = false;
      return;
    }
    submit.disabled = true;
    const res = await api(`/api/doctor/cases/${record.id}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcome, instructions: text, followUpDate: followUp.value || null })
    });
    submit.disabled = false;
    if (!res.ok) {
      error.textContent = 'Could not save the decision. Try again.';
      error.hidden = false;
      return;
    }
    await selectCase(record.id);
    refreshQueue();
  });
  body.append(form);
  return el('md-outlined-card', { className: 'card' }, body);
}

async function selectCase(id) {
  state.selectedId = id;
  for (const item of document.querySelectorAll('.queue-item')) item.setAttribute('aria-current', String(item.dataset.caseId === id));
  const res = await api(`/api/doctor/cases/${id}`);
  if (!res.ok) return;
  const { case: record, guidelineNotice } = await res.json();
  revokeBlobs();
  const [photoUrl, audioUrl] = await Promise.all([
    record.media.photo ? loadMedia(id, 'photo') : null,
    record.media.audio ? loadMedia(id, 'audio') : null
  ]);

  setChildren(
    $('#detail'),
    el(
      'div',
      { className: `level-surface level-${record.triage.level}` },
      el('div', { className: 'level-heading' }, icon(LEVEL_ICON[record.triage.level], { filled: true }), el('h1', { className: 'md-typescale-headline-small' }, `${LEVEL_TEXT[record.triage.level]}: ${patientLine(record.patient)}`)),
      el(
        'dl',
        { className: 'kv md-typescale-body-medium' },
        el('dt', {}, 'ASHA'),
        el('dd', {}, `${record.worker.name}, speaks ${LANG_NAME[record.language]}`),
        el('dt', {}, 'Captured'),
        el('dd', {}, formatDate(record.capturedAt)),
        el('dt', {}, 'Status'),
        el('dd', {}, STATUS_TEXT[record.status] || record.status)
      )
    ),
    el('div', { className: 'safety-note md-typescale-body-medium' }, icon('verified_user'), 'AI output is a documentation aid and may be wrong. Check it against the photo, voice note and checklist. You make the clinical decision.'),
    reasonsCard(record),
    el(
      'div',
      { className: 'detail-grid' },
      card('Photo', 'image', photoUrl ? el('img', { className: 'media-photo', src: photoUrl, alt: 'Photo taken by the ASHA worker' }) : el('p', { className: 'on-surface-variant' }, 'No photo')),
      card(
        'Voice note',
        'mic',
        audioUrl ? el('audio', { controls: true, src: audioUrl }) : el('p', { className: 'on-surface-variant' }, 'No voice note'),
        record.audioDurationSec ? el('p', { className: 'md-typescale-body-small on-surface-variant' }, `${record.audioDurationSec} seconds`) : null
      )
    ),
    aiCard(record),
    transcriptCard(record),
    checklistCard(record),
    guidelinesCard(record, guidelineNotice),
    decisionCard(record),
    card('History', 'history', el('ul', { className: 'history md-typescale-body-small' }, ...record.history.map((h) => el('li', {}, `${formatDate(h.at)}: ${h.event.replaceAll('_', ' ')} (${h.by})`))))
  );
}

// ---- Startup ---------------------------------------------------------------------------------

function startDashboard() {
  $('#doctor-name').textContent = state.session.user.name;
  $('#sign-out').hidden = false;
  show('view-dash');
  refreshQueue();
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(refreshQueue, 10_000);
}

function bind() {
  $('#login-form').addEventListener('submit', handleLogin);
  $('#sign-out').addEventListener('click', () => signOut());
  $('#alert-dismiss').addEventListener('click', () => {
    $('#alert-banner').hidden = true;
    document.title = 'Aarogya-Vision · Doctor review';
  });
  $('#queue-tabs').addEventListener('change', (e) => {
    state.view = VIEWS[e.target.activeTabIndex] || 'open';
    refreshQueue();
  });
}

hydrateIcons();
bind();
loadConfig().catch(() => {});
if (state.session) startDashboard();
else show('view-login');
