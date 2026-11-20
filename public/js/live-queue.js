// Bridge from the live view to the real doctor queue. It shares the doctor console's session (same
// sessionStorage key as doctor-app.js), so a doctor signed in to the console can open Live view in the
// same tab; the live view can also sign in itself. It reads the open cases, the queue figures and the
// doctor's profile, listens to the console's live events (which also tells ASHA workers that this doctor
// is watching), and lets the side panel load a full case, its media, and send the doctor's decision.
// Without a session the live view stays on synthetic data only.
const SESSION_KEY = 'av_doctor_session';

function loadSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY));
    return s?.token && s.user?.role === 'doctor' ? s : null;
  } catch {
    return null;
  }
}

/** Open case from GET /api/doctor/cases in the shape the simulation mirrors onto a home. */
export function toExternalCase(c) {
  return {
    id: c.id,
    level: c.triage?.level || 'PRIORITY',
    status: c.status,
    receivedAt: c.receivedAt,
    workerId: c.worker?.id || null,
    workerName: c.worker?.name || null,
    village: c.worker?.village || c.patient?.village || null,
    patient: c.patient || null,
    reasons: c.triage?.reasons || [],
    aiStatus: c.aiStatus || null,
    hasPhoto: Boolean(c.hasPhoto),
    hasAudio: Boolean(c.hasAudio)
  };
}

/**
 * @param {{onCases: Function, onStats: Function, onProfile: Function, onStatus: Function, onAshas?: Function, onEvent?: Function}} handlers
 * onStatus receives 'demo' (no session), 'connecting', 'live', 'offline' or 'expired'.
 */
export function connectDoctorQueue(handlers) {
  const { onCases, onStats, onProfile, onStatus, onAshas = () => {}, onEvent = () => {} } = handlers;
  let session = null;
  let events = null;
  let timer = null;
  let pending = null;
  let stopped = true;

  async function request(path, options = {}) {
    if (!session) throw new Error('not_signed_in');
    const res = await fetch(path, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${session.token}` } });
    if (res.status === 401) {
      stop();
      sessionStorage.removeItem(SESSION_KEY);
      session = null;
      onStatus('expired');
      // Demo auto sign-in: start again with a fresh session (shows "Sign in again" if it is off).
      start({ failStatus: 'expired' });
      throw new Error('unauthorized');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }
  const getJson = async (path) => (await request(path)).json();

  async function refresh() {
    if (stopped) return;
    try {
      const [cases, stats] = await Promise.all([getJson('/api/doctor/cases?view=open'), getJson('/api/doctor/stats')]);
      onCases(cases.cases.map(toExternalCase));
      onStats(stats);
      onStatus(events?.readyState === 1 ? 'live' : 'connecting');
      getJson('/api/doctor/ashas')
        .then((r) => onAshas(r.ashas))
        .catch(() => {});
    } catch {
      if (!stopped && session) onStatus('offline');
    }
  }
  // Several events can arrive together (created, then triaged); refresh once for the burst.
  const soon = () => {
    clearTimeout(pending);
    pending = setTimeout(refresh, 300);
  };

  function stop() {
    stopped = true;
    events?.close();
    events = null;
    clearInterval(timer);
  }

  // /api/config, read once: auto sign-in, and where live events come from (Cloud Run directly behind Firebase Hosting).
  let configPromise = null;
  const appConfig = () => (configPromise ||= fetch('/api/config').then((r) => r.json()).catch(() => ({})));

  /** Demo auto sign-in (no access code) when the server allows it. */
  async function autoSignIn() {
    try {
      const config = await appConfig();
      if (!config.autoLogin) return false;
      const res = await fetch('/api/login/auto', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'doctor' }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.user?.role !== 'doctor') return false;
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: body.token, user: body.user }));
      return true;
    } catch {
      return false;
    }
  }

  async function start({ auto = true, failStatus = 'demo' } = {}) {
    session = loadSession();
    if (!session && auto && (await autoSignIn())) session = loadSession();
    if (!session) {
      onStatus(failStatus);
      return;
    }
    stopped = false;
    onStatus('connecting');
    getJson('/api/profile')
      .then((p) => onProfile(p))
      .catch(() => {});
    const eventsBase = (await appConfig()).eventsUrl || '';
    if (stopped) return;
    if ('EventSource' in window) {
      events = new EventSource(`${eventsBase}/api/doctor/events?token=${encodeURIComponent(session.token)}`);
      events.addEventListener('open', () => onStatus('live'));
      events.addEventListener('error', () => !stopped && onStatus('offline'));
      for (const type of ['case.created', 'case.triaged', 'case.decided', 'case.dispatch']) {
        events.addEventListener(type, (e) => {
          let data = {};
          try {
            data = JSON.parse(e.data);
          } catch {
            // ignore malformed events
          }
          onEvent(type, data);
          soon();
        });
      }
    }
    refresh();
    // Safety net if events are blocked by a proxy.
    timer = setInterval(refresh, 30_000);
  }

  /** Sign in with a doctor access code (same login as the console). Returns true on success. */
  async function signIn(code) {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: String(code || '').trim() }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.user?.role !== 'doctor') return false;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: body.token, user: body.user }));
    stop();
    start();
    return true;
  }

  start();
  return {
    get signedIn() {
      return Boolean(session);
    },
    refresh,
    signIn,
    /** Full case record plus the sending ASHA's profile (GET /api/doctor/cases/:id). */
    getCase: (id) => getJson(`/api/doctor/cases/${encodeURIComponent(id)}`),
    /** Photo or voice note as an object URL (media is served only to doctors, with the token). */
    async getMediaUrl(id, kind) {
      const res = await request(`/api/doctor/cases/${encodeURIComponent(id)}/media/${kind}`);
      return URL.createObjectURL(await res.blob());
    },
    async decide(id, body) {
      const res = await request(`/api/doctor/cases/${encodeURIComponent(id)}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const out = await res.json();
      refresh();
      return out.case;
    },
    /** Send the prescribed medicines (stops, bike, distance, ETA). Returns the updated case. */
    async dispatch(id, body) {
      const res = await request(`/api/doctor/cases/${encodeURIComponent(id)}/dispatch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return (await res.json()).case;
    },
    async delivered(id) {
      const res = await request(`/api/doctor/cases/${encodeURIComponent(id)}/dispatch/delivered`, { method: 'POST' });
      return (await res.json()).case;
    },
    /** Answered cases whose medicines are still on the way (to resume the bikes after a reload). */
    async pendingDispatches() {
      const { cases } = await getJson('/api/doctor/cases?view=responded');
      return cases.filter((c) => c.dispatchStatus === 'on_the_way');
    }
  };
}
