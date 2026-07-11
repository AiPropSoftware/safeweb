// Pull a full, maintained public adult-domain blocklist and write it to
// data/blocklist.extended.json (gitignored — it's large and regenerable).
//
// Source: StevenBlack/hosts "porn-only" compiled list (MIT-licensed, widely
// used). The server, DNR generator, and system agent automatically merge this
// file when present (see scripts/lib/load-blocklist.js).
//
// Run:  npm run update:blocklist
//       npm run update:blocklist -- --source <url> --max 60000
//
// After running, regenerate the browser rules:  npm run gen:rules

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DEFAULT_SOURCE =
  'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn-only/hosts';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', 'data', 'blocklist.extended.json');

function parseArgs(argv) {
  const out = { source: DEFAULT_SOURCE, max: Infinity };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source' && argv[i + 1]) out.source = argv[++i];
    else if (argv[i] === '--max' && argv[i + 1]) out.max = Number(argv[++i]) || Infinity;
  }
  return out;
}

// Parse a hosts-format file into a set of base domains.
function parseHosts(text, max) {
  const domains = new Set();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    // "0.0.0.0 domain.com" or "127.0.0.1 domain.com"
    const m = /^(?:0\.0\.0\.0|127\.0\.0\.1)\s+(\S+)/.exec(line);
    if (!m) continue;
    let host = m[1].toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
    // Skip localhost noise and anything that isn't a plausible domain.
    if (host === 'localhost' || host === 'localhost.localdomain' || host === '0.0.0.0') continue;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) continue;
    domains.add(host);
    if (domains.size >= max) break;
  }
  return [...domains];
}

async function main() {
  const { source, max } = parseArgs(process.argv.slice(2));
  console.log(`Fetching blocklist from:\n  ${source}`);
  let text;
  try {
    const res = await fetch(source, { headers: { 'user-agent': 'SafeWeb-blocklist-updater' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    console.error(`\n✘ Could not download the blocklist: ${err.message}`);
    console.error('  Check your network/proxy, or pass a local mirror with --source <url|file>.');
    process.exit(1);
  }

  const domains = parseHosts(text, max);
  if (domains.length === 0) {
    console.error('✘ No domains parsed — the source format may have changed.');
    process.exit(1);
  }

  const payload = {
    $schema: 'SafeWeb extended blocklist (generated). Merged over data/blocklist.json.',
    generatedFrom: source,
    count: domains.length,
    categories: { 'adult-extended': domains.sort() },
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 0) + '\n');

  console.log(`\n✔ Wrote ${domains.length.toLocaleString()} domains to data/blocklist.extended.json`);
  console.log('  This file is gitignored (large + regenerable).');
  console.log('  The server and system agent will merge it automatically.');
  console.log("  For the browser extension, regenerate its rules:  npm run gen:rules");
  console.log("  (Enable the 'adult-extended' category in the dashboard Settings, or it is on by default.)");
}

main();
