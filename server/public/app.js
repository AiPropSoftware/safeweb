// SafeWeb accountability dashboard — a small dependency-free SPA.
// API paths mirror shared/protocol.js (kept in sync manually; both are versioned).

const API = {
  register: '/api/v1/partner/register',
  login: '/api/v1/partner/login',
  logout: '/api/v1/partner/logout',
  me: '/api/v1/partner/me',
  reports: '/api/v1/partner/reports',
  devices: '/api/v1/partner/devices',
  settings: '/api/v1/partner/settings',
  stream: '/api/v1/partner/stream',
  enrollCreate: '/api/v1/enroll/code',
};

const state = {
  partner: null,
  tab: 'overview',
  reports: null,
  devices: null,
  settings: null,
  liveAlerts: [],
  es: null,
};

const app = document.getElementById('app');

// --- tiny helpers ----------------------------------------------------------
const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString() : '—');
const fmtAgo = (ts) => {
  if (!ts) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  if (res.status === 401) {
    state.partner = null;
  }
  return { status: res.status, json };
}

// --- boot ------------------------------------------------------------------
async function boot() {
  const me = await api(API.me);
  if (me.status === 200) {
    state.partner = me.json.partner;
    renderApp();
  } else {
    renderAuth();
  }
}

// --- auth ------------------------------------------------------------------
function renderAuth(mode = 'login', error = '') {
  disconnectStream();
  app.innerHTML = '';
  const wrap = el(`
    <div class="auth-wrap">
      <div class="card auth-card">
        <div class="brand" style="font-size:1.3rem;margin-bottom:0.4rem;"><span>🛡️</span> SafeWeb</div>
        <p class="muted">${mode === 'login' ? 'Sign in to your accountability dashboard.' : 'Create an accountability partner / parent account.'}</p>
        <form id="authForm">
          ${mode === 'register' ? '<label>Your name</label><input name="name" autocomplete="name" required />' : ''}
          <label>Email</label>
          <input name="email" type="email" autocomplete="username" required />
          <label>Password</label>
          <input name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" minlength="8" required />
          <div class="error" id="authError">${esc(error)}</div>
          <div class="row" style="margin-top:0.9rem;">
            <button class="primary" type="submit">${mode === 'login' ? 'Sign in' : 'Create account'}</button>
            <button class="ghost" type="button" id="switchMode">${mode === 'login' ? 'Need an account?' : 'Have an account?'}</button>
          </div>
        </form>
        <p class="muted" style="margin-top:1rem;">SafeWeb monitoring is always visible to the person being protected. See our consent policy.</p>
      </div>
    </div>`);
  wrap.querySelector('#switchMode').onclick = () => renderAuth(mode === 'login' ? 'register' : 'login');
  wrap.querySelector('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = Object.fromEntries(fd.entries());
    const res = await api(mode === 'login' ? API.login : API.register, { method: 'POST', body });
    if (res.status === 200 || res.status === 201) {
      state.partner = res.json.partner;
      renderApp();
    } else {
      renderAuth(mode, res.json?.error || 'Something went wrong.');
    }
  };
  app.appendChild(wrap);
}

// --- app shell -------------------------------------------------------------
function renderApp() {
  app.innerHTML = '';
  const tabs = [
    ['overview', 'Overview'],
    ['live', 'Live'],
    ['devices', 'Devices'],
    ['reports', 'Activity'],
    ['settings', 'Settings'],
    ['enroll', 'Add device'],
  ];
  const shell = el(`
    <div>
      <div class="topbar">
        <div class="brand"><span class="dot"></span> 🛡️ SafeWeb</div>
        <div class="spacer"></div>
        <span class="pill">${esc(state.partner.name || state.partner.email)}</span>
        <button class="ghost" id="themeBtn" title="Toggle theme">◐</button>
        <button class="ghost" id="logoutBtn">Sign out</button>
      </div>
      <div class="tabs">${tabs.map(([k, l]) => `<button class="tab ${state.tab === k ? 'active' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
      <main id="view"></main>
    </div>`);
  shell.querySelectorAll('.tab').forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; renderView(); updateTabs(); }));
  shell.querySelector('#logoutBtn').onclick = async () => { await api(API.logout, { method: 'POST' }); state.partner = null; renderAuth(); };
  shell.querySelector('#themeBtn').onclick = toggleTheme;
  app.appendChild(shell);
  connectStream();
  renderView();
}

function updateTabs() {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : cur === 'light' ? '' : 'dark';
  if (next) document.documentElement.setAttribute('data-theme', next);
  else document.documentElement.removeAttribute('data-theme');
}

const view = () => document.getElementById('view');

async function renderView() {
  const v = view();
  v.innerHTML = '<div class="loading">Loading…</div>';
  try {
    if (state.tab === 'overview') return renderOverview(v);
    if (state.tab === 'live') return renderLive(v);
    if (state.tab === 'devices') return renderDevices(v);
    if (state.tab === 'reports') return renderReports(v);
    if (state.tab === 'settings') return renderSettings(v);
    if (state.tab === 'enroll') return renderEnroll(v);
  } catch (err) {
    v.innerHTML = `<div class="card"><p class="error">Could not load: ${esc(err.message)}</p></div>`;
  }
}

// --- overview --------------------------------------------------------------
async function renderOverview(v) {
  const [rep, dev] = await Promise.all([api(API.reports + '?since=' + (Date.now() - 7 * 864e5)), api(API.devices)]);
  if (!state.partner) return renderAuth();
  const s = rep.json.summary;
  const devices = dev.json.devices || [];
  const online = devices.filter((d) => d.online).length;
  v.innerHTML = '';
  v.appendChild(el(`
    <div>
      <div class="banner">🛡️ <strong>Transparent by design.</strong> Everyone protected by SafeWeb can see, in their browser, that monitoring is active and who their accountability partner is. <a href="/ETHICS.md" target="_blank">Our consent policy</a>.</div>
      <div class="tiles">
        <div class="tile"><div class="n">${s.total}</div><div class="l">Events · 7 days</div></div>
        <div class="tile"><div class="n">${s.byType?.blocked_site || 0}</div><div class="l">Sites blocked</div></div>
        <div class="tile"><div class="n">${s.byType?.trigger_word || 0}</div><div class="l">Trigger words</div></div>
        <div class="tile"><div class="n">${online}/${devices.length}</div><div class="l">Devices online</div></div>
      </div>
      <div class="card" style="margin-top:1rem;">
        <h2>By severity (7 days)</h2>
        <div id="sevBars"></div>
      </div>
      <div class="card">
        <h2>Top blocked domains</h2>
        <div id="domBars"></div>
      </div>
    </div>`));
  renderBars(v.querySelector('#sevBars'), ['high', 'medium', 'low', 'info'].map((k) => ({ key: k, count: s.bySeverity?.[k] || 0 })), { colorBySeverity: true });
  renderBars(v.querySelector('#domBars'), s.topDomains, {});
}

// --- live feed -------------------------------------------------------------
function renderLive(v) {
  v.innerHTML = '';
  v.appendChild(el(`
    <div class="card">
      <h2><span class="live-dot"></span>Live activity</h2>
      <p class="hint">High-severity events appear here the moment they happen, pushed from the device.</p>
      <div id="liveList">${state.liveAlerts.length ? '' : '<div class="empty">Waiting for activity…</div>'}</div>
    </div>`));
  const list = v.querySelector('#liveList');
  state.liveAlerts.forEach((a) => list.appendChild(alertRow(a)));
}

function alertRow(a) {
  return el(`
    <div class="event">
      <span class="chip sev-${esc(a.severity)}">${esc(a.severity)}</span>
      <div class="body">
        <strong>${esc(prettyType(a.type))}</strong>
        ${a.domain ? ' · <code>' + esc(a.domain) + '</code>' : ''}
        ${a.matchedTerms?.length ? ' · terms: ' + a.matchedTerms.map((t) => `<span class="tag">${esc(t)}</span>`).join('') : ''}
        ${a.context ? `<div class="meta">${esc(a.context)}</div>` : ''}
        <div class="meta">${esc(a.deviceLabel || 'device')}${a.personName ? ' · ' + esc(a.personName) : ''}</div>
      </div>
      <span class="meta">${esc(fmtAgo(a.ts))}</span>
    </div>`);
}

function prettyType(t) {
  return ({ blocked_site: 'Blocked site', trigger_word: 'Trigger word', bypass_attempt: 'Bypass attempt', protection_off: 'Protection turned OFF', protection_on: 'Protection on', allowed_visit: 'Visit', heartbeat_missed: 'Device went silent' }[t] || t);
}

// --- devices ---------------------------------------------------------------
async function renderDevices(v) {
  const dev = await api(API.devices);
  if (!state.partner) return renderAuth();
  const devices = dev.json.devices || [];
  v.innerHTML = '';
  if (!devices.length) {
    v.appendChild(el('<div class="card"><h2>No devices yet</h2><p class="hint">Go to <strong>Add device</strong> to create an enrollment code.</p></div>'));
    return;
  }
  const container = el('<div class="grid"></div>');
  for (const d of devices) {
    container.appendChild(el(`
      <div class="card">
        <h2>${esc(d.label)}</h2>
        <p class="hint">Protecting: <strong>${esc(d.personName || 'unspecified')}</strong></p>
        <p>${d.online ? '<span class="online">● Online</span>' : '<span class="offline">● Offline</span>'} · last seen ${esc(fmtAgo(d.lastSeenTs))}</p>
        <p class="muted">Protection: ${d.active ? 'active' : '<span class="chip sev-high">OFF</span>'}</p>
        <p class="muted">Consent acknowledged: ${d.consentAckTs ? '✔ ' + esc(fmtTime(d.consentAckTs)) : '—'}</p>
        <p class="muted">${d.recentEvents} events in last 24h</p>
      </div>`));
  }
  v.appendChild(container);
}

// --- reports ---------------------------------------------------------------
async function renderReports(v) {
  const rep = await api(API.reports + '?limit=200');
  if (!state.partner) return renderAuth();
  const events = rep.json.events || [];
  v.innerHTML = '';
  const card = el(`<div class="card"><h2>Activity log</h2><p class="hint">Most recent first. Snippets are redacted on-device before they reach you.</p><div id="log"></div></div>`);
  const log = card.querySelector('#log');
  if (!events.length) log.innerHTML = '<div class="empty">No activity recorded yet.</div>';
  for (const e of events) log.appendChild(alertRow({ ...e, ts: e.receivedTs }));
  v.appendChild(card);
}

// --- settings --------------------------------------------------------------
async function renderSettings(v) {
  const res = await api(API.settings);
  if (!state.partner) return renderAuth();
  const s = res.json.settings;
  const blockCats = res.json.availableBlockCategories || [];
  const trigCats = res.json.availableTriggerCategories || [];
  v.innerHTML = '';
  const card = el(`
    <div class="card">
      <h2>Filtering settings</h2>
      <p class="hint">Changes sync to every device on their next check-in.</p>
      <form id="settingsForm">
        <label>Blocked site categories</label>
        <div id="blockCats">${blockCats.map((c) => checkboxTag('bc_' + c, c, s.blockedCategories.includes(c))).join('')}</div>
        <label>Trigger-word categories</label>
        <div id="trigCats">${trigCats.map((c) => checkboxTag('tc_' + c, c, s.triggerCategories.includes(c))).join('')}</div>
        <label>Extra blocked domains (comma or newline separated)</label>
        <textarea name="customBlockedDomains" rows="2">${esc((s.customBlockedDomains || []).join(', '))}</textarea>
        <label>Extra trigger words</label>
        <textarea name="customTriggerWords" rows="2">${esc((s.customTriggerWords || []).join(', '))}</textarea>
        <label>Allowlisted domains (never blocked)</label>
        <textarea name="allowedDomains" rows="2">${esc((s.allowedDomains || []).join(', '))}</textarea>
        <div class="checkbox-row"><input type="checkbox" id="scanPageText" ${s.scanPageText ? 'checked' : ''}/><label for="scanPageText" style="margin:0;">Scan visible page text for trigger words (not just URLs)</label></div>
        <div class="checkbox-row"><input type="checkbox" id="recordAllowedVisits" ${s.recordAllowedVisits ? 'checked' : ''}/><label for="recordAllowedVisits" style="margin:0;">Record low-signal browsing history (more visibility, less privacy)</label></div>
        <div class="row" style="margin-top:1rem;"><button class="primary" type="submit">Save settings</button><span class="muted" id="settingsMsg"></span></div>
      </form>
    </div>`);
  card.querySelector('#settingsForm').onsubmit = async (e) => {
    e.preventDefault();
    const listVal = (name) => (e.target[name].value || '').split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
    const checkedCats = (prefix, all) => all.filter((c) => card.querySelector('#' + prefix + c)?.checked);
    const patch = {
      blockedCategories: checkedCats('bc_', blockCats),
      triggerCategories: checkedCats('tc_', trigCats),
      customBlockedDomains: listVal('customBlockedDomains'),
      customTriggerWords: listVal('customTriggerWords'),
      allowedDomains: listVal('allowedDomains'),
      scanPageText: card.querySelector('#scanPageText').checked,
      recordAllowedVisits: card.querySelector('#recordAllowedVisits').checked,
    };
    const out = await api(API.settings, { method: 'PUT', body: { settings: patch } });
    card.querySelector('#settingsMsg').textContent = out.status === 200 ? `Saved (config rev ${out.json.settings.revision}).` : 'Save failed.';
  };
  v.appendChild(card);
}

function checkboxTag(id, label, checked) {
  return `<span class="checkbox-row" style="display:inline-flex;margin-right:1rem;"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}/><label for="${id}" style="margin:0;">${esc(label)}</label></span>`;
}

// --- enroll ----------------------------------------------------------------
function renderEnroll(v) {
  v.innerHTML = '';
  const card = el(`
    <div class="card">
      <h2>Add a device</h2>
      <p class="hint">Create an enrollment code, then enter it in the SafeWeb browser extension or run <code>safeweb-agent enroll</code> on the computer being protected.</p>
      <form id="enrollForm">
        <label>Device label</label>
        <input name="label" placeholder="e.g. Sam's laptop" required />
        <label>Who is being protected? (name)</label>
        <input name="personName" placeholder="e.g. Sam" />
        <button class="primary" type="submit" style="margin-top:0.8rem;">Generate code</button>
      </form>
      <div id="enrollResult"></div>
      <ul class="checklist">
        <li>The person installs the SafeWeb extension and enters this code.</li>
        <li>They must tick a consent box — SafeWeb won't monitor without it.</li>
        <li>A visible "Protected by SafeWeb" badge stays in their browser.</li>
      </ul>
    </div>`);
  card.querySelector('#enrollForm').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    const res = await api(API.enrollCreate, { method: 'POST', body });
    const out = card.querySelector('#enrollResult');
    if (res.status === 201) {
      out.innerHTML = `<div class="code-box">${esc(res.json.code)}</div><p class="muted">Valid until ${esc(fmtTime(res.json.expiresTs))}. Read it to the person being protected.</p>`;
    } else {
      out.innerHTML = `<p class="error">Could not create a code.</p>`;
    }
  };
  v.appendChild(card);
}

// --- charts (inline, no libs) ----------------------------------------------
function renderBars(container, rows, { colorBySeverity } = {}) {
  container.innerHTML = '';
  const data = (rows || []).filter((r) => r.count > 0);
  if (!data.length) {
    container.innerHTML = '<div class="empty">No data yet.</div>';
    return;
  }
  const max = Math.max(...data.map((r) => r.count));
  const sevColor = { high: 'var(--high)', medium: 'var(--warn)', low: 'var(--info)', info: 'var(--info)' };
  for (const r of data) {
    const pct = Math.round((r.count / max) * 100);
    const color = colorBySeverity ? sevColor[r.key] || 'var(--brand)' : 'var(--brand)';
    container.appendChild(el(`
      <div class="bar-row">
        <span class="bar-label" title="${esc(r.key)}">${esc(r.key)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color};"></div></div>
        <span class="muted">${r.count}</span>
      </div>`));
  }
}

// --- live stream (SSE) -----------------------------------------------------
function connectStream() {
  disconnectStream();
  try {
    const es = new EventSource(API.stream, { withCredentials: true });
    es.addEventListener('alert', (ev) => {
      try {
        const alert = JSON.parse(ev.data);
        state.liveAlerts.unshift(alert);
        state.liveAlerts = state.liveAlerts.slice(0, 100);
        if (state.tab === 'live') renderLive(view());
        flashTab();
      } catch {
        /* ignore malformed */
      }
    });
    es.onerror = () => { /* browser auto-reconnects */ };
    state.es = es;
  } catch {
    /* EventSource unsupported */
  }
}
function disconnectStream() {
  if (state.es) { state.es.close(); state.es = null; }
}
function flashTab() {
  const t = document.querySelector('.tab[data-tab="live"]');
  if (t && !t.classList.contains('active')) t.style.color = 'var(--high)';
}

boot();
