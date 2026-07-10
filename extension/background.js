// SafeWeb background service worker (MV3, ES module).
//
// Responsibilities:
//   * Pull filter config from the accountability server and apply it as
//     dynamic declarativeNetRequest rules (on top of the bundled static rules).
//   * Watch navigations: log blocked-site hits and scan URLs / search queries
//     for trigger words.
//   * Buffer events and flush them to the server in batches.
//   * Send periodic heartbeats so the partner can see the device is protected
//     (and be alerted if protection is turned off).
//
// The heavy detection logic is the SAME code the server uses — imported from
// vendor/ (kept in sync by `npm run sync:shared`).

import { DomainMatcher, TriggerMatcher, normalizeHost } from './vendor/matcher.js';
import { API, EVENT_TYPES, SEVERITY } from './vendor/protocol.js';

const STORAGE = chrome.storage.local;
const ALARM = 'safeweb-sync';
const DYNAMIC_RULE_BASE = 100000; // keep clear of the static ruleset ids (1..N)
const FLUSH_THRESHOLD = 10;

// In-memory working state (rebuilt from storage on wake).
let domainMatcher = new DomainMatcher({ blocked: [], allowed: [] });
let triggerMatcher = new TriggerMatcher([]);

// ---- lifecycle ------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 5 });
  init();
});
chrome.runtime.onStartup.addListener(init);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) {
    syncConfig();
    flushEvents();
    heartbeat();
  }
});

async function init() {
  await loadMatchersFromStorage();
  await syncConfig();
}

// ---- config sync ----------------------------------------------------------
async function getEnrollment() {
  const { serverUrl, deviceToken } = await STORAGE.get(['serverUrl', 'deviceToken']);
  return { serverUrl, deviceToken };
}

async function syncConfig() {
  const { serverUrl, deviceToken } = await getEnrollment();
  if (!serverUrl || !deviceToken) return; // not enrolled yet — static rules still protect
  try {
    const res = await fetch(joinUrl(serverUrl, API.config), {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    if (res.status === 401) {
      await STORAGE.set({ lastSyncError: 'device not recognized (re-enroll)' });
      return;
    }
    if (!res.ok) throw new Error(`config ${res.status}`);
    const config = await res.json();
    await STORAGE.set({ config, blockedDomains: config.blockedDomains || [], triggerTerms: config.triggerTerms || [], lastSync: Date.now(), lastSyncError: null });
    await applyDynamicRules(config.blockedDomains || [], config.allowedDomains || []);
    await loadMatchersFromStorage();
  } catch (err) {
    await STORAGE.set({ lastSyncError: String(err.message || err) });
  }
}

async function loadMatchersFromStorage() {
  const { blockedDomains = [], config = {}, triggerTerms = [] } = await STORAGE.get(['blockedDomains', 'config', 'triggerTerms']);
  domainMatcher = new DomainMatcher({ blocked: blockedDomains, allowed: config.allowedDomains || [] });
  triggerMatcher = new TriggerMatcher(triggerTerms.map((t) => ({ term: t.term, category: t.category, severity: t.severity })));
}

// Apply server-configured domains as dynamic DNR rules (redirect to blocked page).
async function applyDynamicRules(blockedDomains, allowedDomains) {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) return;
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const allow = new Set((allowedDomains || []).map(normalizeHost));
  const addRules = [];
  let id = DYNAMIC_RULE_BASE;
  for (const domain of blockedDomains) {
    const host = normalizeHost(domain);
    if (!host || allow.has(host)) continue;
    addRules.push({
      id: id++,
      priority: 2,
      action: { type: 'redirect', redirect: { extensionPath: `/blocked.html?d=${encodeURIComponent(host)}` } },
      condition: { requestDomains: [host], resourceTypes: ['main_frame'] },
    });
  }
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (err) {
    console.warn('[SafeWeb] could not update dynamic rules:', err);
  }
}

// ---- navigation watching --------------------------------------------------
chrome.webNavigation?.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return; // main frame only
  handleNavigation(details.url);
});

async function handleNavigation(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return;
  }
  if (!/^https?:$/.test(url.protocol)) return;

  // Blocked domain? DNR performs the actual redirect; we record the attempt.
  const domainCheck = domainMatcher.check(url.hostname);
  if (domainCheck.blocked) {
    queueEvent({ type: EVENT_TYPES.BLOCKED_SITE, severity: SEVERITY.HIGH, domain: normalizeHost(url.hostname), url: url.origin + url.pathname });
    return;
  }

  // Scan the URL path + search-query parameters for trigger words.
  const haystack = decodeURIComponent(url.pathname + ' ' + [...url.searchParams.values()].join(' '));
  const hits = triggerMatcher.scan(haystack);
  if (hits.length) {
    queueEvent({
      type: EVENT_TYPES.TRIGGER_WORD,
      severity: worstSeverity(hits),
      domain: normalizeHost(url.hostname),
      url: url.origin + url.pathname,
      matchedTerms: hits.map((h) => h.term),
      category: hits[0].category,
      context: `URL/search matched ${hits.length} trigger term(s)`,
    });
  }
}

// ---- messages from content script / blocked page --------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.kind === 'trigger') {
    queueEvent({
      type: EVENT_TYPES.TRIGGER_WORD,
      severity: msg.severity || SEVERITY.MEDIUM,
      domain: normalizeHost(msg.domain || ''),
      url: msg.url,
      matchedTerms: (msg.matchedTerms || []).slice(0, 10),
      category: msg.category || 'page-text',
      context: msg.context || 'Trigger word found in page text',
    });
  } else if (msg.kind === 'bypass') {
    queueEvent({ type: EVENT_TYPES.BYPASS_ATTEMPT, severity: SEVERITY.HIGH, domain: normalizeHost(msg.domain || ''), detail: msg.detail || 'Requested access to a blocked page' });
    flushEvents();
  } else if (msg.kind === 'getStatus') {
    buildStatus().then(sendResponse);
    return true; // async response
  }
});

// ---- event queue ----------------------------------------------------------
async function queueEvent(partial) {
  const event = { ts: Date.now(), matchedTerms: [], ...partial };
  const { queue = [] } = await STORAGE.get('queue');
  queue.push(event);
  await STORAGE.set({ queue: queue.slice(-500) });
  if (queue.length >= FLUSH_THRESHOLD) flushEvents();
}

async function flushEvents() {
  const { serverUrl, deviceToken } = await getEnrollment();
  const { queue = [] } = await STORAGE.get('queue');
  if (!queue.length) return;
  if (!serverUrl || !deviceToken) return; // hold events until enrolled
  try {
    const res = await fetch(joinUrl(serverUrl, API.events), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ events: queue }),
    });
    if (res.ok) {
      await STORAGE.set({ queue: [], lastFlush: Date.now() });
    }
  } catch {
    // keep queue for next flush
  }
}

// ---- heartbeat ------------------------------------------------------------
async function heartbeat() {
  const { serverUrl, deviceToken } = await getEnrollment();
  if (!serverUrl || !deviceToken) return;
  try {
    await fetch(joinUrl(serverUrl, API.heartbeat), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ protectionOn: true }),
    });
  } catch {
    /* offline; will retry next alarm */
  }
}

// ---- status (for popup) ---------------------------------------------------
async function buildStatus() {
  const data = await STORAGE.get(['serverUrl', 'partnerName', 'partnerEmail', 'personName', 'lastSync', 'lastSyncError', 'queue', 'blockedDomains', 'config']);
  return {
    enrolled: Boolean(data.serverUrl),
    serverUrl: data.serverUrl || null,
    partnerName: data.partnerName || null,
    partnerEmail: data.partnerEmail || null,
    personName: data.personName || null,
    lastSync: data.lastSync || null,
    lastSyncError: data.lastSyncError || null,
    pendingEvents: (data.queue || []).length,
    blockedDomainCount: (data.blockedDomains || []).length,
    scanPageText: data.config?.scanPageText !== false,
  };
}

// ---- helpers --------------------------------------------------------------
function worstSeverity(hits) {
  const rank = { info: 0, low: 1, medium: 2, high: 3 };
  let worst = SEVERITY.LOW;
  for (const h of hits) if ((rank[h.severity] ?? 0) > (rank[worst] ?? 0)) worst = h.severity;
  return worst;
}
function joinUrl(base, path) {
  return String(base).replace(/\/+$/, '') + path;
}
