# SafeWeb browser extension

The on-device enforcement point: it blocks adult sites, scans URLs, searches and
(optionally) page text for trigger words, and — once enrolled with an
accountability partner — reports categorized, redacted events to your SafeWeb
server.

## What it does

- **Blocks adult content out of the box.** A bundled static ruleset
  (`rules/network-rules.json`, generated from `data/blocklist.json`) blocks known
  adult domains via Chrome's `declarativeNetRequest` engine before enrollment.
- **Adds accountability when enrolled.** After you enter an enrollment code (and
  tick the consent box), it pulls your partner's configuration, applies extra
  blocked domains, scans for trigger words, and sends events to the server.
- **Is transparent by design.** A persistent "🛡️ Protected by SafeWeb" badge is
  shown on every page, the popup always names your accountability partner, and
  turning protection off notifies them. There is no hidden or stealth mode.

## Install (load unpacked)

1. From the repo root, build the generated assets once:
   ```
   npm run build      # generates rules/network-rules.json and vendor/*.js
   node scripts/gen-icons.js
   ```
   (These files are committed, so a fresh clone already has them.)
2. Open `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this `extension/` folder.
5. Click the SafeWeb toolbar icon → **Settings / enrollment**, enter your server
   URL and the enrollment code your partner generated in their dashboard, tick
   the consent box, and enroll.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest, permissions, DNR ruleset registration |
| `background.js` | Service worker: config sync, DNR rules, event batching, heartbeat |
| `content.js` | Page-text scanning, on-page redaction, the visible badge |
| `blocked.html/.js/.css` | The non-shaming block page |
| `popup.html/.js/.css` | Status + who your accountability partner is |
| `options.html/.js/.css` | Enrollment (with the consent gate) |
| `vendor/` | Copies of the shared detection engine (`npm run sync:shared`) |
| `rules/network-rules.json` | Generated static block rules (`npm run gen:rules`) |

## Honest limits

A browser extension is not tamper-proof — a determined user with admin rights can
disable it from `chrome://extensions`. SafeWeb treats that as an accountability
signal rather than pretending it can't happen:

- Disabling/removing the extension stops heartbeats, and the server alerts the
  partner that the device went silent.
- Turning monitoring off in the options page sends an explicit
  `PROTECTION_OFF` alert first.
- For system-wide, cross-browser blocking that doesn't depend on the extension,
  install the companion **SafeWeb system agent** (`agent/`), which blocks adult
  domains at the OS `hosts` level for every application.

This layered, transparent approach is intentional: SafeWeb is built to support
people who *want* accountability, not to covertly surveil anyone.
