// Alerting: turns a high-severity event into (a) a message to the accountability
// partner via a pluggable mailer and (b) a live push to any dashboard connected
// to that partner's SSE stream.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * Create a mailer. Transports:
 *   - 'console' (default): logs a formatted alert. Perfect for the demo and for
 *     self-hosters who haven't configured email yet.
 *   - 'webhook': POSTs the alert JSON to `webhookUrl` (e.g. a Slack/Discord or
 *     automation webhook — a zero-config way to get real notifications).
 *   - 'email': POSTs to a REST email API (Resend-compatible by default) so the
 *     accountability partner receives an actual email. Dependency-free.
 *   - custom: pass `send(alert)` directly.
 * @param {{ transport?: string, webhookUrl?: string, email?: object, send?: Function, logger?: Function }} opts
 */
export function createMailer({ transport = 'console', webhookUrl, email, send, logger = console.log } = {}) {
  if (typeof send === 'function') return { send };

  if (transport === 'webhook') {
    return {
      async send(alert) {
        if (!webhookUrl) return;
        await postJson(webhookUrl, alert).catch((e) => logger('[alert] webhook failed:', e.message));
      },
    };
  }

  if (transport === 'email') {
    const cfg = email || {};
    const apiUrl = cfg.apiUrl || 'https://api.resend.com/emails';
    return {
      async send(alert) {
        if (!cfg.apiKey || !alert.partnerEmail) {
          logger('[alert] email transport not fully configured (need EMAIL_API_KEY); skipping.');
          return;
        }
        const body = {
          from: cfg.from || 'SafeWeb <alerts@safeweb.local>',
          to: [alert.partnerEmail],
          subject: `SafeWeb alert: ${prettyType(alert.type)} on ${alert.deviceLabel || 'a device'}`,
          html: renderEmailHtml(alert),
        };
        await postJson(apiUrl, body, { authorization: `Bearer ${cfg.apiKey}` }).catch((e) =>
          logger('[alert] email send failed:', e.message),
        );
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

function postJson(url, body, extraHeaders = {}) {
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
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length, ...extraHeaders },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}`));
          else resolve();
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function prettyType(type) {
  return (
    {
      blocked_site: 'Blocked site',
      trigger_word: 'Trigger word',
      bypass_attempt: 'Bypass attempt',
      protection_off: 'Protection turned OFF',
      protection_on: 'Protection on',
      heartbeat_missed: 'Device went silent',
    }[type] || type
  );
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderEmailHtml(alert) {
  const when = new Date(alert.ts).toLocaleString();
  const rows = [
    ['Device', `${esc(alert.deviceLabel)}${alert.personName ? ' — ' + esc(alert.personName) : ''}`],
    ['Event', esc(prettyType(alert.type))],
    alert.domain ? ['Site', esc(alert.domain)] : null,
    alert.matchedTerms?.length ? ['Terms', esc(alert.matchedTerms.join(', '))] : null,
    alert.context ? ['Context', esc(alert.context)] : null,
    ['Severity', esc(alert.severity)],
    ['Time', esc(when)],
  ].filter(Boolean);
  return (
    `<div style="font-family:system-ui,sans-serif;max-width:520px">` +
    `<h2 style="margin:0 0 8px">🛡️ SafeWeb accountability alert</h2>` +
    `<table style="border-collapse:collapse;width:100%">` +
    rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:4px 10px;color:#667;white-space:nowrap">${k}</td><td style="padding:4px 10px"><strong>${v}</strong></td></tr>`,
      )
      .join('') +
    `</table>` +
    `<p style="color:#889;font-size:13px;margin-top:14px">You are receiving this because you are the accountability partner for this device. Snippets are redacted on-device before they reach you.</p>` +
    `</div>`
  );
}
