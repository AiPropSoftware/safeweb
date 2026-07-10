# 🛡️ SafeWeb

**On-device adult-content filtering with transparent, consent-based
accountability and parental monitoring.**

SafeWeb helps people who *want* help staying away from adult content, and helps
parents protect their children. It blocks adult sites on the device, watches for
trigger words, and keeps a chosen **accountability partner** (a friend, sponsor,
spouse, or parent) informed — while making that monitoring **visible to the
person being protected at all times**. That visibility is the whole point: it is
what separates legitimate accountability software from spyware. See
[`ETHICS.md`](./ETHICS.md).

> SafeWeb is for **self-accountability** and **parental control of minors**.
> Installing it to covertly surveil another adult is abuse, is likely illegal,
> and is exactly what SafeWeb's always-visible indicators are designed to
> prevent.

## What's in the box

| Component | What it is | Where |
| --- | --- | --- |
| **Browser extension** | The on-device filter. Blocks adult sites, scans URLs / searches / page text for trigger words, shows a persistent "Protected by SafeWeb" badge, reports redacted events. | [`extension/`](./extension) |
| **System agent** | An OS-level CLI that blocks domains in the `hosts` file for *every* app — defense in depth if the extension is disabled. | [`agent/`](./agent) |
| **Accountability server** | Zero-dependency `node:http` API: enrollment, config sync, event ingest, live SSE alerts, reports. Hosts the dashboard. | [`server/`](./server) |
| **Dashboard** | The partner/parent web UI: live activity, reports, device status, filter settings, device enrollment. | [`server/public/`](./server/public) |
| **Shared library** | The wire protocol, the detection engine (domain + trigger matching, obfuscation-resistant), and crypto — one source of truth used everywhere. | [`shared/`](./shared) |

## How it fits together

```
   ┌────────────────────────┐        enroll (consent) / config / events / heartbeat
   │   Device being          │  ───────────────────────────────────────────────►  ┌──────────────────┐
   │   protected             │                                                     │  Accountability   │
   │                         │  ◄───────────────────  live config (blocklist,      │  server           │
   │  • Browser extension    │                        trigger words)               │                   │
   │  • System agent (hosts) │                                                     │  • SQLite-free    │
   └────────────────────────┘                                                      │    JSON/JSONL DAO │
                                                                                    │  • SSE alerts     │
   ┌────────────────────────┐        reports / live alerts / settings              │  • Dashboard host │
   │  Accountability partner │  ◄──────────────────────────────────────────────►  └──────────────────┘
   │  / parent (dashboard)   │
   └────────────────────────┘
```

The **same detection engine** ([`shared/matcher.js`](./shared/matcher.js)) runs
on the device and on the server, so behaviour is identical everywhere. It folds
leetspeak and homoglyphs (`p0rn`, `p.o.r.n`, Cyrillic look-alikes) before
matching, and avoids Scunthorpe-style false positives.

## Quick start

```bash
# Node 20+; no external dependencies, no build toolchain.
npm install            # links the workspaces (there are no third-party deps)
npm run build          # generate extension DNR rules + vendored engine
npm test               # run the full suite (shared, server, agent, extension)
npm run demo           # end-to-end lifecycle, no browser needed  ← start here
```

`npm run demo` boots the server in-process and walks the whole flow — a parent
registers, mints an enrollment code, a device enrolls **with consent** (and is
rejected without it), pulls its config, reports a blocked site / trigger word /
bypass attempt, and the partner sees the report and live alerts.

### Run it for real

```bash
# 1. Start the server (serves the dashboard at http://localhost:8080)
SAFEWEB_PEPPER=$(openssl rand -hex 16) npm start

# 2. Open http://localhost:8080, create a partner account, and click
#    "Add device" to generate an enrollment code.

# 3a. Install the browser extension (extension/README.md → Load unpacked),
#     open its settings, enter the server URL + code, tick consent, enroll.

# 3b. And/or install the OS-level agent on the protected computer:
node agent/src/cli.js enroll --server http://localhost:8080 --code XXXX-XXXX-XXXX --i-consent
sudo node agent/src/cli.js install
```

## Configuration (server)

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `DATA_DIR` | `server/.data` | where partners/devices/events are stored |
| `SAFEWEB_PEPPER` | dev value (warns) | pepper for hashing device tokens — **set this in production** |
| `SAFEWEB_SECRET` | dev value | signing secret |
| `ALERT_TRANSPORT` | `console` | `console` or `webhook` |
| `ALERT_WEBHOOK` | — | webhook URL when `ALERT_TRANSPORT=webhook` |

## Design principles

1. **Transparent by design.** Consent gate at enrollment, an always-visible
   on-device badge, the partner named in the popup, and every "protection off"
   reported. No stealth mode, ever.
2. **Privacy-preserving.** No keylogging, no screenshots, no full-page or
   full-history exfiltration. Only categorized events and **redacted** snippets
   (redaction happens on the device) reach the partner.
3. **Self-hostable & dependency-free.** The server runs on the Node standard
   library alone; activity data stays on the server you run.
4. **One detection engine.** Device and server share the exact same matching
   code, kept in sync by `npm run sync:shared`.

## Testing & CI

`npm test` runs 56 tests across the detection engine (including obfuscation
evasion), the server API (enrollment, consent enforcement, auth, reporting,
alerts), the hosts-file logic (idempotency, malformed-input safety), and
extension integrity. CI runs the suite plus a parse check of the extension's
browser scripts and the end-to-end demo. See [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

## License

MIT
