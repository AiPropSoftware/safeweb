// SafeWeb detection engine — domain blocking + trigger-word scanning.
//
// Design goals:
//   * Deterministic and side-effect free so it is trivially testable and can
//     run identically on the server and inside the browser extension.
//   * Resistant to trivial obfuscation (p0rn, p.o.r.n, pоrn with a Cyrillic o).
//   * Privacy preserving: when we report a hit we return a short *redacted*
//     snippet, never the surrounding page text.

// ---------------------------------------------------------------------------
// Domain matching
// ---------------------------------------------------------------------------

/**
 * Normalize a hostname for comparison: lowercase, strip a trailing dot and a
 * leading "www.". Returns '' for anything that is not a plausible host.
 * @param {string} host
 */
export function normalizeHost(host) {
  if (!host || typeof host !== 'string') return '';
  let h = host.trim().toLowerCase();
  // Accept a full URL and extract the host.
  if (h.includes('://')) {
    try {
      h = new URL(h).hostname;
    } catch {
      /* fall through and treat the raw string as a host */
    }
  }
  h = h.replace(/\.$/, '').replace(/^www\./, '');
  // Reject obviously non-host strings.
  if (!/^[a-z0-9.-]+$/.test(h)) return '';
  return h;
}

/**
 * A DomainMatcher answers "is this host blocked?" using a set of exact domains
 * (each of which also matches its subdomains) plus an allowlist that wins.
 */
export class DomainMatcher {
  /**
   * @param {Object} opts
   * @param {string[]} [opts.blocked]  domains to block (subdomains included)
   * @param {string[]} [opts.allowed]  domains that override the blocklist
   */
  constructor({ blocked = [], allowed = [] } = {}) {
    this.blocked = new Set(blocked.map(normalizeHost).filter(Boolean));
    this.allowed = new Set(allowed.map(normalizeHost).filter(Boolean));
  }

  /**
   * Walk a host and its parent domains ("a.b.example.com" -> "b.example.com"
   * -> "example.com") checking membership. Returns the matched rule or null.
   * @param {Set<string>} set
   * @param {string} host
   * @returns {string|null}
   */
  static _matchDomainSet(set, host) {
    if (set.has(host)) return host;
    let idx = host.indexOf('.');
    while (idx !== -1) {
      const parent = host.slice(idx + 1);
      if (set.has(parent)) return parent;
      idx = host.indexOf('.', idx + 1);
    }
    return null;
  }

  /**
   * @param {string} rawHost hostname or full URL
   * @returns {{ blocked: boolean, rule: string|null, allowlisted: boolean }}
   */
  check(rawHost) {
    const host = normalizeHost(rawHost);
    if (!host) return { blocked: false, rule: null, allowlisted: false };
    const allowRule = DomainMatcher._matchDomainSet(this.allowed, host);
    if (allowRule) return { blocked: false, rule: allowRule, allowlisted: true };
    const blockRule = DomainMatcher._matchDomainSet(this.blocked, host);
    return { blocked: Boolean(blockRule), rule: blockRule, allowlisted: false };
  }
}

// ---------------------------------------------------------------------------
// Text normalization for trigger-word scanning
// ---------------------------------------------------------------------------

// Common leetspeak / homoglyph substitutions used to smuggle words past naive
// filters. We fold them back to their base letter before matching.
const CHAR_FOLD = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
  '!': 'i',
  // A few frequent Cyrillic/Greek homoglyphs.
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  х: 'x',
  ѕ: 's',
  і: 'i',
  ο: 'o',
  ρ: 'p',
};

/**
 * Fold a string into a comparable canonical form:
 *   * Unicode NFKD + strip diacritics
 *   * lowercase
 *   * map leet/homoglyph characters to their base letter
 *   * collapse runs of separators (spaces, dots, dashes) that are used to
 *     break up words ("p o r n", "p.o.r.n") into nothing between letters
 *
 * We return two views:
 *   * `folded` — separators preserved as single spaces (for word-boundary matches)
 *   * `squished` — all non-letters removed (catches "p.o.r.n" style splits)
 * @param {string} text
 */
export function foldText(text) {
  if (!text || typeof text !== 'string') return { folded: '', squished: '' };
  let s = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  s = s.toLowerCase();
  let out = '';
  for (const ch of s) {
    out += CHAR_FOLD[ch] ?? ch;
  }
  // folded: keep alphanumerics; turn everything else into a single space.
  const folded = out.replace(/[^a-z0-9]+/g, ' ').trim();
  // squished: strip everything but letters/digits (defeats separator splitting).
  const squished = out.replace(/[^a-z0-9]+/g, '');
  return { folded, squished };
}

/**
 * A TriggerMatcher scans text for a set of terms, each carrying a category and
 * severity. It matches on whole words (in the folded view) *and* on contiguous
 * letter sequences (in the squished view) to defeat separator obfuscation,
 * while using a per-term minimum length to avoid the squished view creating
 * false positives from short terms embedded in longer words.
 */
export class TriggerMatcher {
  /**
   * @param {Array<{term:string, category?:string, severity?:string}>} terms
   */
  constructor(terms = []) {
    /** @type {Array<{raw:string, folded:string, squished:string, category:string, severity:string}>} */
    this.terms = [];
    for (const t of terms) {
      const raw = typeof t === 'string' ? t : t?.term;
      if (!raw) continue;
      const { folded, squished } = foldText(raw);
      if (!folded) continue;
      this.terms.push({
        raw,
        folded,
        squished,
        category: (typeof t === 'object' && t.category) || 'custom',
        severity: (typeof t === 'object' && t.severity) || 'medium',
      });
    }
  }

  /**
   * Scan text and return every distinct term that matched.
   * @param {string} text
   * @returns {Array<{term:string, category:string, severity:string}>}
   */
  scan(text) {
    const { folded, squished } = foldText(text);
    if (!folded) return [];
    // Pad with spaces so a boundary check is just a substring test.
    const paddedFolded = ` ${folded} `;
    const hits = new Map(); // raw -> match record (dedup)
    for (const t of this.terms) {
      let matched = false;
      // 1) Whole-word / whole-phrase match in the folded (separator-normalized)
      //    view. Catches "Porn", "p0rn" (leet folds before matching), and
      //    multi-word phrases like "free porn" with normal spacing.
      if (paddedFolded.includes(` ${t.folded} `)) {
        matched = true;
      }
      // 2) Contiguous squished match — defeats separator/space injection like
      //    "p.o.r.n" or "p o r n". Restricted to single-word terms of length
      //    >= 4 to avoid Scunthorpe-style false positives across word
      //    boundaries (a multi-word term squished could span unrelated words).
      else if (
        !t.folded.includes(' ') &&
        t.squished.length >= 4 &&
        squished.includes(t.squished)
      ) {
        matched = true;
      }
      if (matched) {
        hits.set(t.raw, { term: t.raw, category: t.category, severity: t.severity });
      }
    }
    return [...hits.values()];
  }

  /**
   * Convenience: does any term match?
   * @param {string} text
   */
  test(text) {
    return this.scan(text).length > 0;
  }
}

// ---------------------------------------------------------------------------
// Privacy helpers
// ---------------------------------------------------------------------------

/**
 * Produce a short, redacted snippet around the first matched term so the
 * accountability partner gets useful context ("...search for <redacted> shoes")
 * without the device shipping the whole page. The matched term itself is
 * masked to avoid re-broadcasting explicit words.
 *
 * @param {string} text  original text
 * @param {string[]} matchedTerms terms that were found
 * @param {{ window?: number }} [opts]
 * @returns {string}
 */
export function redactSnippet(text, matchedTerms, opts = {}) {
  const window = opts.window ?? 24;
  if (!text) return '';
  const lower = text.toLowerCase();
  let pos = -1;
  let hitLen = 0;
  for (const term of matchedTerms || []) {
    const p = lower.indexOf(String(term).toLowerCase());
    if (p !== -1 && (pos === -1 || p < pos)) {
      pos = p;
      hitLen = String(term).length;
    }
  }
  if (pos === -1) {
    // Term only matched after folding; return a truncated, mask-free preview.
    return maskAll(text).slice(0, window * 2 + 5).trim();
  }
  const start = Math.max(0, pos - window);
  const end = Math.min(text.length, pos + hitLen + window);
  const before = (start > 0 ? '…' : '') + text.slice(start, pos);
  const after = text.slice(pos + hitLen, end) + (end < text.length ? '…' : '');
  return `${before}[redacted]${after}`.replace(/\s+/g, ' ').trim();
}

/** Replace word characters with • so an at-a-glance preview leaks nothing. */
function maskAll(text) {
  return text.replace(/\w/g, '•');
}
