import crypto from 'node:crypto';

// Event bus for live updates. The doctor console listens with server-sent events
// (GET /api/doctor/events), so new and changed cases appear without a refresh.
// Events carry IDs and levels only, never health content.
//
// With PUBSUB_TOPIC set (production), every event is also published to Cloud Pub/Sub. Urgent cases carry
// the attribute urgent=true, so an alerting subscription can filter on it. Each Cloud Run instance
// receives the other instances' events through its own short-lived subscription, so a doctor connected to
// any instance sees every case.
export function createEvents({ pubsub, topicName, logger = console } = {}) {
  const listeners = new Set();
  const instanceId = crypto.randomUUID();
  const topic = pubsub && topicName ? pubsub.topic(topicName) : null;
  let subscription = null;

  function deliver(payload) {
    for (const fn of listeners) {
      try {
        fn(payload);
      } catch {
        // a broken listener must not stop the others
      }
    }
  }

  function publish(event) {
    const payload = { at: new Date().toISOString(), ...event };
    deliver(payload);
    if (topic) {
      const attributes = { type: String(payload.type), origin: instanceId, urgent: String(payload.level === 'URGENT') };
      topic.publishMessage({ json: payload, attributes }).catch((err) => logger.warn(`pubsub publish failed: ${err.message}`));
    }
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  // One subscription per instance; Pub/Sub deletes it after a day without a connected client.
  async function start() {
    if (!topic) return;
    const name = `${topicName}-fanout-${instanceId}`;
    [subscription] = await topic.createSubscription(name, {
      expirationPolicy: { ttl: { seconds: 24 * 60 * 60 } },
      messageRetentionDuration: { seconds: 10 * 60 },
      ackDeadlineSeconds: 10
    });
    subscription.on('message', (message) => {
      message.ack();
      if (message.attributes?.origin === instanceId) return;
      try {
        deliver(JSON.parse(message.data.toString('utf8')));
      } catch {
        // ignore malformed messages
      }
    });
    subscription.on('error', (err) => logger.warn(`pubsub subscription error: ${err.message}`));
  }

  async function stop() {
    if (!subscription) return;
    const sub = subscription;
    subscription = null;
    await sub.close().catch(() => {});
    await sub.delete().catch(() => {});
  }

  return { publish, subscribe, start, stop, count: () => listeners.size };
}
