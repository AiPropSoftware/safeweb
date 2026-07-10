import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeHost,
  DomainMatcher,
  foldText,
  TriggerMatcher,
  redactSnippet,
} from './matcher.js';

test('normalizeHost strips scheme, www, trailing dot, lowercases', () => {
  assert.equal(normalizeHost('https://WWW.Example.COM/path?q=1'), 'example.com');
  assert.equal(normalizeHost('www.foo.bar.'), 'foo.bar');
  assert.equal(normalizeHost('  Sub.Example.com  '), 'sub.example.com');
  assert.equal(normalizeHost('not a host!!'), '');
  assert.equal(normalizeHost(''), '');
  assert.equal(normalizeHost(null), '');
});

test('DomainMatcher blocks domain and its subdomains', () => {
  const m = new DomainMatcher({ blocked: ['pornhub.com', 'xvideos.com'] });
  assert.equal(m.check('pornhub.com').blocked, true);
  assert.equal(m.check('www.pornhub.com').blocked, true);
  assert.equal(m.check('cdn.media.pornhub.com').blocked, true);
  assert.equal(m.check('https://xvideos.com/watch').blocked, true);
  assert.equal(m.check('example.com').blocked, false);
  // A domain that merely ends in the same string but is not a subdomain.
  assert.equal(m.check('notpornhub.com').blocked, false);
  assert.equal(m.check('pornhub.com.evil.com').blocked, false);
});

test('DomainMatcher allowlist overrides blocklist', () => {
  const m = new DomainMatcher({
    blocked: ['example.com'],
    allowed: ['safe.example.com'],
  });
  assert.equal(m.check('example.com').blocked, true);
  assert.equal(m.check('safe.example.com').blocked, false);
  assert.equal(m.check('safe.example.com').allowlisted, true);
});

test('foldText normalizes leetspeak, homoglyphs, and separators', () => {
  assert.equal(foldText('P0RN').folded, 'porn');
  assert.equal(foldText('p.o.r.n').squished, 'porn');
  assert.equal(foldText('p o r n').folded, 'p o r n');
  assert.equal(foldText('p o r n').squished, 'porn');
  // Cyrillic homoglyphs (о, р) fold to latin.
  assert.equal(foldText('pоrn').squished, 'porn');
  // Diacritics stripped.
  assert.equal(foldText('nüdé').squished, 'nude');
});

test('TriggerMatcher matches whole words case-insensitively', () => {
  const m = new TriggerMatcher([{ term: 'porn', category: 'explicit', severity: 'high' }]);
  assert.equal(m.test('I found some Porn online'), true);
  assert.equal(m.test('PORN'), true);
  // Should not match inside an unrelated longer word via the folded path.
  assert.equal(m.test('popcorn kernels'), false);
});

test('TriggerMatcher defeats simple obfuscation', () => {
  const m = new TriggerMatcher([{ term: 'porn' }]);
  assert.equal(m.test('p0rn'), true);
  assert.equal(m.test('p.o.r.n'), true);
  assert.equal(m.test('P O R N'), true);
});

test('TriggerMatcher short-term squished guard avoids false positives', () => {
  // "xxx" is length 3 (< 5) so it must match as a whole token, not inside words.
  const m = new TriggerMatcher([{ term: 'xxx' }]);
  assert.equal(m.test('rated xxx content'), true);
  assert.equal(m.test('maxxxis tires'), false);
});

test('TriggerMatcher handles multi-word terms (adjacency required)', () => {
  const m = new TriggerMatcher([{ term: 'free porn', category: 'search-intent' }]);
  assert.equal(m.test('searching for free porn now'), true);
  // Non-adjacent words must NOT match a multi-word phrase.
  assert.equal(m.test('free stuff and unrelated words here'), false);
  assert.equal(m.test('this is free'), false);
});

test('TriggerMatcher single-word term catches fully-spaced obfuscation', () => {
  const m = new TriggerMatcher([{ term: 'porn' }]);
  assert.equal(m.test('f r e e p o r n'), true); // squished catches "porn"
});

test('TriggerMatcher avoids Scunthorpe-style cross-word false positives', () => {
  const m = new TriggerMatcher([{ term: 'ass sex', category: 'explicit' }]);
  // "compass sextant" squished contains "asssex" but must NOT match a phrase.
  assert.equal(m.test('the compass sextant on the boat'), false);
});

test('TriggerMatcher returns category + severity and dedups', () => {
  const m = new TriggerMatcher([
    { term: 'porn', category: 'explicit', severity: 'high' },
    { term: 'nude', category: 'explicit', severity: 'high' },
  ]);
  const hits = m.scan('porn porn nude');
  assert.equal(hits.length, 2);
  const porn = hits.find((h) => h.term === 'porn');
  assert.equal(porn.category, 'explicit');
  assert.equal(porn.severity, 'high');
});

test('redactSnippet masks the matched term and windows context', () => {
  const snip = redactSnippet('please find free porn videos here', ['porn']);
  assert.ok(snip.includes('[redacted]'));
  assert.ok(!snip.toLowerCase().includes('porn'));
  assert.ok(snip.includes('videos'));
});

test('redactSnippet never leaks the full text on fold-only matches', () => {
  const snip = redactSnippet('p0rn everywhere', ['porn']);
  // 'porn' is not literally present, so it falls back to a masked preview.
  assert.ok(!snip.includes('everywhere'));
});
