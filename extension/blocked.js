// Blocked-page logic. Shows which domain was blocked and who the accountability
// partner is, and lets the user send a (logged) access request. There is no
// bypass here by design.

const params = new URLSearchParams(location.search);
const domain = params.get('d') || '';

const domainEl = document.getElementById('domain');
if (domain) domainEl.textContent = domain;

chrome.storage.local.get(['partnerName', 'partnerEmail']).then(({ partnerName, partnerEmail }) => {
  const who = document.getElementById('who');
  if (partnerName) {
    who.textContent = `Your accountability partner is ${partnerName}${partnerEmail ? ' (' + partnerEmail + ')' : ''}.`;
  } else {
    who.textContent = 'This device is protected by SafeWeb.';
  }
});

document.getElementById('backBtn').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.href = 'about:blank';
});

document.getElementById('requestBtn').addEventListener('click', () => {
  try {
    chrome.runtime.sendMessage({ kind: 'bypass', domain, detail: `Requested access to blocked site ${domain}` });
  } catch {
    /* worker asleep; the request is best-effort */
  }
  document.getElementById('requestNote').hidden = false;
  document.getElementById('requestBtn').disabled = true;
});
