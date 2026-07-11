// Load the categorized blocklist, transparently merging the committed curated
// seed (data/blocklist.json) with an optional large generated list produced by
// `npm run update:blocklist` (data/blocklist.extended.json, gitignored).
//
// Node-only (uses fs) — do NOT import from browser code. The server, the DNR
// rule generator, and the system agent all go through here so they see the same
// merged view.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

/**
 * @param {string} [dataDir]
 * @returns {{ version:string, categories: Record<string,string[]>, sources: string[] }}
 */
export function loadMergedBlocklist(dataDir = DATA_DIR) {
  const base = readJson(join(dataDir, 'blocklist.json')) || { categories: {} };
  const extendedPath = join(dataDir, 'blocklist.extended.json');
  const merged = { version: base.version, categories: {}, sources: ['blocklist.json'] };

  // Copy base categories (clone arrays so callers can't mutate the source).
  for (const [cat, domains] of Object.entries(base.categories || {})) {
    merged.categories[cat] = [...new Set((domains || []).map((d) => String(d).toLowerCase()))];
  }

  if (existsSync(extendedPath)) {
    const ext = readJson(extendedPath);
    if (ext && ext.categories) {
      merged.sources.push('blocklist.extended.json');
      for (const [cat, domains] of Object.entries(ext.categories)) {
        const set = new Set(merged.categories[cat] || []);
        for (const d of domains || []) set.add(String(d).toLowerCase());
        merged.categories[cat] = [...set];
      }
    }
  }
  return merged;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}
