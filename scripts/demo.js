// SafeWeb end-to-end demo — no browser required.
//
// Boots the server in-process against a temporary data dir and walks the entire
// lifecycle a real deployment goes through:
//   1. A parent/accountability partner registers.
//   2. They mint an enrollment code.
//   3. The protected person's device claims it — WITH a consent acknowledgement.
//   4. The device pulls its filter config (blocklist + trigger words).
//   5. The device reports a batch of events (a blocked site, a trigger-word hit,
//      a bypass attempt) — high-severity ones fire live alerts to the partner.
//   6. The partner views the resulting report.
//
// Run: npm run demo   (exits non-zero if any step fails)

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createDb } from '../server/src/db.js';
import { createApp } from '../server/src/app.js';
import { createMailer } from '../server/src/alerts.js';
import { req, listen } from '../server/src/http-client.js';
import { EVENT_TYPES, SEVERITY } from '../shared/protocol.js';

const line = (s = '') => console.log(s);
const step = (n, s) => console.log(`\n\x1b[1m[${n}]\x1b[0m ${s}`);

const dataDir = mkdtempSync(join(tmpdir(), 'safeweb-demo-'));
const alertsFired = [];

async function main() {
  const db = createDb({ dataDir });
  // Console mailer prints alerts; we also capture them for the summary.
  const consoleMailer = createMailer({ transport: 'console' });
  const mailer = {
    send: (a) => {
      alertsFired.push(a);
      return consoleMailer.send(a);
    },
  };
  const app = createApp({ db, mailer, pepper: 'demo-pepper', secret: 'demo-secret' });
  const port = await listen(app);

  line('\n==================== SafeWeb end-to-end demo ====================');
  line(`server: http://127.0.0.1:${port}   data: ${dataDir}`);

  // 1. Partner registers.
  step(1, 'Accountability partner (a parent) registers');
  const reg = await req({ port, method: 'POST', path: '/api/v1/partner/register', body: { email: 'parent@example.com', name: 'Jordan (parent)', password: 'demo-password' } });
  assert.equal(reg.status, 201, 'register should succeed');
  const cookie = reg.cookie;
  line(`   -> partner "${reg.json.partner.name}" <${reg.json.partner.email}>`);

  // 2. Mint an enrollment code.
  step(2, 'Partner mints an enrollment code for the child\'s laptop');
  const code = await req({ port, method: 'POST', path: '/api/v1/enroll/code', body: { label: "Sam's laptop", personName: 'Sam' }, cookie });
  assert.equal(code.status, 201);
  line(`   -> enrollment code: ${code.json.code}  (read this to the person being protected)`);

  // 3. Device claims WITHOUT consent -> rejected; then WITH consent -> token.
  step(3, 'Device tries to enroll — consent is REQUIRED (transparency by design)');
  const noConsent = await req({ port, method: 'POST', path: '/api/v1/enroll/claim', body: { code: code.json.code, consentAck: false } });
  assert.equal(noConsent.status, 409, 'claim without consent must be rejected');
  line(`   -> without consent: HTTP ${noConsent.status} "${noConsent.json.error}"  ✔ (blocked)`);

  const claim = await req({ port, method: 'POST', path: '/api/v1/enroll/claim', body: { code: code.json.code, deviceLabel: "Sam's laptop", consentAck: true } });
  assert.equal(claim.status, 201, 'claim with consent should succeed');
  const token = claim.json.deviceToken;
  line(`   -> with consent: device paired to partner "${claim.json.partnerName}"; token issued.`);

  // 4. Pull config.
  step(4, 'Device pulls its filter configuration');
  const cfg = await req({ port, method: 'GET', path: '/api/v1/config', headers: { authorization: `Bearer ${token}` } });
  assert.equal(cfg.status, 200);
  line(`   -> ${cfg.json.blockedDomains.length} blocked domains, ${cfg.json.triggerTerms.length} trigger terms, config rev ${cfg.json.revision}`);
  line(`   -> e.g. blocks: ${cfg.json.blockedDomains.slice(0, 4).join(', ')} …`);

  // 5. Device reports events.
  step(5, 'Device reports activity (a blocked site, a trigger word, a bypass attempt)');
  const events = {
    events: [
      { type: EVENT_TYPES.BLOCKED_SITE, domain: 'pornhub.com', url: 'https://pornhub.com/', severity: SEVERITY.HIGH },
      { type: EVENT_TYPES.TRIGGER_WORD, matchedTerms: ['porn'], category: 'explicit', context: 'search for free [redacted] videos', severity: SEVERITY.HIGH },
      { type: EVENT_TYPES.BYPASS_ATTEMPT, detail: 'Tried to disable the extension', severity: SEVERITY.HIGH },
    ],
  };
  const post = await req({ port, method: 'POST', path: '/api/v1/events', headers: { authorization: `Bearer ${token}` }, body: events });
  assert.equal(post.status, 200);
  line(`   -> server accepted ${post.json.accepted} events, rejected ${post.json.rejected}`);
  line(`   -> ${alertsFired.length} high-severity alerts pushed to the partner (see 🔔 above)`);
  assert.equal(alertsFired.length, 3, 'all three high-severity events should alert');

  // 6. Partner views the report.
  step(6, 'Partner opens the dashboard report');
  const report = await req({ port, method: 'GET', path: '/api/v1/partner/reports', cookie });
  assert.equal(report.status, 200);
  const s = report.json.summary;
  line(`   -> ${s.total} events | by type: ${JSON.stringify(s.byType)}`);
  line(`   -> highest severity: ${s.highestSeverity} | top domain: ${s.topDomains[0]?.key || '—'}`);

  // Consent is on the record for the device.
  const devices = await req({ port, method: 'GET', path: '/api/v1/partner/devices', cookie });
  const dev = devices.json.devices[0];
  line(`   -> device "${dev.label}" for ${dev.personName}: online=${dev.online}, consent acknowledged=${Boolean(dev.consentAckTs)}`);

  app.close();
  line('\n\x1b[32m✔ Demo completed successfully — full lifecycle works end to end.\x1b[0m\n');
}

main()
  .catch((err) => {
    console.error('\n\x1b[31m✘ Demo failed:\x1b[0m', err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });
