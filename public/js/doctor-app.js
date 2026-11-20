import '/vendor/material.js';
import { applicableSigns, signLabel } from '/shared/dangerSigns.js';
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
const SOURCE_TEXT = { notes: "ASHA's typed note", live_voice: 'ASHA voice, live text (Sarvam)', checklist: 'ASHA', vitals: 'Measured vitals', voice_vitals: 'Stated in voice note, read by AI', age_rule: 'Age rule', ai_voice: 'AI, from voice note', ai_photo: 'AI, from photo', system: 'System' };
const LANG_NAME = { en: 'English', hi: 'Hindi', ta: 'Tamil' };
const VIEWS = ['open', 'responded', 'all'];

const $ = (s) => document.querySelector(s);
const state = {
  session: loadSession(),
  view: 'open',
  selectedId: null,
  seenUrgent: null,
  blobUrls: [],
  pollTimer: null,
  cases: [],
  filters: { q: '', day: null, returning: false, pregnant: false },
  events: null,
  selectedAi: null
};

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

function ageText(p) {
  if (p.ageValue != null && p.ageUnit) return `${p.ageValue} ${p.ageValue === 1 ? p.ageUnit.replace(/s$/, '') : p.ageUnit}`;
  if (p.ageDays != null) return `${p.ageDays} days`;
  return 'age not given';
}

/** "24 years, female, pregnant 7 months" */
function patientMeta(p) {
  const sex = p.sex === 'female' || p.sex === 'male' ? p.sex : null;
  const parts = [ageText(p)];
  if (sex) parts.push(sex);
  if (p.pregnant) parts.push(p.pregnancyMonths ? `pregnant ${p.pregnancyMonths} months` : 'pregnant');
  return parts.join(', ');
}

function patientLine(p) {
  const meta = patientMeta(p);
  return p.name ? `${p.name}, ${meta}` : `${meta[0].toUpperCase()}${meta.slice(1)}${p.reference ? ` (${p.reference})` : ''}`;
}

function patientBadges(p) {
  return el(
    'span',
    { className: 'badges' },
    p.returning ? el('span', { className: 'badge', title: `Returning patient, visit ${p.visit}` }, icon('repeat'), `Visit ${p.visit}`) : null,
    p.pregnant ? el('span', { className: 'badge' }, icon('pregnant_woman'), 'Pregnant') : null
  );
}

const VALUE_SOURCE = { live_voice: 'voice, live text (Gemini Live)', notes: 'typed note', ai_voice: 'voice note, AI', ai_photo: 'photo, AI', voice_vitals: 'stated in voice note, AI', vitals: 'measured', age_rule: 'age rule' };

function withSource(text, source) {
  return VALUE_SOURCE[source] ? `${text} (${VALUE_SOURCE[source]})` : text;
}

function signOut(message = '') {
  setSession(null);
  clearInterval(state.pollTimer);
  state.events?.close();
  state.events = null;
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
  // Behind Firebase Hosting, live events come straight from Cloud Run.
  if (config.eventsUrl && config.eventsUrl !== state.eventsUrl) {
    state.eventsUrl = config.eventsUrl;
    if (state.events) connectEvents();
  }
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
  try {
    const res = await api(`/api/doctor/cases?view=${state.view}`);
    state.cases = (await res.json()).cases;
  } catch {
    return;
  }
  $('#queue-updated').textContent = `Updated ${new Date().toLocaleTimeString('en-IN', { timeStyle: 'short' })}`;
  detectNewUrgent(state.cases);
  renderQueue();
}

function dayStart(offset = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offset);
  return d.getTime();
}

function passesFilters(c) {
  const f = state.filters;
  const at = Date.parse(c.receivedAt);
  if (f.day === 'today' && at < dayStart(0)) return false;
  if (f.day === 'yesterday' && (at < dayStart(1) || at >= dayStart(0))) return false;
  if (f.returning && !c.patient.returning) return false;
  if (f.pregnant && !c.patient.pregnant) return false;
  if (f.q) {
    const hay = `${c.patient.name || ''} ${c.patient.id || ''} ${c.worker.name} ${c.worker.village || ''}`.toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  return true;
}

function renderQueue() {
  const cases = state.cases.filter(passesFilters);
  const list = $('#queue');
  list.replaceChildren();
  $('#queue-empty').hidden = cases.length > 0;
  for (const c of cases) {
    const media = [c.hasPhoto ? 'photo' : null, c.hasAudio ? 'voice' : null].filter(Boolean).join(' + ') || 'note only';
    const when = new Date(c.receivedAt);
    const sameDay = when.getTime() >= dayStart(0);
    const item = el(
      'md-list-item',
      { type: 'button', className: 'queue-item', 'aria-current': String(c.id === state.selectedId), dataset: { caseId: c.id } },
      levelAvatar(c.triage.level),
      el('div', { slot: 'overline' }, LEVEL_TEXT[c.triage.level], patientBadges(c.patient)),
      el('div', { slot: 'headline' }, c.patient.name || patientLine(c.patient)),
      el('div', { slot: 'supporting-text' }, `${c.patient.name ? `${patientMeta(c.patient)}. ` : ''}${c.worker.name}. ${STATUS_TEXT[c.status] || c.status}, ${media}`),
      el('div', { slot: 'trailing-supporting-text' }, sameDay ? when.toLocaleTimeString('en-IN', { timeStyle: 'short' }) : when.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }))
    );
    item.addEventListener('click', () => selectCase(c.id));
    list.append(item);
  }
}

// ---- KPIs ------------------------------------------------------------------------------------

function fmtMinutes(m) {
  if (m == null) return '—';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} days`;
}

async function refreshStats() {
  let s;
  try {
    s = await (await api('/api/doctor/stats')).json();
  } catch {
    return;
  }
  const kpi = (value, label, cls = '') => el('div', { className: `kpi ${cls}` }, el('span', { className: 'kpi__value' }, String(value)), el('span', { className: 'kpi__label md-typescale-body-medium' }, label));
  setChildren(
    $('#kpis'),
    kpi(s.urgentWaiting, 'Urgent, waiting', s.urgentWaiting ? 'kpi--urgent' : ''),
    kpi(s.waiting, 'Waiting for review'),
    kpi(fmtMinutes(s.oldestWaiting?.minutes), s.oldestWaiting ? `Oldest waiting${s.oldestWaiting.name ? `: ${s.oldestWaiting.name}` : ''}` : 'Nothing waiting'),
    kpi(s.repliedToday, 'Replied today'),
    kpi(fmtMinutes(s.medianReplyMinutes), 'Typical reply time today'),
    kpi(s.receivedToday, 'New cases today')
  );
}

// ---- Live updates (server-sent events) -------------------------------------------------------

function setLive(on) {
  const badge = $('#live-badge');
  badge.classList.toggle('live', on);
  badge.classList.toggle('offline', !on);
  $('#live-text').textContent = on ? 'Live' : 'Reconnecting';
}

function connectEvents() {
  state.events?.close();
  if (!state.session || !('EventSource' in window)) return;
  const es = new EventSource(`${state.eventsUrl || ''}/api/doctor/events?token=${encodeURIComponent(state.session.token)}`);
  state.events = es;
  es.onopen = () => setLive(true);
  es.onerror = () => setLive(false);
  const onChange = (e) => {
    let data = {};
    try {
      data = JSON.parse(e.data);
    } catch {
      // ignore malformed events
    }
    refreshQueue();
    refreshStats();
    // Refresh an open case when its AI summary arrives (never while the doctor is typing a decision).
    if (data.caseId && data.caseId === state.selectedId && e.type === 'case.triaged' && state.selectedAi !== 'done') selectCase(data.caseId);
  };
  for (const type of ['case.created', 'case.triaged', 'case.decided']) es.addEventListener(type, onChange);
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
        describeReason(r, 'en', { forDoctor: true }),
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
  if (ai.status === 'skipped') return card('AI summary', 'star_shine', el('p', { className: 'on-surface-variant' }, ai.reason || 'No AI summary for this case. Review the raw inputs.'));
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
    o.safetyRemoved ? el('p', { className: 'md-typescale-body-small on-surface-variant' }, `${o.safetyRemoved} AI sentence(s) naming a condition were removed by the no-diagnosis filter.`) : null,
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

function liveTranscriptCard(record) {
  const live = record.assessment?.liveTranscript;
  if (!live) return null;
  const same = !live.english || live.english.trim().toLowerCase() === live.original.trim().toLowerCase();
  return card(
    'Live transcript',
    'graphic_eq',
    el('p', { className: 'md-typescale-body-small on-surface-variant' }, `AI-generated: written while the ASHA spoke, by Gemini Live${live.model ? ` (${live.model})` : ''}, translated by Gemini. May contain errors: the voice note is the source of truth.${live.language ? ` Language: ${live.language}.` : ''}`),
    el('div', { className: 'transcript' }, live.original),
    same ? null : el('h3', { className: 'md-typescale-title-small' }, 'English'),
    same ? null : el('div', { className: 'transcript' }, live.english),
    live.followUp ? el('h3', { className: 'md-typescale-title-small' }, 'Follow-up questions Gemini asked (spoken)') : null,
    live.followUp ? el('div', { className: 'transcript' }, live.followUp) : null
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
  const items = applicableSigns(record.patient).map((s) => {
    const entry = signs[s.id] || { state: 'unknown' };
    const text = entry.state === 'unknown' ? 'Not mentioned' : entry.state === 'yes' ? 'Yes' : 'No';
    return el('div', { className: 'item md-typescale-body-medium' }, el('span', {}, s.label.en), el('span', { className: `state-${entry.state}` }, withSource(text, entry.source)));
  });
  const a = record.assessment;
  const p = record.patient;
  return card(
    'Patient, danger signs and vitals',
    'fact_check',
    el('p', { className: 'md-typescale-body-small on-surface-variant' }, 'Values marked "AI" were read from the voice note or photo by Gemini. Confirm them with the ASHA.'),
    el(
      'dl',
      { className: 'kv md-typescale-body-medium' },
      el('dt', {}, 'Age'),
      el('dd', {}, p.ageValue != null || p.ageDays != null ? withSource(ageText(p), auto.ageDays) : 'Not given'),
      el('dt', {}, 'Sex'),
      el('dd', {}, p.sex === 'female' || p.sex === 'male' ? withSource(p.sex, auto.sex) : 'Not given'),
      ...(p.sex === 'female' ? [el('dt', {}, 'Pregnant'), el('dd', {}, p.pregnant ? (p.pregnancyMonths ? `Yes, ${p.pregnancyMonths} months` : 'Yes') : 'No')] : []),
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

function ashaCard(record, asha) {
  return card(
    'ASHA and place',
    'location_on',
    el(
      'dl',
      { className: 'kv md-typescale-body-medium' },
      el('dt', {}, 'ASHA'),
      el('dd', {}, `${asha?.name || record.worker.name}, speaks ${LANG_NAME[record.language]}`),
      ...(asha
        ? [
            el('dt', {}, 'Village'),
            el('dd', {}, [asha.village, asha.block, asha.district, asha.state].filter(Boolean).join(', ')),
            el('dt', {}, 'Nearest PHC'),
            el('dd', {}, asha.phc || 'Not recorded')
          ]
        : [])
    )
  );
}

function stepsCard(record) {
  const ws = record.workerSteps;
  if (!ws?.en?.length) return null;
  const lang = ws[record.language] ? record.language : 'en';
  return card(
    'What the ASHA was told to do',
    'fact_check',
    el('p', { className: 'md-typescale-body-small on-surface-variant' }, `Curated steps from "${ws.title}", shown on her phone in ${LANG_NAME[lang]} with read-aloud. No medicines or doses.`),
    el('ol', { className: 'steps md-typescale-body-medium' }, ...ws.en.map((s) => el('li', {}, s))),
    lang !== 'en' ? el('ol', { className: 'steps md-typescale-body-small on-surface-variant' }, ...ws[lang].map((s) => el('li', {}, s))) : null
  );
}

async function historyCard(record) {
  const body = el('div', { className: 'history-list' }, el('p', { className: 'on-surface-variant' }, 'Loading…'));
  const node = card('Patient history', 'history', body);
  if (!record.patient?.id) {
    setChildren(body, el('p', { className: 'on-surface-variant' }, 'No patient record (case sent without patient details).'));
    return node;
  }
  try {
    const res = await api(`/api/doctor/patients/${encodeURIComponent(record.patient.id)}/cases`);
    const { patient, history } = await res.json();
    const earlier = history.filter((h) => h.id !== record.id);
    setChildren(
      body,
      el('p', { className: 'md-typescale-body-medium on-surface-variant' }, `Patient ID ${patient.id}. ${patient.visits} visit(s) since ${formatDate(patient.firstSeen)}.`),
      earlier.length
        ? earlier.map((h) =>
            el(
              'button',
              { type: 'button', className: 'history-item', style: 'border:0;text-align:left;cursor:pointer;color:inherit;font:inherit' },
              levelLabel(h.level),
              el(
                'div',
                { className: 'history-item__body' },
                el('span', { className: 'md-typescale-title-small' }, formatDate(h.receivedAt)),
                el('span', { className: 'md-typescale-body-medium' }, h.signs.length ? h.signs.map((id) => signLabel(id)).join('; ') : 'No danger sign recorded'),
                el(
                  'span',
                  { className: 'md-typescale-body-small on-surface-variant' },
                  h.decision ? `${OUTCOMES.find(([v]) => v === h.decision.outcome)?.[1] || h.decision.outcome}: ${h.decision.instructions}` : 'Not reviewed yet'
                )
              )
            )
          )
        : el('p', { className: 'md-typescale-body-medium' }, 'First visit: no earlier cases for this patient.')
    );
    earlier.forEach((h, i) => body.querySelectorAll('.history-item')[i]?.addEventListener('click', () => selectCase(h.id)));
  } catch {
    setChildren(body, el('p', { className: 'on-surface-variant' }, 'Could not load the history.'));
  }
  return node;
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

// Supplementary passages retrieved from the guideline PDFs (Vertex AI RAG Engine). Not authoritative.
function passagesCard(record) {
  const passages = record.guidelinePassages;
  if (!passages?.length) return null;
  return card(
    'Related passages from guideline PDFs',
    'find_in_page',
    el('p', { className: 'md-typescale-body-small on-surface-variant' }, 'Retrieved automatically by Vertex AI RAG Engine. Verify against the source document; the references above are the curated citations.'),
    ...passages.map((p) =>
      el(
        'div',
        { className: 'guideline' },
        el('p', { className: 'md-typescale-body-medium' }, p.text),
        el('p', { className: 'source md-typescale-body-small' }, `Source: ${p.source}`)
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
  const { case: record, asha, guidelineNotice } = await res.json();
  state.selectedAi = record.ai?.status || 'pending';
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
        el('dt', {}, 'Patient'),
        el('dd', {}, record.patient.id ? `${record.patient.id}, ${record.patient.returning ? `returning, visit ${record.patient.visit}` : 'first visit'}` : 'Not registered'),
        el('dt', {}, 'ASHA'),
        el('dd', {}, `${asha?.name || record.worker.name}${asha?.village ? `, ${asha.village}` : ''}, speaks ${LANG_NAME[record.language]}`),
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
    liveTranscriptCard(record),
    transcriptCard(record),
    checklistCard(record),
    await historyCard(record),
    stepsCard(record),
    guidelinesCard(record, guidelineNotice),
    passagesCard(record),
    ashaCard(record, asha),
    decisionCard(record),
    fhirRow(record),
    card('History', 'history', el('ul', { className: 'history md-typescale-body-small' }, ...record.history.map((h) => el('li', {}, `${formatDate(h.at)}: ${h.event.replaceAll('_', ' ')} (${h.by})`))))
  );
}

function fhirRow(record) {
  const button = el('md-outlined-button', { type: 'button' }, icon('download', { slot: 'icon' }), 'Download FHIR record');
  button.addEventListener('click', async () => {
    const res = await api(`/api/doctor/cases/${record.id}/fhir`);
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    const a = el('a', { href: url, download: `case-${record.id}.fhir.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  return el(
    'div',
    { className: 'row' },
    button,
    el('span', { className: 'md-typescale-body-small on-surface-variant' }, 'FHIR R4 bundle (Patient, Encounter, Observations, Flag, Media) for ABDM readiness.')
  );
}

// ---- Startup ---------------------------------------------------------------------------------

/** Deep link from the block live view: /doctor#case=<id> opens that case. */
function openCaseFromHash() {
  const m = /^#case=([^&]+)$/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, '', location.pathname);
  selectCase(decodeURIComponent(m[1]));
}

function startDashboard() {
  $('#doctor-name').textContent = state.session.user.name;
  $('#sign-out').hidden = false;
  show('view-dash');
  refreshQueue().then(openCaseFromHash);
  refreshStats();
  connectEvents();
  clearInterval(state.pollTimer);
  // Live events do the work; this slow poll is only a safety net.
  state.pollTimer = setInterval(() => {
    refreshQueue();
    refreshStats();
  }, 30_000);
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
  $('#queue-search').addEventListener('input', (e) => {
    state.filters.q = String(e.target.value || '').trim().toLowerCase();
    renderQueue();
  });
  for (const chip of document.querySelectorAll('#queue-chips md-filter-chip[data-day]')) {
    chip.addEventListener('click', () => {
      const day = chip.dataset.day;
      state.filters.day = state.filters.day === day ? null : day;
      for (const c of document.querySelectorAll('#queue-chips md-filter-chip[data-day]')) c.selected = c.dataset.day === state.filters.day;
      renderQueue();
    });
  }
  $('#filter-returning').addEventListener('click', () => {
    state.filters.returning = $('#filter-returning').selected;
    renderQueue();
  });
  $('#filter-pregnant').addEventListener('click', () => {
    state.filters.pregnant = $('#filter-pregnant').selected;
    renderQueue();
  });
}

/** Demo auto sign-in (no access code) when the server allows it. */
async function autoLogin() {
  try {
    const config = await (await fetch('/api/config')).json();
    if (!config.autoLogin) return false;
    const res = await fetch('/api/login/auto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'doctor' }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.user?.role !== 'doctor') return false;
    setSession({ token: body.token, user: body.user });
    return true;
  } catch {
    return false;
  }
}

hydrateIcons();
bind();
loadConfig().catch(() => {});
if (state.session) startDashboard();
else autoLogin().then((ok) => (ok ? startDashboard() : show('view-login')));
