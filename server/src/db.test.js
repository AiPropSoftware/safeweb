import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from './db.js';
import { EVENT_TYPES, SEVERITY } from '../../shared/protocol.js';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'safeweb-db-'));
}

test('partners persist and reload from disk', () => {
  const dir = tmp();
  try {
    let db = createDb({ dataDir: dir });
    const p = db.createPartner({ email: 'A@Ex.com', name: 'A', passwordHash: 'h' });
    assert.ok(p.id);
    assert.equal(p.email, 'a@ex.com'); // normalized
    // Reload a fresh instance against the same dir.
    db = createDb({ dataDir: dir });
    assert.equal(db.getPartnerById(p.id).name, 'A');
    assert.equal(db.getPartnerByEmail('a@ex.com').id, p.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate email throws EMAIL_TAKEN', () => {
  const dir = tmp();
  try {
    const db = createDb({ dataDir: dir });
    db.createPartner({ email: 'x@ex.com', name: 'x', passwordHash: 'h' });
    assert.throws(() => db.createPartner({ email: 'x@ex.com', name: 'y', passwordHash: 'h' }), /already/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enrollment claim is single-use and honors expiry', () => {
  const dir = tmp();
  try {
    const db = createDb({ dataDir: dir });
    const p = db.createPartner({ email: 'e@ex.com', name: 'e', passwordHash: 'h' });
    db.createEnrollment({ code: 'ABC123', partnerId: p.id, label: 'l', personName: 'n' });
    assert.ok(db.claimEnrollment('ABC123', 'dev1'));
    assert.equal(db.claimEnrollment('ABC123', 'dev2'), null); // already claimed
    db.createEnrollment({ code: 'EXP', partnerId: p.id, label: 'l', personName: 'n', ttlMs: -1 });
    assert.equal(db.claimEnrollment('EXP', 'dev3'), null); // expired
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('events append, persist, and summarize', () => {
  const dir = tmp();
  try {
    let db = createDb({ dataDir: dir });
    const p = db.createPartner({ email: 'ev@ex.com', name: 'e', passwordHash: 'h' });
    const base = { partnerId: p.id, deviceId: 'd1', ts: 1, receivedTs: Date.now(), matchedTerms: [] };
    db.appendEvent({ ...base, type: EVENT_TYPES.BLOCKED_SITE, severity: SEVERITY.HIGH, domain: 'pornhub.com' });
    db.appendEvent({ ...base, type: EVENT_TYPES.TRIGGER_WORD, severity: SEVERITY.MEDIUM, matchedTerms: ['porn'] });
    // Reload and verify persistence.
    db = createDb({ dataDir: dir });
    const q = db.queryEvents({ partnerId: p.id });
    assert.equal(q.length, 2);
    const s = db.summarize(p.id);
    assert.equal(s.total, 2);
    assert.equal(s.highestSeverity, 'high');
    assert.ok(s.topDomains.some((d) => d.key === 'pornhub.com'));
    assert.ok(s.topTerms.some((t) => t.key === 'porn'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('settings default, update, and revision bump', () => {
  const dir = tmp();
  try {
    const db = createDb({ dataDir: dir });
    const p = db.createPartner({ email: 's@ex.com', name: 's', passwordHash: 'h' });
    const c0 = db.getSettings(p.id);
    assert.ok(c0.blockedCategories.length > 0);
    const c1 = db.putSettings(p.id, { scanPageText: false, bogusKey: 'ignored' });
    assert.equal(c1.revision, c0.revision + 1);
    assert.equal(c1.scanPageText, false);
    assert.equal('bogusKey' in c1, false); // unknown keys dropped
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
