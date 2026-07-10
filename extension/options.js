// Enrollment / settings page. The consent checkbox is a hard gate: the Enroll
// button stays disabled until it is ticked, and the server independently
// rejects any claim that doesn't carry consentAck:true.

import { API } from './vendor/protocol.js';

const $ = (id) => document.getElementById(id);
const store = chrome.storage.local;

const consent = $('consent');
const enrollBtn = $('enrollBtn');
consent.addEventListener('change', () => { enrollBtn.disabled = !consent.checked; });

function joinUrl(base, path) {
  return String(base).replace(/\/+$/, '') + path;
}

async function refreshStatus() {
  const s = await store.get(['serverUrl', 'deviceToken', 'partnerName', 'partnerEmail', 'personName', 'lastSync']);
  const enrolled = Boolean(s.serverUrl && s.deviceToken);
  $('status').innerHTML = enrolled
    ? `<div class="row"><span class="k">State</span><span class="ok">Enrolled ✔</span></div>
       <div class="row"><span class="k">Accountability partner</span><span>${esc(s.partnerName || '—')}${s.partnerEmail ? ' (' + esc(s.partnerEmail) + ')' : ''}</span></div>
       <div class="row"><span class="k">Server</span><span>${esc(s.serverUrl)}</span></div>`
    : `<div class="row"><span class="k">State</span><span>Not enrolled. Content blocking is active; enroll to add accountability.</span></div>`;
  $('enrollCard').hidden = enrolled;
  $('unenrollCard').hidden = !enrolled;
}

$('enrollForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('enrollError').textContent = '';
  if (!consent.checked) { $('enrollError').textContent = 'You must consent to enroll.'; return; }
  const serverUrl = $('serverUrl').value.trim();
  const code = $('code').value.trim();
  const personName = $('personName').value.trim();
  if (!serverUrl || !code) { $('enrollError').textContent = 'Server URL and code are required.'; return; }
  enrollBtn.disabled = true;
  try {
    const res = await fetch(joinUrl(serverUrl, API.enrollClaim), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, personName, deviceLabel: navigatorLabel(), consentAck: true }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `enrollment failed (${res.status})`);
    await store.set({
      serverUrl,
      deviceToken: json.deviceToken,
      deviceId: json.deviceId,
      partnerName: json.partnerName,
      partnerEmail: json.partnerEmail,
      personName,
    });
    // Ask the worker to pull config immediately.
    try { chrome.runtime.sendMessage({ kind: 'getStatus' }); } catch { /* noop */ }
    await refreshStatus();
  } catch (err) {
    $('enrollError').textContent = err.message;
  } finally {
    enrollBtn.disabled = !consent.checked;
  }
});

$('tokenBtn').addEventListener('click', async () => {
  if (!$('consentToken').checked) { $('enrollError').textContent = 'Consent is required to enroll with a token.'; return; }
  const serverUrl = $('tokenServerUrl').value.trim();
  const deviceToken = $('deviceToken').value.trim();
  if (!serverUrl || !deviceToken) { $('enrollError').textContent = 'Server URL and token required.'; return; }
  await store.set({ serverUrl, deviceToken });
  try { chrome.runtime.sendMessage({ kind: 'getStatus' }); } catch { /* noop */ }
  await refreshStatus();
});

$('unenrollBtn').addEventListener('click', async () => {
  const { serverUrl, deviceToken } = await store.get(['serverUrl', 'deviceToken']);
  // Notify the partner that protection is being turned off (heartbeat off).
  if (serverUrl && deviceToken) {
    try {
      await fetch(joinUrl(serverUrl, API.heartbeat), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${deviceToken}` },
        body: JSON.stringify({ protectionOn: false }),
      });
    } catch { /* best effort */ }
  }
  await store.remove(['serverUrl', 'deviceToken', 'deviceId', 'partnerName', 'partnerEmail', 'personName', 'config', 'triggerTerms', 'blockedDomains', 'queue']);
  await refreshStatus();
});

function navigatorLabel() {
  const ua = navigator.userAgent || '';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'device';
  return `${os} browser`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

refreshStatus();
