import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyManagedBlock,
  removeManagedBlock,
  hasManagedBlock,
  extractManagedDomains,
  renderManagedBlock,
  START_MARKER,
  END_MARKER,
  backupHostsFile,
  readHostsText,
  writeHostsText,
} from './hosts.js';

const PRE = '127.0.0.1 localhost\n255.255.255.255 broadcasthost\n::1 localhost\n';

test('renderManagedBlock sinkholes each domain + www variant to 0.0.0.0', () => {
  const block = renderManagedBlock(['pornhub.com', 'www.example.com']);
  assert.ok(block.includes(START_MARKER) && block.includes(END_MARKER));
  assert.ok(block.includes('0.0.0.0 pornhub.com'));
  assert.ok(block.includes('0.0.0.0 www.pornhub.com'));
  // www.example.com collapses to example.com base (no double www).
  assert.ok(block.includes('0.0.0.0 example.com'));
  assert.ok(block.includes('0.0.0.0 www.example.com'));
  assert.ok(!block.includes('www.www.'));
});

test('applyManagedBlock adds a block and preserves pre-existing content exactly', () => {
  const out = applyManagedBlock(PRE, ['pornhub.com']);
  assert.ok(out.startsWith(PRE), 'original lines must be preserved verbatim at the top');
  assert.ok(hasManagedBlock(out));
  assert.ok(out.includes('0.0.0.0 pornhub.com'));
});

test('applyManagedBlock is idempotent — re-install replaces, never appends', () => {
  let out = applyManagedBlock(PRE, ['a.com']);
  out = applyManagedBlock(out, ['b.com', 'c.com']);
  const starts = (out.match(new RegExp(escapeRe(START_MARKER), 'g')) || []).length;
  const ends = (out.match(new RegExp(escapeRe(END_MARKER), 'g')) || []).length;
  assert.equal(starts, 1, 'exactly one start marker');
  assert.equal(ends, 1, 'exactly one end marker');
  assert.ok(!out.includes('a.com'), 'old domains are gone after replace');
  assert.ok(out.includes('0.0.0.0 b.com') && out.includes('0.0.0.0 c.com'));
  assert.ok(out.startsWith(PRE));
});

test('removeManagedBlock restores content and drops the markers', () => {
  const withBlock = applyManagedBlock(PRE, ['x.com']);
  const removed = removeManagedBlock(withBlock);
  assert.equal(hasManagedBlock(removed), false);
  assert.ok(!removed.includes(START_MARKER) && !removed.includes(END_MARKER));
  assert.ok(removed.includes('127.0.0.1 localhost'));
  assert.ok(!removed.includes('x.com'));
});

test('extractManagedDomains reconstructs the installed base domains', () => {
  const out = applyManagedBlock(PRE, ['pornhub.com', 'xvideos.com']);
  const domains = extractManagedDomains(out).sort();
  assert.deepEqual(domains, ['pornhub.com', 'xvideos.com']);
});

test('malformed input is handled safely (no throw, no corruption)', () => {
  // Only a start marker.
  const halfStart = PRE + START_MARKER + '\n0.0.0.0 y.com\n';
  assert.equal(hasManagedBlock(halfStart), false, 'a lone start marker is not a valid block');
  assert.doesNotThrow(() => removeManagedBlock(halfStart));
  assert.doesNotThrow(() => applyManagedBlock(halfStart, ['z.com']));
  // Only an end marker.
  const halfEnd = PRE + END_MARKER + '\n';
  assert.equal(hasManagedBlock(halfEnd), false);
  assert.equal(removeManagedBlock(halfEnd), halfEnd, 'stray end marker left untouched');
  // End before start.
  const reversed = PRE + END_MARKER + '\n' + START_MARKER + '\n';
  assert.equal(hasManagedBlock(reversed), false);
  // Empty.
  assert.equal(hasManagedBlock(''), false);
  assert.doesNotThrow(() => applyManagedBlock('', ['q.com']));
});

test('fs helpers round-trip and backup against a temp file (never the real hosts)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'safeweb-hosts-'));
  try {
    const p = join(dir, 'hosts');
    writeFileSync(p, PRE);
    const backup = backupHostsFile(p, 12345);
    assert.ok(existsSync(backup));
    assert.equal(readFileSync(backup, 'utf8'), PRE);
    writeHostsText(p, applyManagedBlock(readHostsText(p), ['pornhub.com']));
    const after = readHostsText(p);
    assert.ok(hasManagedBlock(after));
    assert.ok(after.startsWith(PRE));
    // Uninstall path.
    writeHostsText(p, removeManagedBlock(readHostsText(p)));
    assert.equal(hasManagedBlock(readHostsText(p)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
