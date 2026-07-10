// Alerting: turns a high-severity event into (a) a message to the accountability
// partner via a pluggable mailer and (b) a live push to any dashboard connected
// to that partner's SSE stream.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * Create a mailer. Transports:
 *   - 'console' (default): logs a formatted alert. Perfect for the demo and for
 *     self-hosters who haven't configured SMTP yet.
 *   - 'webhook': POSTs the alert JSON to `webhookUrl` (e.g. a chat webhook).
 *   - custom: pass `send(alert)` directly.
 * @param {{ transport?: string, webhookUrl?: string, send?: Function, logger?: Function }} opts
 */
export function createMailer({ transport = 'console', webhookUrl, send, logger = console.log } = {}) {
  if (typeof send === 'function') return { send };

  if (transport === 'webhook') {
    return {
      async send(alert) {
        if (!webhookUrl) return;
        await postJson(webhookUrl, alert).catch((e) => logger('[alert] webhook failed:', e.message));
      },
    };
  }

  // console transport
  return {
    async send(alert) {
      const when = new Date(alert.ts).toISOString();
      logger(
        `\n🔔 SafeWeb alert [${alert.severity.toUpperCase()}] ${when}\n` +
          `   device: ${alert.deviceLabel} (${alert.personName || 'unknown person'})\n` +
          `   event : ${alert.type}${alert.domain ? ' — ' + alert.domain : ''}\n` +
          (alert.matchedTerms?.length ? `   terms : ${alert.matchedTerms.join(', ')}\n` : '') +
          (alert.context ? `   context: ${alert.context}\n` : '') +
          `   -> notify partner ${alert.partnerEmail}\n`,
      );
    },
  };
}

/**
 * The SSE hub. Dashboards subscribe with a partnerId + a raw http response; the
 * app calls `publish(partnerId, alert)` to fan an alert out to that partner's
 * open connections only.
 */
export function createAlertHub() {
  /** @type {Map<string, Set<import('node:http').ServerResponse>>} */
  const subs = new Map();

  function subscribe(partnerId, res) {
    let set = subs.get(partnerId);
    if (!set) {
      set = new Set();
      subs.set(partnerId, set);
    }
    set.add(res);
    res.on('close', () => set.delete(res));
    return () => set.delete(res);
  }

  function publish(partnerId, alert) {
    const set = subs.get(partnerId);
    if (!set || set.size === 0) return 0;
    const payload = `event: alert\ndata: ${JSON.stringify(alert)}\n\n`;
    let delivered = 0;
    for (const res of set) {
      try {
        res.write(payload);
        delivered += 1;
      } catch {
        set.delete(res);
      }
    }
    return delivered;
  }

  function connectionCount(partnerId) {
    return subs.get(partnerId)?.size || 0;
  }

  return { subscribe, publish, connectionCount };
}

/** Build the partner-facing alert object from a stored event + context. */
export function buildAlert({ event, device, partner }) {
  return {
    severity: event.severity,
    type: event.type,
    ts: event.receivedTs,
    deviceLabel: device?.label,
    personName: device?.personName,
    domain: event.domain,
    matchedTerms: event.matchedTerms,
    context: event.context,
    partnerEmail: partner?.email,
    partnerId: partner?.id,
    eventId: event.id,
  };
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(e);
    }
    const data = Buffer.from(JSON.stringify(body));
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
      u,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
