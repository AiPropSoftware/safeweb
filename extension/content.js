// SafeWeb content script (classic script, runs on every page).
//
// Two jobs:
//   1. Always show a visible "Protected by SafeWeb" badge — the transparency
//      guarantee. The person on this device is never left unaware that
//      monitoring is active.
//   2. When page-text scanning is enabled, scan the visible text for trigger
//      words, blur the matching region, and report a redacted snippet to the
//      background worker (which forwards a categorized event to the server).
//
// The detection engine is loaded dynamically from the extension's vendored copy
// so it is byte-identical to the server's.

(() => {
  // Only run in the top frame to avoid duplicate badges / rescans.
  if (window.top !== window.self) return;
  if (window.__safewebLoaded) return;
  window.__safewebLoaded = true;

  const MAX_SCAN_CHARS = 120000;
  const DEBOUNCE_MS = 1200;
  let matcher = null;
  let redact = null;
  let scanEnabled = true;
  let lastReportedKey = '';

  injectBadge();

  // Load config + the detection engine, then start scanning.
  init().catch(() => {});

  async function init() {
    const { config, triggerTerms } = await chrome.storage.local.get(['config', 'triggerTerms']);
    scanEnabled = !config || config.scanPageText !== false;
    updateBadgeTooltip();
    if (!scanEnabled || !triggerTerms || !triggerTerms.length) return;

    const mod = await import(chrome.runtime.getURL('vendor/matcher.js'));
    matcher = new mod.TriggerMatcher(triggerTerms.map((t) => ({ term: t.term, category: t.category, severity: t.severity })));
    redact = mod.redactSnippet;

    scheduleScan();
    const obs = new MutationObserver(scheduleScan);
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  let timer = null;
  function scheduleScan() {
    clearTimeout(timer);
    timer = setTimeout(runScan, DEBOUNCE_MS);
  }

  function runScan() {
    if (!matcher || !document.body) return;
    const text = (document.body.innerText || '').slice(0, MAX_SCAN_CHARS);
    const hits = matcher.scan(text);
    if (!hits.length) return;

    const terms = hits.map((h) => h.term);
    // De-dupe repeated reports for the same page state.
    const key = terms.sort().join('|');
    if (key === lastReportedKey) return;
    lastReportedKey = key;

    blurMatches(terms);
    showNotice();

    const context = redact ? redact(text, terms) : '[redacted]';
    try {
      chrome.runtime.sendMessage({
        kind: 'trigger',
        matchedTerms: terms,
        category: hits[0].category,
        severity: worst(hits),
        domain: location.hostname,
        url: location.origin + location.pathname,
        context,
      });
    } catch {
      /* worker asleep; background also scans URLs as a backstop */
    }
  }

  // Best-effort visual redaction: blur elements whose text contains a match.
  function blurMatches(terms) {
    const lowered = terms.map((t) => t.toLowerCase());
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const toBlur = new Set();
    let node;
    let budget = 4000; // cap work
    while ((node = walker.nextNode()) && budget-- > 0) {
      const tv = (node.nodeValue || '').toLowerCase();
      if (lowered.some((t) => tv.includes(t))) {
        const elp = node.parentElement;
        if (elp) toBlur.add(elp);
      }
    }
    for (const elm of toBlur) {
      elm.style.filter = 'blur(7px)';
      elm.style.transition = 'filter 0.1s';
      elm.setAttribute('data-safeweb-blurred', '1');
    }
  }

  function showNotice() {
    if (document.getElementById('safeweb-notice')) return;
    const n = document.createElement('div');
    n.id = 'safeweb-notice';
    n.textContent = '🛡️ SafeWeb hid content matching a trigger word and notified your accountability partner.';
    Object.assign(n.style, {
      position: 'fixed', top: '12px', left: '50%', transform: 'translateX(-50%)',
      background: '#1a2233', color: '#fff', padding: '10px 16px', borderRadius: '10px',
      font: '13px -apple-system, system-ui, sans-serif', zIndex: 2147483647,
      boxShadow: '0 6px 20px rgba(0,0,0,0.35)', maxWidth: '90vw',
    });
    document.documentElement.appendChild(n);
    setTimeout(() => n.remove(), 6000);
  }

  function injectBadge() {
    const badge = document.createElement('div');
    badge.id = 'safeweb-badge';
    badge.textContent = '🛡️ Protected by SafeWeb';
    badge.title = 'This device is protected and monitored by SafeWeb.';
    Object.assign(badge.style, {
      position: 'fixed', bottom: '10px', right: '10px', zIndex: 2147483646,
      background: 'rgba(26,34,51,0.86)', color: '#eaf0fb', padding: '5px 10px',
      borderRadius: '999px', font: '11px -apple-system, system-ui, sans-serif',
      letterSpacing: '0.02em', pointerEvents: 'none', userSelect: 'none',
      boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
    });
    const attach = () => {
      if (document.body && !document.getElementById('safeweb-badge')) document.documentElement.appendChild(badge);
    };
    if (document.body) attach();
    else document.addEventListener('DOMContentLoaded', attach);
  }

  function updateBadgeTooltip() {
    chrome.storage.local.get(['partnerName', 'partnerEmail']).then(({ partnerName, partnerEmail }) => {
      const b = document.getElementById('safeweb-badge');
      if (b && partnerName) b.title = `Monitored by SafeWeb. Accountability partner: ${partnerName}${partnerEmail ? ' <' + partnerEmail + '>' : ''}.`;
    });
  }

  function worst(hits) {
    const rank = { info: 0, low: 1, medium: 2, high: 3 };
    let w = 'low';
    for (const h of hits) if ((rank[h.severity] ?? 0) > (rank[w] ?? 0)) w = h.severity;
    return w;
  }
})();
