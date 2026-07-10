// SafeWeb system agent — pure hosts-file logic.
//
// This module is intentionally free of process.exit / argv / console side
// effects so it can be unit-tested in isolation. The only I/O helpers here
// (read/write/backup) take an explicit path parameter so tests operate on a
// temp file and NEVER touch the real /etc/hosts.
//
// The agent manages ONLY the region delimited by the exact marker comments
// below. Everything outside the markers is preserved byte-for-byte.

import fs from 'node:fs';

export const START_MARKER = '# >>> SafeWeb managed block >>>';
export const END_MARKER = '# <<< SafeWeb managed block <<<';

// 0.0.0.0 is used instead of 127.0.0.1: it is more reliable for blocking
// because nothing listens on it, so connections fail fast instead of hitting a
// local web server that may be running on 127.0.0.1.
export const BLOCK_IP = '0.0.0.0';

/**
 * Normalize a domain into a bare host (lowercase, no scheme, no path/port).
 * @param {unknown} d
 * @returns {string} '' when the input is not a usable host
 */
export function normalizeDomain(d) {
  if (d == null) return '';
  let s = String(d).trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // strip scheme
  s = s.replace(/\/.*$/, ''); // strip path
  s = s.replace(/:\d+$/, ''); // strip :port
  return s.trim();
}

/**
 * Render the managed block for a set of domains. Each domain is emitted twice:
 * the bare host and its `www.` variant, both pointed at BLOCK_IP. Domains are
 * de-duplicated (a `www.` prefix is collapsed to its base first). The returned
 * text has NO trailing newline — callers own line joining.
 *
 * @param {string[]} domains
 * @returns {string}
 */
export function renderManagedBlock(domains) {
  const lines = [
    START_MARKER,
    '# Managed automatically by SafeWeb (safeweb-agent). Do NOT edit inside these markers.',
    '# These entries block adult / blocklisted domains for every app on this device.',
    '# Remove them with `safeweb-agent uninstall` (which also notifies your accountability partner).',
  ];
  const seen = new Set();
  for (const raw of domains || []) {
    let base = normalizeDomain(raw);
    if (base.startsWith('www.')) base = base.slice(4);
    if (!base || seen.has(base)) continue;
    seen.add(base);
    lines.push(`${BLOCK_IP} ${base}`);
    lines.push(`${BLOCK_IP} www.${base}`);
  }
  lines.push(END_MARKER);
  return lines.join('\n');
}

/**
 * Locate the managed region within hosts text. Returns character offsets that
 * cover whole lines (from the start of the START marker line through the end of
 * the END marker line, including its trailing newline when present).
 *
 * Malformed input (only a start marker, only an end marker, or an end that
 * precedes the start) is reported as `{ found: false }` — never partially
 * matched, so we never corrupt a file we don't fully understand.
 *
 * @param {string} text
 */
export function findManagedRegion(text) {
  const s = String(text ?? '');
  const startIdx = s.indexOf(START_MARKER);
  const endIdx = s.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return { found: false };
  }
  const lineStart = s.lastIndexOf('\n', startIdx) + 1; // 0 when at BOF
  const nl = s.indexOf('\n', endIdx);
  const consumedEnd = nl === -1 ? s.length : nl + 1;
  return { found: true, lineStart, consumedEnd, hadTrailingNewline: nl !== -1 };
}

/**
 * @param {string} text
 * @returns {boolean}
 */
export function hasManagedBlock(text) {
  return findManagedRegion(text).found;
}

/**
 * Return new hosts text where ONLY the managed region is replaced with a freshly
 * rendered block for `domains`. If no managed region exists yet, the block is
 * appended at the end. Content outside the markers is preserved exactly.
 *
 * Idempotent: calling repeatedly always yields exactly one marker pair.
 *
 * @param {string} text
 * @param {string[]} domains
 * @returns {string}
 */
export function applyManagedBlock(text, domains) {
  const s = String(text ?? '');
  const block = renderManagedBlock(domains);
  const region = findManagedRegion(s);
  if (region.found) {
    const before = s.slice(0, region.lineStart);
    const after = s.slice(region.consumedEnd);
    let result = before + block;
    if (region.hadTrailingNewline) result += '\n' + after;
    return result;
  }
  let result = s;
  if (result.length && !result.endsWith('\n')) result += '\n';
  result += block + '\n';
  return result;
}

/**
 * Remove the managed region entirely, preserving everything outside the markers
 * byte-for-byte. Malformed / absent markers -> text returned unchanged.
 *
 * @param {string} text
 * @returns {string}
 */
export function removeManagedBlock(text) {
  const s = String(text ?? '');
  const region = findManagedRegion(s);
  if (!region.found) return s;
  const before = s.slice(0, region.lineStart);
  const after = s.slice(region.consumedEnd);
  return before + after;
}

/**
 * Extract the base domains currently managed in the hosts text. `www.` variants
 * are collapsed to their base and de-duplicated, so this reconstructs the
 * logical domain list that was installed.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function extractManagedDomains(text) {
  const s = String(text ?? '');
  const region = findManagedRegion(s);
  if (!region.found) return [];
  const inner = s.slice(region.lineStart, region.consumedEnd);
  const out = [];
  const seen = new Set();
  for (const line of inner.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue; // need "<ip> <host>"
    for (const host of parts.slice(1)) {
      let base = host.toLowerCase();
      if (base.startsWith('www.')) base = base.slice(4);
      if (!base || seen.has(base)) continue;
      seen.add(base);
      out.push(base);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Thin I/O helpers. Every one takes an explicit path so nothing here can ever
// touch a hard-coded /etc/hosts. The CLI supplies the real OS path; tests
// supply a temp file.
// ---------------------------------------------------------------------------

/**
 * @param {string} path
 * @returns {string}
 */
export function readHostsText(path) {
  return fs.readFileSync(path, 'utf8');
}

/**
 * @param {string} path
 * @param {string} text
 */
export function writeHostsText(path, text) {
  fs.writeFileSync(path, text);
}

/**
 * Write a timestamped `.bak` copy of `srcPath`. The timestamp is a PARAMETER
 * (the CLI passes Date.now()) so this stays deterministic and testable — never
 * call Date.now() in here. Returns the backup path, or null if the source does
 * not exist.
 *
 * @param {string} srcPath
 * @param {number|string} timestamp
 * @returns {string|null}
 */
export function backupHostsFile(srcPath, timestamp) {
  if (!fs.existsSync(srcPath)) return null;
  const backupPath = `${srcPath}.safeweb-${timestamp}.bak`;
  fs.copyFileSync(srcPath, backupPath);
  return backupPath;
}
