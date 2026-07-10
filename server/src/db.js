// SafeWeb data access layer.
//
// A deliberately small, swappable persistence interface. This implementation is
// pure JavaScript (no native modules): keyed entities live in JSON files and
// events are an append-only JSONL log, all mirrored in memory and rebuilt on
// load. The interface is what matters — a production deployment can drop in a
// SQLite/Postgres implementation exposing the same methods.
//
// Storage layout under dataDir:
//   partners.json     { [id]: partner }
//   devices.json      { [id]: device }
//   enrollments.json  { [normalizedCode]: enrollment }
//   settings.json     { [partnerId]: FilterConfig }
//   events.jsonl      one JSON event per line (append-only)

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultConfig, SEVERITY_RANK } from '../../shared/protocol.js';

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

// Write atomically: write to a temp file then rename, so a crash mid-write can
// never leave a half-written JSON file.
function writeJsonAtomic(path, obj) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, path);
}

/**
 * @param {{ dataDir: string }} opts
 */
export function createDb({ dataDir }) {
  mkdirSync(dataDir, { recursive: true });
  const paths = {
    partners: join(dataDir, 'partners.json'),
    devices: join(dataDir, 'devices.json'),
    enrollments: join(dataDir, 'enrollments.json'),
    settings: join(dataDir, 'settings.json'),
    events: join(dataDir, 'events.jsonl'),
  };

  // In-memory state.
  const partners = readJson(paths.partners, {});
  const devices = readJson(paths.devices, {});
  const enrollments = readJson(paths.enrollments, {});
  const settings = readJson(paths.settings, {});
  /** @type {any[]} */
  const events = [];
  if (existsSync(paths.events)) {
    for (const line of readFileSync(paths.events, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        /* skip corrupt line */
      }
    }
  }

  const persist = {
    partners: () => writeJsonAtomic(paths.partners, partners),
    devices: () => writeJsonAtomic(paths.devices, devices),
    enrollments: () => writeJsonAtomic(paths.enrollments, enrollments),
    settings: () => writeJsonAtomic(paths.settings, settings),
  };

  // Secondary indexes.
  const partnerByEmail = new Map();
  for (const p of Object.values(partners)) partnerByEmail.set(p.email.toLowerCase(), p.id);
  const deviceByTokenHash = new Map();
  for (const d of Object.values(devices)) deviceByTokenHash.set(d.tokenHash, d.id);

  const now = () => Date.now();

  return {
    // ---- partners -------------------------------------------------------
    createPartner({ email, name, passwordHash }) {
      const normEmail = String(email).toLowerCase().trim();
      if (partnerByEmail.has(normEmail)) {
        const err = new Error('email already registered');
        err.code = 'EMAIL_TAKEN';
        throw err;
      }
      const partner = { id: randomUUID(), email: normEmail, name: String(name || ''), passwordHash, createdTs: now() };
      partners[partner.id] = partner;
      partnerByEmail.set(normEmail, partner.id);
      persist.partners();
      return partner;
    },
    getPartnerById(id) {
      return partners[id] || null;
    },
    getPartnerByEmail(email) {
      const id = partnerByEmail.get(String(email).toLowerCase().trim());
      return id ? partners[id] : null;
    },

    // ---- devices --------------------------------------------------------
    createDevice({ partnerId, label, personName, tokenHash, consentAckTs }) {
      const device = {
        id: randomUUID(),
        partnerId,
        label: String(label || 'device'),
        personName: String(personName || ''),
        tokenHash,
        consentAckTs: consentAckTs || now(),
        createdTs: now(),
        lastSeenTs: now(),
        active: true,
      };
      devices[device.id] = device;
      deviceByTokenHash.set(tokenHash, device.id);
      persist.devices();
      return device;
    },
    getDeviceById(id) {
      return devices[id] || null;
    },
    getDeviceByTokenHash(tokenHash) {
      const id = deviceByTokenHash.get(tokenHash);
      return id ? devices[id] : null;
    },
    listDevicesByPartner(partnerId) {
      return Object.values(devices).filter((d) => d.partnerId === partnerId);
    },
    touchDevice(id, { lastSeenTs, active } = {}) {
      const d = devices[id];
      if (!d) return null;
      d.lastSeenTs = lastSeenTs ?? now();
      if (typeof active === 'boolean') d.active = active;
      persist.devices();
      return d;
    },

    // ---- enrollments ----------------------------------------------------
    createEnrollment({ code, partnerId, label, personName, ttlMs = 24 * 60 * 60 * 1000 }) {
      const enrollment = {
        code,
        partnerId,
        label: String(label || 'device'),
        personName: String(personName || ''),
        expiresTs: now() + ttlMs,
        claimedByDeviceId: null,
        createdTs: now(),
      };
      enrollments[code] = enrollment;
      persist.enrollments();
      return enrollment;
    },
    getEnrollment(code) {
      return enrollments[code] || null;
    },
    // Atomically mark an enrollment claimed. Returns the enrollment or null if
    // it is missing, expired, or already claimed.
    claimEnrollment(code, deviceId) {
      const e = enrollments[code];
      if (!e) return null;
      if (e.claimedByDeviceId) return null;
      if (e.expiresTs < now()) return null;
      e.claimedByDeviceId = deviceId;
      persist.enrollments();
      return e;
    },

    // ---- events ---------------------------------------------------------
    appendEvent(event) {
      const rec = { id: randomUUID(), ...event };
      events.push(rec);
      appendFileSync(paths.events, JSON.stringify(rec) + '\n');
      return rec;
    },
    queryEvents({ partnerId, since = 0, type = null, limit = 200 } = {}) {
      let out = events.filter((e) => e.partnerId === partnerId && e.receivedTs >= since);
      if (type) out = out.filter((e) => e.type === type);
      // Most recent first.
      out.sort((a, b) => b.receivedTs - a.receivedTs);
      return out.slice(0, Math.max(0, Math.min(limit, 1000)));
    },

    // ---- settings -------------------------------------------------------
    getSettings(partnerId) {
      if (!settings[partnerId]) {
        settings[partnerId] = defaultConfig();
        persist.settings();
      }
      return settings[partnerId];
    },
    putSettings(partnerId, partial) {
      const current = settings[partnerId] || defaultConfig();
      const next = { ...current, ...sanitizeConfigPatch(partial) };
      next.revision = (current.revision || 1) + 1;
      next.protocolVersion = current.protocolVersion;
      settings[partnerId] = next;
      persist.settings();
      return next;
    },

    // ---- aggregates -----------------------------------------------------
    summarize(partnerId, since = 0) {
      const rows = events.filter((e) => e.partnerId === partnerId && e.receivedTs >= since);
      const byType = {};
      const bySeverity = {};
      const byDay = {};
      const domainCounts = {};
      const termCounts = {};
      let highest = 'info';
      for (const e of rows) {
        byType[e.type] = (byType[e.type] || 0) + 1;
        bySeverity[e.severity] = (bySeverity[e.severity] || 0) + 1;
        const day = new Date(e.receivedTs).toISOString().slice(0, 10);
        byDay[day] = (byDay[day] || 0) + 1;
        if (e.domain) domainCounts[e.domain] = (domainCounts[e.domain] || 0) + 1;
        for (const t of e.matchedTerms || []) termCounts[t] = (termCounts[t] || 0) + 1;
        if ((SEVERITY_RANK[e.severity] ?? 0) > (SEVERITY_RANK[highest] ?? 0)) highest = e.severity;
      }
      const top = (obj) =>
        Object.entries(obj)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([key, count]) => ({ key, count }));
      return {
        total: rows.length,
        byType,
        bySeverity,
        byDay,
        topDomains: top(domainCounts),
        topTerms: top(termCounts),
        highestSeverity: highest,
      };
    },
  };
}

// Only allow known, well-typed config keys through a settings update so a
// partner cannot inject arbitrary fields.
function sanitizeConfigPatch(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  const strArr = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean).slice(0, 500) : undefined);
  const bool = (v) => (typeof v === 'boolean' ? v : undefined);
  const assignIf = (k, v) => {
    if (v !== undefined) out[k] = v;
  };
  assignIf('blockedCategories', strArr(patch.blockedCategories));
  assignIf('customBlockedDomains', strArr(patch.customBlockedDomains));
  assignIf('allowedDomains', strArr(patch.allowedDomains));
  assignIf('triggerCategories', strArr(patch.triggerCategories));
  assignIf('customTriggerWords', strArr(patch.customTriggerWords));
  assignIf('scanPageText', bool(patch.scanPageText));
  assignIf('recordAllowedVisits', bool(patch.recordAllowedVisits));
  if (Number.isFinite(patch.heartbeatSeconds)) {
    out.heartbeatSeconds = Math.max(30, Math.min(3600, Math.floor(patch.heartbeatSeconds)));
  }
  return out;
}
