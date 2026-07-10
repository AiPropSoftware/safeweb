# SafeWeb system agent

A tiny, zero-dependency CLI that blocks adult/blocklisted domains for **every
application** on the device — not just the browser — by managing the operating
system's `hosts` file. It's defense-in-depth alongside the browser extension:
even if the extension is disabled, the OS-level block stays in force.

## How it works

The agent adds a block of `0.0.0.0 <domain>` entries to your `hosts` file so
those domains resolve nowhere. It edits **only** the region between two marker
lines:

```
# >>> SafeWeb managed block >>>
…managed entries…
# <<< SafeWeb managed block <<<
```

Everything outside those markers is preserved byte-for-byte, and the file is
backed up (`hosts.safeweb-<timestamp>.bak`) before every change.

## Usage

```bash
# 1. Pair with your accountability partner (consent is required, by design):
safeweb-agent enroll --server https://safeweb.example --code XXXX-XXXX-XXXX --name Sam --i-consent

# 2. Apply the block system-wide (needs admin rights):
sudo safeweb-agent install

# Check what's going on any time (no admin needed):
safeweb-agent status

# Re-pull your partner's latest settings:
sudo safeweb-agent sync

# Turn it off — this NOTIFIES your partner first, then removes the block:
sudo safeweb-agent uninstall
```

If you run `install` before enrolling, the agent falls back to the built-in
default blocklist (`data/blocklist.json`) so you still get protection.

## Honest notes

- Editing `hosts` requires administrator/root privileges. The agent tells you
  clearly when to use `sudo` (or an elevated terminal on Windows).
- Turning protection off is allowed — SafeWeb never traps you — but `uninstall`
  reports a `PROTECTION_OFF` event to your accountability partner first. Nothing
  is hidden.
- hosts-based blocking is domain-level; it does not do deep content inspection.
  Pair it with the browser extension for trigger-word scanning and reporting.

## Files

- `src/hosts.js` — pure, unit-tested hosts-text transforms (marker region only).
- `src/paths.js` — cross-platform hosts + config path resolution.
- `src/cli.js` — the `safeweb-agent` command.
- `src/hosts.test.js` — round-trip / idempotency / malformed-input tests.
