// Popup: shows the protected person exactly what SafeWeb is doing and who can
// see their reports. Reinforces the transparency guarantee on every open.

const body = document.getElementById('body');
const dot = document.getElementById('statusDot');

document.getElementById('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

const fmtAgo = (ts) => {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

chrome.runtime.sendMessage({ kind: 'getStatus' }, (status) => {
  if (chrome.runtime.lastError || !status) {
    body.innerHTML = '<p class="muted">Could not reach SafeWeb. Try reopening.</p>';
    return;
  }
  render(status);
});

function render(s) {
  const active = true; // static rules always protect; enrollment adds reporting
  dot.classList.add(s.enrolled ? 'on' : 'warn');

  let html = '';
  if (s.enrolled) {
    html += `<div class="banner ok">✔ Protection is active and monitoring is on.</div>`;
    html += `<div class="partner">👤 Accountability partner:<br><strong>${esc(s.partnerName || 'your partner')}</strong>${s.partnerEmail ? '<br><span class="muted">' + esc(s.partnerEmail) + '</span>' : ''}</div>`;
  } else {
    html += `<div class="banner warn">Content blocking is active, but this device is <strong>not yet enrolled</strong> with an accountability partner. Open settings to enroll.</div>`;
  }

  html += `<div style="margin-top:0.7rem;">`;
  html += row('Sites blocked', String(s.blockedDomainCount || 0) + ' domains');
  html += row('Page-text scanning', s.scanPageText ? 'on' : 'off');
  if (s.enrolled) {
    html += row('Last sync', fmtAgo(s.lastSync));
    html += row('Pending reports', String(s.pendingEvents || 0));
    if (s.personName) html += row('Protecting', esc(s.personName));
    if (s.lastSyncError) html += row('Note', '<span style="color:var(--high)">' + esc(s.lastSyncError) + '</span>');
  }
  html += `</div>`;
  html += `<p class="muted" style="margin-top:0.7rem;">SafeWeb never hides itself. Turning it off will notify your partner.</p>`;
  body.innerHTML = html;
}

function row(k, v) {
  return `<div class="row"><span class="k">${esc(k)}</span><span class="v">${v}</span></div>`;
}
