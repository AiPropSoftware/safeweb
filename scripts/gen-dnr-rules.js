// Generate the browser extension's static declarativeNetRequest ruleset from
// data/blocklist.json. Each blocked domain becomes a rule that redirects any
// main-frame navigation to the extension's blocked.html page.
//
// Run: npm run gen:rules

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { defaultConfig } from '../shared/protocol.js';
import { flattenBlockedDomains } from '../shared/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

async function main() {
  const blocklist = JSON.parse(await readFile(join(root, 'data/blocklist.json'), 'utf8'));
  // First-run protection blocks the default categories; the server can push a
  // wider/narrower set at runtime via dynamic rules.
  const categories = defaultConfig().blockedCategories;
  const domains = flattenBlockedDomains(blocklist, categories);

  const rules = domains.map((domain, i) => ({
    id: i + 1,
    priority: 1,
    action: {
      type: 'redirect',
      redirect: { extensionPath: `/blocked.html?d=${encodeURIComponent(domain)}` },
    },
    condition: {
      // Matches the domain and all subdomains.
      requestDomains: [domain],
      resourceTypes: ['main_frame'],
    },
  }));

  const outDir = join(root, 'extension/rules');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'network-rules.json'), JSON.stringify(rules, null, 2) + '\n');
  console.log(`Wrote ${rules.length} DNR rules to extension/rules/network-rules.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
