// Extension integrity + behaviour tests.
//
// The extension's runtime code depends on browser-only chrome.* APIs so we
// can't execute background.js/content.js under node. Instead we assert:
//   1. Every JS file parses (see npm run test — `node --check` in CI).
//   2. The manifest is valid and references files that exist.
//   3. The vendored detection engine — the exact code the extension imports —
//      behaves as the extension relies on (blocking + trigger detection).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DomainMatcher, TriggerMatcher } from './vendor/matcher.js';
import { API, EVENT_TYPES } from './vendor/protocol.js';

const here = dirname(fileURLToPath(import.meta.url));

test('manifest.json is valid MV3 and references existing files', () => {
  const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.type, 'module');
  const referenced = [
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap((c) => c.js),
    manifest.action.default_popup,
    manifest.options_page,
    ...manifest.declarative_net_request.rule_resources.map((r) => r.path),
    ...Object.values(manifest.icons),
    ...manifest.web_accessible_resources.flatMap((w) => w.resources),
  ];
  for (const rel of referenced) {
    assert.ok(existsSync(join(here, rel)), `manifest references missing file: ${rel}`);
  }
});

test('static DNR ruleset is well-formed and redirects to blocked.html', () => {
  const rules = JSON.parse(readFileSync(join(here, 'rules', 'network-rules.json'), 'utf8'));
  assert.ok(Array.isArray(rules) && rules.length > 0);
  const ids = new Set();
  for (const r of rules) {
    assert.ok(Number.isInteger(r.id) && !ids.has(r.id), 'rule ids must be unique integers');
    ids.add(r.id);
    assert.equal(r.action.type, 'redirect');
    assert.match(r.action.redirect.extensionPath, /^\/blocked\.html/);
    assert.deepEqual(r.condition.resourceTypes, ['main_frame']);
    assert.ok(Array.isArray(r.condition.requestDomains) && r.condition.requestDomains.length > 0);
  }
});

test('vendored engine blocks known adult domains and subdomains', () => {
  const rules = JSON.parse(readFileSync(join(here, 'rules', 'network-rules.json'), 'utf8'));
  const domains = rules.flatMap((r) => r.condition.requestDomains);
  const dm = new DomainMatcher({ blocked: domains });
  assert.equal(dm.check('pornhub.com').blocked, true);
  assert.equal(dm.check('www.pornhub.com').blocked, true);
  assert.equal(dm.check('example.com').blocked, false);
});

test('vendored engine detects trigger words the way the extension does', () => {
  const tm = new TriggerMatcher([{ term: 'porn', category: 'explicit', severity: 'high' }]);
  // The background scans a URL path + query; simulate that string.
  assert.equal(tm.test('/search?q=free+porn'), true);
  assert.equal(tm.test('/news/politics'), false);
});

test('vendored protocol constants match what the extension uses', () => {
  assert.equal(typeof API.config, 'string');
  assert.equal(typeof API.events, 'string');
  assert.equal(EVENT_TYPES.BLOCKED_SITE, 'blocked_site');
  assert.equal(EVENT_TYPES.TRIGGER_WORD, 'trigger_word');
});
