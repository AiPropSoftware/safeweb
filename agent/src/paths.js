// Cross-platform path resolution for the SafeWeb system agent. Pure reads of
// os/env — no writes here.

import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/** Absolute path to the OS hosts file. */
export function hostsPath() {
  if (platform() === 'win32') {
    const root = process.env.SystemRoot || 'C:\\Windows';
    return join(root, 'System32', 'drivers', 'etc', 'hosts');
  }
  return '/etc/hosts';
}

/** Directory where the agent stores its enrollment config. */
export function configDir() {
  const p = platform();
  if (p === 'win32') {
    const base = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(base, 'SafeWeb');
  }
  if (p === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'SafeWeb');
  }
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'safeweb');
}

/** Path to the agent's config.json. */
export function configPath() {
  return join(configDir(), 'config.json');
}

/**
 * True if the current process has the privileges needed to edit the hosts file.
 * On POSIX that means euid 0 (root). On Windows we can't cheaply detect elevation
 * here, so we return null ("unknown") and let the write attempt surface the error.
 * @returns {boolean|null}
 */
export function isElevated() {
  if (platform() === 'win32') return null;
  return typeof process.geteuid === 'function' ? process.geteuid() === 0 : null;
}
