import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from './db.js';
import { createApp } from './app.js';
import { req, listen } from './http-client.js';
import { EVENT_TYPES, SEVERITY } from '../../shared/protocol.js';

let server;
let port;
let dataDir;
let alerts;

function makeMailer() {
  const captured = [];
  return { send: (a) => captured.push(a), captured };
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'safeweb-test-'));
  const db = createDb({ dataDir });
  const mailer = makeMailer();
  alerts = mailer.captured;
  server = createApp({ db, mailer, pepper: 'test-pepper', secret: 'test-secret' });
  port = await listen(server);
});

after(() => {
  server?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  alerts.length = 0;
});

// Helper: register a partner and return its session cookie.
async function registerPartner(email = `p${Math.random().toString(36).slice(2)}@ex.com`) {
  const r = await req({ port, method: 'POST', path: '/api/v1/partner/register', body: { email, name: 'Parent', password: 'supersecret' } });
  return { cookie: r.cookie, res: r, email };
}

// Helper: full enroll -> claim, returns device token.
async function enrollDevice(cookie, { consent = true } = {}) {
  const create = await req({ port, method: 'POST', path: '/api/v1/enroll/code', body: { label: 'Kid laptop', personName: 'Sam' }, cookie });
  assert.equal(create.status, 201);
  const claim = await req({
    port,
    method: 'POST',
    path: '/api/v1/enroll/claim',
    body: { code: create.json.code, deviceLabel: 'Kid laptop', consentAck: consent },
  });
  return { claim, code: create.json.code };
}

test('health endpoint', async () => {
  const r = await req({ port, method: 'GET', path: '/api/v1/health' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test('partner register sets a session and login works', async () => {
  const { res, email } = await registerPartner();
  assert.equal(res.status, 201);
  assert.ok(res.cookie.startsWith('sw_session='));
  assert.ok(!('passwordHash' in res.json.partner));

  const ok = await req({ port, method: 'POST', path: '/api/v1/partner/login', body: { email, password: 'supersecret' } });
  assert.equal(ok.status, 200);
  const bad = await req({ port, method: 'POST', path: '/api/v1/partner/login', body: { email, password: 'wrong' } });
  assert.equal(bad.status, 401);
});

test('duplicate registration is rejected', async () => {
  const email = `dup${Math.random().toString(36).slice(2)}@ex.com`;
  await registerPartner(email);
  const again = await req({ port, method: 'POST', path: '/api/v1/partner/register', body: { email, name: 'x', password: 'supersecret' } });
  assert.equal(again.status, 409);
});

test('enrollment requires consent acknowledgement', async () => {
  const { cookie } = await registerPartner();
  const { claim } = await enrollDevice(cookie, { consent: false });
  assert.equal(claim.status, 409);
  assert.match(claim.json.error, /consent/i);
});

test('enroll -> claim yields a device token, code is single-use', async () => {
  const { cookie } = await registerPartner();
  const { claim, code } = await enrollDevice(cookie);
  assert.equal(claim.status, 201);
  assert.ok(claim.json.deviceToken.startsWith('swd_'));
  assert.equal(claim.json.partnerName, 'Parent');

  // Re-claiming the same code fails.
  const reuse = await req({ port, method: 'POST', path: '/api/v1/enroll/claim', body: { code, consentAck: true } });
  assert.equal(reuse.status, 404);
});

test('device config pull returns resolved blocklist + trigger terms', async () => {
  const { cookie } = await registerPartner();
  const { claim } = await enrollDevice(cookie);
  const token = claim.json.deviceToken;
  const cfg = await req({ port, method: 'GET', path: '/api/v1/config', headers: { authorization: `Bearer ${token}` } });
  assert.equal(cfg.status, 200);
  assert.ok(Array.isArray(cfg.json.blockedDomains) && cfg.json.blockedDomains.length > 0);
  assert.ok(cfg.json.blockedDomains.includes('pornhub.com'));
  assert.ok(Array.isArray(cfg.json.triggerTerms) && cfg.json.triggerTerms.length > 0);
  assert.equal(typeof cfg.json.revision, 'number');

  // Missing / bad token -> 401.
  const noauth = await req({ port, method: 'GET', path: '/api/v1/config' });
  assert.equal(noauth.status, 401);
  const bad = await req({ port, method: 'GET', path: '/api/v1/config', headers: { authorization: 'Bearer nope' } });
  assert.equal(bad.status, 401);
});

test('posting a high-severity event fires an alert and appears in reports', async () => {
  const { cookie } = await registerPartner();
  const { claim } = await enrollDevice(cookie);
  const token = claim.json.deviceToken;

  const post = await req({
    port,
    method: 'POST',
    path: '/api/v1/events',
    headers: { authorization: `Bearer ${token}` },
    body: {
      events: [
        { type: EVENT_TYPES.BLOCKED_SITE, domain: 'pornhub.com', severity: SEVERITY.HIGH },
        { type: EVENT_TYPES.TRIGGER_WORD, matchedTerms: ['porn'], context: 'search for [redacted]', severity: SEVERITY.MEDIUM },
        { type: 'garbage' }, // invalid -> rejected
      ],
    },
  });
  assert.equal(post.status, 200);
  assert.equal(post.json.accepted, 2);
  assert.equal(post.json.rejected, 1);
  // One high-severity event -> one alert.
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, EVENT_TYPES.BLOCKED_SITE);

  const reports = await req({ port, method: 'GET', path: '/api/v1/partner/reports', cookie });
  assert.equal(reports.status, 200);
  assert.equal(reports.json.events.length, 2);
  assert.equal(reports.json.summary.total, 2);
  assert.ok(reports.json.summary.topDomains.some((d) => d.key === 'pornhub.com'));
});

test('reports require partner auth', async () => {
  const r = await req({ port, method: 'GET', path: '/api/v1/partner/reports' });
  assert.equal(r.status, 401);
});

test('settings update bumps revision and is reflected in config', async () => {
  const { cookie } = await registerPartner();
  const before = await req({ port, method: 'GET', path: '/api/v1/partner/settings', cookie });
  assert.equal(before.status, 200);
  const rev0 = before.json.settings.revision;

  const put = await req({
    port,
    method: 'PUT',
    path: '/api/v1/partner/settings',
    cookie,
    body: { settings: { customBlockedDomains: ['example-adult.test'], scanPageText: false } },
  });
  assert.equal(put.status, 200);
  assert.equal(put.json.settings.revision, rev0 + 1);
  assert.equal(put.json.settings.scanPageText, false);
  assert.ok(put.json.settings.customBlockedDomains.includes('example-adult.test'));
});

test('heartbeat with protectionOff records and alerts PROTECTION_OFF', async () => {
  const { cookie } = await registerPartner();
  const { claim } = await enrollDevice(cookie);
  const token = claim.json.deviceToken;

  const hb = await req({ port, method: 'POST', path: '/api/v1/heartbeat', headers: { authorization: `Bearer ${token}` }, body: { protectionOn: false } });
  assert.equal(hb.status, 200);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, EVENT_TYPES.PROTECTION_OFF);
});

test('devices list shows the enrolled device as online', async () => {
  const { cookie } = await registerPartner();
  await enrollDevice(cookie);
  const list = await req({ port, method: 'GET', path: '/api/v1/partner/devices', cookie });
  assert.equal(list.status, 200);
  assert.equal(list.json.devices.length, 1);
  assert.equal(list.json.devices[0].online, true);
  assert.equal(list.json.devices[0].personName, 'Sam');
});
