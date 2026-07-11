// SafeWeb accountability server — zero-dependency node:http application.
//
// createApp() returns an http.Server. A tiny internal router matches the
// method + exact pathname against the API.* path constants (all API paths are
// fixed; parameters travel in the query string or body). Static dashboard files
// are served for everything else.

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  API,
  PROTOCOL_VERSION,
  normalizeEvent,
  EVENT_TYPES,
  SEVERITY,
  SEVERITY_RANK,
  IMMEDIATE_ALERT_MIN_SEVERITY,
} from '../../shared/protocol.js';
import { flattenBlockedDomains, buildTriggerMatcher } from '../../shared/config.js';
import {
  hashToken,
  hashPassword,
  verifyPassword,
  generateDeviceToken,
  generateEnrollmentCode,
  normalizeCode,
} from '../../shared/crypto.js';
import { createAuth, createRateLimiter } from './auth.js';
import { createAlertHub, buildAlert } from './alerts.js';
import { loadMergedBlocklist } from '../../scripts/lib/load-blocklist.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
const DATA_DIR_ROOT = join(__dirname, '..', '..', 'data');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const BODY_LIMIT = 256 * 1024; // 256 KB cap on request bodies
const IMMEDIATE_RANK = SEVERITY_RANK[IMMEDIATE_ALERT_MIN_SEVERITY];

/**
 * @param {Object} opts
 * @param {ReturnType<import('./db.js').createDb>} opts.db
 * @param {{ send: Function }} opts.mailer
 * @param {string} opts.pepper  token-hash pepper
 * @param {string} [opts.secret]
 */
export function createApp({ db, mailer, pepper, secret = 'dev-secret' }) {
  const auth = createAuth({ db, pepper });
  const hub = createAlertHub();
  const loginLimiter = createRateLimiter({ windowMs: 60_000, max: 10 });
  const claimLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

  // Load the categorized data files once. The blocklist is the curated seed
  // merged with the optional generated extended list (npm run update:blocklist).
  const blocklistData = loadMergedBlocklist(DATA_DIR_ROOT);
  const triggersData = JSON.parse(readFileSync(join(DATA_DIR_ROOT, 'triggers.json'), 'utf8'));

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      // Never leak internals; log server-side.
      console.error('[server] unhandled error:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const method = req.method || 'GET';
    const ip = req.socket.remoteAddress || 'unknown';

    // ---- health ---------------------------------------------------------
    if (method === 'GET' && path === '/api/v1/health') {
      return sendJson(res, 200, { ok: true, version: PROTOCOL_VERSION });
    }

    // ---- partner: register / login / logout / me ------------------------
    if (method === 'POST' && path === '/api/v1/partner/register') {
      const body = await readJson(req, res);
      if (body === undefined) return;
      const { email, name, password } = body;
      if (!isEmail(email) || !isNonEmpty(password)) {
        return sendJson(res, 400, { error: 'email and password required' });
      }
      if (String(password).length < 8) {
        return sendJson(res, 400, { error: 'password must be at least 8 characters' });
      }
      let partner;
      try {
        partner = db.createPartner({ email, name, passwordHash: hashPassword(password) });
      } catch (e) {
        if (e.code === 'EMAIL_TAKEN') return sendJson(res, 409, { error: 'email already registered' });
        throw e;
      }
      const sid = auth.createSession(partner.id);
      setSessionCookie(res, sid);
      return sendJson(res, 201, { partner: publicPartner(partner) });
    }

    if (method === 'POST' && path === API.partnerLogin) {
      if (!loginLimiter.allow(`login:${ip}`)) return sendJson(res, 429, { error: 'too many attempts' });
      const body = await readJson(req, res);
      if (body === undefined) return;
      const partner = db.getPartnerByEmail(body.email || '');
      if (!partner || !verifyPassword(body.password || '', partner.passwordHash)) {
        return sendJson(res, 401, { error: 'invalid credentials' });
      }
      loginLimiter.reset(`login:${ip}`);
      const sid = auth.createSession(partner.id);
      setSessionCookie(res, sid);
      return sendJson(res, 200, { partner: publicPartner(partner) });
    }

    if (method === 'POST' && path === API.partnerLogout) {
      const sid = cookies(req).sw_session;
      auth.destroySession(sid);
      clearSessionCookie(res);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && path === API.partnerMe) {
      const partner = requirePartner(req, res, auth);
      if (!partner) return;
      return sendJson(res, 200, { partner: publicPartner(partner) });
    }

    // ---- enrollment -----------------------------------------------------
    if (method === 'POST' && path === API.enrollCreate) {
      const partner = requirePartner(req, res, auth);
      if (!partner) return;
      const body = await readJson(req, res);
      if (body === undefined) return;
      // Generate a unique, unclaimed code.
      let code;
      for (let i = 0; i < 5; i++) {
        code = normalizeCode(generateEnrollmentCode());
        if (!db.getEnrollment(code)) break;
      }
      const enrollment = db.createEnrollment({
        code,
        partnerId: partner.id,
        label: body.label || 'device',
        personName: body.personName || '',
      });
      return sendJson(res, 201, { code: enrollment.code, expiresTs: enrollment.expiresTs });
    }

    if (method === 'POST' && path === API.enrollClaim) {
      if (!claimLimiter.allow(`claim:${ip}`)) return sendJson(res, 429, { error: 'too many attempts' });
      const body = await readJson(req, res);
      if (body === undefined) return;
      // Consent gate: the protected person must acknowledge monitoring.
      if (body.consentAck !== true) {
        return sendJson(res, 409, {
          error: 'consent required',
          detail: 'The person using this device must acknowledge that activity will be monitored.',
        });
      }
      const code = normalizeCode(body.code || '');
      const enrollment = db.getEnrollment(code);
      if (!enrollment || enrollment.claimedByDeviceId || enrollment.expiresTs < Date.now()) {
        return sendJson(res, 404, { error: 'invalid or expired code' });
      }
      const token = generateDeviceToken();
      const device = db.createDevice({
        partnerId: enrollment.partnerId,
        label: body.deviceLabel || enrollment.label,
        personName: body.personName || enrollment.personName,
        tokenHash: hashToken(token, pepper),
        consentAckTs: Date.now(),
      });
      db.claimEnrollment(code, device.id);
      const partner = db.getPartnerById(enrollment.partnerId);
      return sendJson(res, 201, {
        deviceToken: token,
        deviceId: device.id,
        partnerName: partner?.name || '',
        partnerEmail: partner?.email || '',
      });
    }

    // ---- device: config / events / heartbeat ----------------------------
    if (method === 'GET' && path === API.config) {
      const device = requireDevice(req, res, auth);
      if (!device) return;
      db.touchDevice(device.id, { lastSeenTs: Date.now() });
      const config = db.getSettings(device.partnerId);
      const blockedDomains = resolveBlockedDomains(blocklistData, config);
      const triggerTerms = buildTriggerMatcher(triggersData, config).terms.map((t) => ({
        term: t.raw,
        category: t.category,
        severity: t.severity,
      }));
      return sendJson(res, 200, { ...config, blockedDomains, triggerTerms });
    }

    if (method === 'POST' && path === API.events) {
      const device = requireDevice(req, res, auth);
      if (!device) return;
      const body = await readJson(req, res);
      if (body === undefined) return;
      const incoming = Array.isArray(body.events) ? body.events : [];
      let accepted = 0;
      let rejected = 0;
      for (const raw of incoming.slice(0, 500)) {
        const norm = normalizeEvent(raw);
        if (!norm.ok) {
          rejected += 1;
          continue;
        }
        const stored = db.appendEvent({ ...norm.event, deviceId: device.id, partnerId: device.partnerId });
        accepted += 1;
        maybeAlert(stored, device);
      }
      db.touchDevice(device.id, { lastSeenTs: Date.now() });
      return sendJson(res, 200, { accepted, rejected });
    }

    if (method === 'POST' && path === API.heartbeat) {
      const device = requireDevice(req, res, auth);
      if (!device) return;
      const body = await readJson(req, res);
      if (body === undefined) return;
      const protectionOn = body.protectionOn !== false;
      const wasActive = device.active;
      db.touchDevice(device.id, { lastSeenTs: Date.now(), active: protectionOn });
      // If protection just went off, that is itself a reportable, alertable event.
      if (wasActive && !protectionOn) {
        const stored = db.appendEvent({
          type: EVENT_TYPES.PROTECTION_OFF,
          severity: SEVERITY.HIGH,
          ts: Date.now(),
          receivedTs: Date.now(),
          detail: 'Protection was turned off on the device.',
          matchedTerms: [],
          deviceId: device.id,
          partnerId: device.partnerId,
        });
        maybeAlert(stored, device);
      }
      return sendJson(res, 200, { ok: true });
    }

    // ---- partner: reports / devices / settings / stream -----------------
    if (method === 'GET' && path === API.reports) {
      const partner = requirePartner(req, res, auth);
      if (!partner) return;
      const since = intParam(url.searchParams.get('since'), 0);
      const type = url.searchParams.get('type') || null;
      const limit = intParam(url.searchParams.get('limit'), 200);
      const events = db.queryEvents({ partnerId: partner.id, since, type, limit });
      const summary = db.summarize(partner.id, since);
      return sendJson(res, 200, { events, summary });
    }

    if (method === 'GET' && path === API.devices) {
      const partner = requirePartner(req, res, auth);
      if (!partner) return;
      const config = db.getSettings(partner.id);
      const onlineWindow = (config.heartbeatSeconds || 300) * 1000 * 2;
      const now = Date.now();
      const devices = db.listDevicesByPartner(partner.id).map((d) => ({
        id: d.id,
        label: d.label,
        personName: d.personName,
        active: d.active,
        online: now - d.lastSeenTs < onlineWindow,
        lastSeenTs: d.lastSeenTs,
        createdTs: d.createdTs,
        consentAckTs: d.consentAckTs,
        recentEvents: db.queryEvents({ partnerId: partner.id, since: now - 24 * 3600 * 1000, limit: 1000 })
          .filter((e) => e.deviceId === d.id).length,
      }));
      return sendJson(res, 200, { devices });
    }

    if (method === 'GET' && path === API.settings) {
      const partner = requirePartner(req, res, auth);
      if (!partner) return;
      return sendJson(res, 200, {
        settings: db.getSettings(partner.id),
        availableBlockCategories: Object.keys(blocklistData.categories || {}),
        availableTriggerCategories: Object.keys(triggersData.categories || {}),
      });
    }

    if (method === 'PUT' && path === API.settings) {
      const partner = requirePartner(req, res, auth);
      if (!partner) return;
      const body = await readJson(req, res);
      if (body === undefined) return;
      const updated = db.putSettings(partner.id, body.settings || body);
      return sendJson(res, 200, { settings: updated });
    }

    if (method === 'GET' && path === API.stream) {
      const partner = requirePartner(req, res, auth);
      if (!partner) return;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
      const unsub = hub.subscribe(partner.id, res);
      // Keep-alive comment ping.
      const ping = setInterval(() => {
        try {
          res.write(`: ping ${Date.now()}\n\n`);
        } catch {
          /* connection gone */
        }
      }, 25_000);
      req.on('close', () => {
        clearInterval(ping);
        unsub();
      });
      return; // response stays open
    }

    // ---- consent policy (served from the repo root so the dashboard can link it)
    if (method === 'GET' && (path === '/ETHICS.md' || path === '/ETHICS')) {
      const ethicsPath = join(__dirname, '..', '..', 'ETHICS.md');
      if (existsSync(ethicsPath)) {
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
        return res.end(readFileSync(ethicsPath));
      }
    }

    // ---- static (dashboard) --------------------------------------------
    if (method === 'GET') {
      return serveStatic(path, res);
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  // Fire an alert if the event is severe enough.
  function maybeAlert(event, device) {
    if ((SEVERITY_RANK[event.severity] ?? 0) < IMMEDIATE_RANK) return;
    const partner = db.getPartnerById(device.partnerId);
    const alert = buildAlert({ event, device, partner });
    Promise.resolve(mailer.send(alert)).catch((e) => console.error('[alert] mail failed:', e.message));
    hub.publish(device.partnerId, alert);
  }

  // Expose the hub for tests.
  server.alertHub = hub;
  return server;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveBlockedDomains(blocklistData, config) {
  const base = new Set(flattenBlockedDomains(blocklistData, config.blockedCategories || []));
  for (const d of config.customBlockedDomains || []) base.add(String(d).toLowerCase());
  for (const d of config.allowedDomains || []) base.delete(String(d).toLowerCase());
  return [...base];
}

function requirePartner(req, res, auth) {
  const partner = auth.partnerFromSession(cookies(req).sw_session);
  if (!partner) {
    sendJson(res, 401, { error: 'authentication required' });
    return null;
  }
  return partner;
}

function requireDevice(req, res, auth) {
  const device = auth.deviceFromAuthHeader(req.headers.authorization);
  if (!device) {
    sendJson(res, 401, { error: 'device authentication required' });
    return null;
  }
  return device;
}

function publicPartner(p) {
  return { id: p.id, name: p.name, email: p.email };
}

function readJson(req, res) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        sendJson(res, 413, { error: 'request body too large' });
        req.destroy();
        resolve(undefined);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return; // already responded (413)
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        sendJson(res, 400, { error: 'invalid JSON' });
        resolve(undefined);
      }
    });
    req.on('error', () => {
      if (!res.writableEnded) sendJson(res, 400, { error: 'read error' });
      resolve(undefined);
    });
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function cookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function setSessionCookie(res, sid) {
  res.setHeader('set-cookie', `sw_session=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 3600}`);
}
function clearSessionCookie(res) {
  res.setHeader('set-cookie', 'sw_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function serveStatic(path, res) {
  let rel = path === '/' ? '/index.html' : path;
  // Prevent path traversal.
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    // SPA fallback: serve index.html for unknown non-API GET routes.
    const indexPath = join(PUBLIC_DIR, 'index.html');
    if (existsSync(indexPath)) {
      const html = readFileSync(indexPath);
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return res.end(html);
    }
    return sendJson(res, 404, { error: 'not found' });
  }
  const data = readFileSync(filePath);
  res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
  res.end(data);
}

function isEmail(v) {
  return typeof v === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
}
function isNonEmpty(v) {
  return typeof v === 'string' && v.length > 0;
}
function intParam(v, fallback) {
  // Treat missing/empty query params as the fallback. Note Number(null) and
  // Number('') are both 0 (finite), so an explicit guard is required.
  if (v === null || v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
