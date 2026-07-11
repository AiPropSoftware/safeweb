#!/usr/bin/env node
// SafeWeb system agent CLI — blocks adult/blocklisted domains for EVERY app on
// this device by managing the OS hosts file (defense-in-depth alongside the
// browser extension). All hosts edits stay between SafeWeb's markers, back up
// the file first, and never touch anything else.

import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyManagedBlock,
  removeManagedBlock,
  hasManagedBlock,
  extractManagedDomains,
  readHostsText,
  writeHostsText,
  backupHostsFile,
} from './hosts.js';
import { hostsPath, configPath, configDir, isElevated } from './paths.js';
import { API, EVENT_TYPES, SEVERITY, defaultConfig } from '../../shared/protocol.js';
import { flattenBlockedDomains } from '../../shared/config.js';
import { loadMergedBlocklist } from '../../scripts/lib/load-blocklist.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');

// ---- small helpers --------------------------------------------------------
function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function loadConfig() {
  try {
    if (existsSync(configPath())) return JSON.parse(readFileSync(configPath(), 'utf8'));
  } catch {
    /* fall through */
  }
  return null;
}

function saveConfig(cfg) {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

function joinUrl(base, path) {
  return String(base).replace(/\/+$/, '') + path;
}

function requireElevationOrExit() {
  const elevated = isElevated();
  if (elevated === false) {
    console.error('This command edits the system hosts file and needs administrator rights.');
    console.error('  Re-run with sudo, e.g.:  sudo safeweb-agent ' + process.argv.slice(2).join(' '));
    process.exit(1);
  }
  if (elevated === null && process.platform === 'win32') {
    console.error('Note: on Windows, run this from an Administrator terminal or the hosts write will fail.');
  }
}

function offlineBlockedDomains() {
  const data = loadMergedBlocklist(DATA_DIR);
  return flattenBlockedDomains(data, defaultConfig().blockedCategories);
}

async function fetchConfigDomains(cfg) {
  const res = await fetch(joinUrl(cfg.serverUrl, API.config), {
    headers: { authorization: `Bearer ${cfg.deviceToken}` },
  });
  if (!res.ok) throw new Error(`server returned ${res.status}`);
  const config = await res.json();
  return config.blockedDomains || [];
}

// ---- commands -------------------------------------------------------------
async function cmdEnroll(flags) {
  const server = flags.server;
  const code = flags.code;
  if (!server || !code) {
    console.error('Usage: safeweb-agent enroll --server <url> --code <code> [--name <you>] --i-consent');
    process.exit(1);
  }
  if (!flags['i-consent']) {
    console.error('SafeWeb is transparent by design: enrollment requires your explicit consent.');
    console.error('Re-run with the --i-consent flag to confirm you agree to be monitored by your accountability partner.');
    process.exit(1);
  }
  const body = {
    code,
    personName: flags.name || '',
    deviceLabel: `${hostname()} (system agent)`,
    consentAck: true,
  };
  let res;
  try {
    res = await fetch(joinUrl(server, API.enrollClaim), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`Could not reach the SafeWeb server: ${err.message}`);
    process.exit(1);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`Enrollment failed: ${json.error || res.status}`);
    process.exit(1);
  }
  saveConfig({
    serverUrl: server,
    deviceToken: json.deviceToken,
    deviceId: json.deviceId,
    partnerName: json.partnerName,
    partnerEmail: json.partnerEmail,
    personName: body.personName,
  });
  console.log(`✔ Enrolled. Your accountability partner is: ${json.partnerName || '(unnamed)'}${json.partnerEmail ? ' <' + json.partnerEmail + '>' : ''}`);
  console.log('  Next: run  sudo safeweb-agent install  to block domains system-wide.');
}

async function cmdInstall() {
  requireElevationOrExit();
  const cfg = loadConfig();
  let domains;
  if (cfg && cfg.serverUrl && cfg.deviceToken) {
    try {
      domains = await fetchConfigDomains(cfg);
      console.log(`Pulled ${domains.length} blocked domains from ${cfg.serverUrl}.`);
    } catch (err) {
      console.warn(`Could not reach server (${err.message}); using the built-in default blocklist.`);
      domains = offlineBlockedDomains();
    }
  } else {
    console.log('Not enrolled — installing the built-in default blocklist. (Run `enroll` to add accountability.)');
    domains = offlineBlockedDomains();
  }
  const path = hostsPath();
  const backup = backupHostsFile(path, Date.now());
  const current = existsSync(path) ? readHostsText(path) : '';
  writeHostsText(path, applyManagedBlock(current, domains));
  console.log(`✔ Installed SafeWeb block for ${domains.length} domains into ${path}.`);
  if (backup) console.log(`  Backup saved to ${backup}`);
}

async function cmdSync() {
  requireElevationOrExit();
  const cfg = loadConfig();
  if (!cfg || !cfg.serverUrl || !cfg.deviceToken) {
    console.error('Not enrolled. Run `safeweb-agent enroll` first.');
    process.exit(1);
  }
  let domains;
  try {
    domains = await fetchConfigDomains(cfg);
  } catch (err) {
    console.error(`Sync failed: ${err.message}`);
    process.exit(1);
  }
  const path = hostsPath();
  backupHostsFile(path, Date.now());
  const current = existsSync(path) ? readHostsText(path) : '';
  writeHostsText(path, applyManagedBlock(current, domains));
  console.log(`✔ Synced. ${domains.length} domains blocked in ${path}.`);
}

async function cmdUninstall() {
  requireElevationOrExit();
  const cfg = loadConfig();
  // Turning protection off is allowed — but it is reported first. Best effort.
  if (cfg && cfg.serverUrl && cfg.deviceToken) {
    try {
      await fetch(joinUrl(cfg.serverUrl, API.events), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.deviceToken}` },
        body: JSON.stringify({
          events: [{ type: EVENT_TYPES.PROTECTION_OFF, severity: SEVERITY.HIGH, ts: Date.now(), detail: 'System agent hosts-block uninstalled' }],
        }),
      });
      console.log('Notified your accountability partner that protection is being turned off.');
    } catch {
      console.warn('Could not reach the server to notify your partner (continuing).');
    }
  }
  const path = hostsPath();
  if (!existsSync(path)) {
    console.log('No hosts file found; nothing to remove.');
    return;
  }
  backupHostsFile(path, Date.now());
  const current = readHostsText(path);
  writeHostsText(path, removeManagedBlock(current));
  console.log(`✔ Removed the SafeWeb block from ${path}.`);
}

function cmdStatus() {
  const cfg = loadConfig();
  console.log('SafeWeb system agent — status');
  if (cfg && cfg.serverUrl) {
    console.log(`  Enrollment : enrolled to ${cfg.serverUrl}`);
    console.log(`  Partner    : ${cfg.partnerName || '(unnamed)'}${cfg.partnerEmail ? ' <' + cfg.partnerEmail + '>' : ''}`);
  } else {
    console.log('  Enrollment : not enrolled (run `safeweb-agent enroll`)');
  }
  const path = hostsPath();
  try {
    const text = existsSync(path) ? readHostsText(path) : '';
    if (hasManagedBlock(text)) {
      const domains = extractManagedDomains(text);
      console.log(`  Hosts block: ACTIVE — ${domains.length} domains blocked in ${path}`);
    } else {
      console.log(`  Hosts block: not installed (run \`sudo safeweb-agent install\`)`);
    }
  } catch (err) {
    console.log(`  Hosts block: could not read ${path} (${err.message})`);
  }
}

function cmdHelp() {
  console.log(`SafeWeb system agent — OS-level content blocking for every app on this device.

Usage: safeweb-agent <command> [options]

Commands:
  enroll --server <url> --code <code> [--name <you>] --i-consent
                       Pair this device with an accountability partner.
                       Requires --i-consent (SafeWeb never monitors covertly).
  install              Block the configured domains in the system hosts file.
                       Needs administrator rights (sudo / elevated terminal).
  sync                 Re-pull the partner's config and rewrite the block.
  status               Show enrollment + whether the hosts block is active.
  uninstall            Notify the partner, then remove the hosts block.
  help                 Show this message.

The agent only edits the region between its markers, backs up the hosts file
first, and reports when protection is turned off. See agent/README.md.`);
}

// ---- dispatch -------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  const { flags, positional } = parseFlags(argv);
  const cmd = positional[0] || (flags.help ? 'help' : 'status');
  try {
    switch (cmd) {
      case 'enroll': return await cmdEnroll(flags);
      case 'install': return await cmdInstall();
      case 'sync': return await cmdSync();
      case 'uninstall': return await cmdUninstall();
      case 'status': return cmdStatus();
      case 'help':
      case '--help':
      case '-h': return cmdHelp();
      default:
        console.error(`Unknown command: ${cmd}\n`);
        cmdHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
