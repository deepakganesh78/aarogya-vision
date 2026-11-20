// In-process event bus for live updates. The doctor console listens with server-sent events
// (GET /api/doctor/events), so new and changed cases appear without a refresh.
// Events carry IDs and levels only, never health content. On Cloud Run with several instances
// this would move to Pub/Sub; one instance is enough for the prototype.
export function createEvents() {
  const listeners = new Set();

  function publish(event) {
    const payload = { at: new Date().toISOString(), ...event };
    for (const fn of listeners) {
      try {
        fn(payload);
      } catch {
        // a broken listener must not stop the others
      }
    }
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { publish, subscribe, count: () => listeners.size };
}
