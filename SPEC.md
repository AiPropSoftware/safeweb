# SafeWeb — Implementation Spec (internal contract)

This is the build contract every component adheres to. The **shared library**
(`shared/`) is already written, tested, and is the single source of truth for
the wire protocol, detection engine, and crypto. Do not redefine anything that
lives there — import it.

## Conventions

- Node 22, **ES modules** (`"type": "module"`), **no build step**, no
  TypeScript. Vanilla JS everywhere (browser code included).
- Tests use the built-in runner: `node --test`. Name test files `*.test.js`.
- Only add npm dependencies that are strictly needed. Server may use `express`.
  Prefer the Node standard library otherwise (`node:crypto`, `node:http`,
  `node:fs`, SSE via raw response writes).
- Every component must honor the **Consent & Transparency** rules in
  `ETHICS.md`. This is a product requirement, not a nicety.

## Shared library (already built — import, don't reimplement)

From `@safeweb/shared` (or relative `../shared/...`):

- `protocol.js`: `PROTOCOL_VERSION`, `API` (all endpoint paths), `EVENT_TYPES`,
  `SEVERITY`, `SEVERITY_RANK`, `DEFAULT_SEVERITY`, `IMMEDIATE_ALERT_MIN_SEVERITY`,
  `normalizeEvent(raw,{now})`, `defaultConfig()`.
- `matcher.js`: `normalizeHost`, `DomainMatcher`, `foldText`, `TriggerMatcher`,
  `redactSnippet`.
- `config.js`: `buildDomainMatcher`, `buildTriggerMatcher`,
  `flattenBlockedDomains`.
- `crypto.js`: `generateEnrollmentCode`, `normalizeCode`, `generateDeviceToken`,
  `hashToken`, `safeEqual`, `sign`, `verify`, `hashPassword`, `verifyPassword`,
  `generateSessionId`.

Data files: `data/blocklist.json` (`.categories[cat] = [domains]`) and
`data/triggers.json` (`.categories[cat] = {severity, terms[]}`).

## Data model (persisted by the server)

The server owns persistence via a **swappable DAO** (`server/src/db.js`) exposing
a small synchronous-ish API (may be async). It must persist to disk under a
configurable data dir (default `server/.data/`), pure-JS (JSON/JSONL — no native
modules). Entities:

- **partner**: `{ id, email, name, passwordHash, createdTs }`
- **device**: `{ id, partnerId, label, tokenHash, personName, consentAckTs,
  createdTs, lastSeenTs, active }` — `personName` is who is being protected;
  `consentAckTs` records that the protected person acknowledged monitoring.
- **enrollment**: `{ code (normalized), partnerId, label, personName,
  expiresTs, claimedByDeviceId|null }`
- **event**: normalized event (see `normalizeEvent`) plus `{ id, deviceId,
  partnerId }`. Append-only.
- **settings**: per-partner `FilterConfig` (see `protocol.defaultConfig`) with a
  monotonically increasing `revision`.

DAO methods (name them clearly): create/get partner by id & email; create device;
get device by id; get device by tokenHash; touch lastSeen; create/get/claim
enrollment by code; append event; query events (by partnerId, since, type,
limit); get/put settings (bumping revision on put); summary aggregates.

## Server (`server/`)

Express app factory `createApp({ db, mailer, secret, dataDir })` returning an
Express instance; `src/index.js` boots it on `PORT` (default 8080). All device
endpoints require `Authorization: Bearer <deviceToken>`; the server looks up the
device by `hashToken(token, pepper)`. Partner endpoints require a session cookie
(`sw_session`). Use the `API.*` paths from `protocol.js`.

Endpoints (JSON in/out unless noted):

- `POST {API.enrollCreate}` (partner-authed): body `{ label, personName }` →
  `{ code, expiresTs }`. Mints an enrollment code via `generateEnrollmentCode()`.
- `POST {API.enrollClaim}` (no auth): body `{ code, deviceLabel, personName,
  consentAck: true }` → creates a device, returns `{ deviceToken, deviceId,
  partnerName }`. **Reject if `consentAck !== true`** (409) — the protected
  person must acknowledge monitoring. Returns 404 for unknown/expired/claimed
  codes.
- `GET {API.config}` (device-authed): returns the partner's `FilterConfig`
  merged over `defaultConfig()`, plus a flattened `blockedDomains` array (via
  `flattenBlockedDomains`) and the resolved `triggerTerms` (term/category/
  severity) so the extension can enforce locally without shipping the data
  files. Include `revision`. Touch device lastSeen.
- `POST {API.events}` (device-authed): body `{ events: [...] }`. Validate each
  with `normalizeEvent`; drop invalid; persist valid ones tagged with deviceId/
  partnerId. For any event with severity >= `IMMEDIATE_ALERT_MIN_SEVERITY`,
  fire an alert (mailer + push to that partner's SSE stream). Return
  `{ accepted, rejected }`.
- `POST {API.heartbeat}` (device-authed): body `{ protectionOn: bool }`. Touch
  lastSeen; if protection flipped off, record a `PROTECTION_OFF` event + alert.
- `POST {API.partnerLogin}`: `{ email, password }` → sets `sw_session` cookie,
  returns `{ partner: { id, name, email } }`. `POST {API.partnerLogout}` clears
  it. `GET {API.partnerMe}` returns current partner or 401.
- `GET {API.reports}` (partner-authed): query `?since=&type=&limit=` → `{ events,
  summary }` where summary has counts by type/severity/day and top domains/terms.
- `GET {API.devices}` (partner-authed): list devices with `lastSeenTs`, online
  status (lastSeen within 2× heartbeat), and per-device recent counts.
- `GET/PUT {API.settings}` (partner-authed): get/update the partner's
  `FilterConfig`. PUT bumps `revision`.
- `GET {API.stream}` (partner-authed): **SSE**. Emits `event: alert` messages
  (JSON) in real time when high-severity events land for this partner. Send a
  comment ping every ~25s to keep the connection alive.
- Static: serve `server/public/` (the dashboard) at `/` and the extension's
  download/help page. Serve a JSON `GET /api/v1/health` → `{ ok:true, version }`.

**Alerts** (`server/src/alerts.js`): `createMailer({ transport })`. Default
transport is `console` (logs a formatted alert) so the demo needs no SMTP.
Support an optional webhook transport (POST JSON to a URL). An alert includes
device label, person name, event type/severity, redacted context, and time.

**Security**: cookies `HttpOnly`, `SameSite=Lax`; never return token hashes or
password hashes; rate-limit login and enroll/claim (simple in-memory limiter);
validate/bound all input.

Tests: DAO round-trips; enroll→claim→token→config→events happy path; consentAck
rejection; auth rejection; report aggregation. Use `supertest` OR drive the app
with `node:http` against an ephemeral port — prefer no extra dep (`node:http`).

## Browser extension (`extension/`, Manifest V3)

The on-device enforcement point. Vanilla JS, MV3.

- `manifest.json`: MV3, permissions `declarativeNetRequest`,
  `declarativeNetRequestFeedback`, `storage`, `webNavigation`, `alarms`,
  `scripting`; host permissions `<all_urls>`. Background service worker
  `background.js`. Content script `content.js` at `document_idle`. Options page
  `options.html`, action popup `popup.html`. Static DNR ruleset referencing
  `rules/network-rules.json` (generated from the blocklist by
  `scripts/gen-dnr-rules.js`).
- **Enrollment** (`options.html`/`options.js`): user enters server URL + a device
  token (obtained by the partner via the dashboard) OR an enrollment code that
  the extension claims via `{API.enrollClaim}` (must show and require a consent
  checkbox — the person confirms they agree to be monitored). Store server URL +
  token in `chrome.storage.local`.
- **Background** (`background.js`): on install/startup and on an `alarms` timer,
  pull `{API.config}` and (a) update DNR rules for `blockedDomains`, (b) cache
  `triggerTerms` for the content script. Listen to `webNavigation.onBeforeNavigate`
  / `onCommitted`: if `DomainMatcher` says the destination is blocked, redirect
  the tab to `blocked.html`. Scan the URL and any `?q=`/search query params with
  `TriggerMatcher`; queue any hits as events. Batch-POST queued events to
  `{API.events}` (flush on a timer and on threshold). Send `{API.heartbeat}` on
  the alarm. Detect and report bypass attempts (e.g. management API / uninstall
  where feasible) — document honest limits.
- **Content script** (`content.js`): when `scanPageText` is on, scan visible text
  (debounced, capped) with the cached `TriggerMatcher`; on a hit, blur/redact the
  region, post a `TRIGGER_WORD` event with a `redactSnippet` context, and show a
  small SafeWeb notice. Inject a persistent, unobtrusive **"Protected by SafeWeb"**
  badge so the user always knows monitoring is active (transparency requirement).
- **Blocked page** (`blocked.html`): friendly, non-shaming; explains the block,
  who the accountability partner is, and offers a "request access" note that logs
  a `BYPASS_ATTEMPT`. No password-guess bypass.
- **Popup** (`popup.html`): shows protection status, the accountability partner's
  name/email, last sync, and recent local activity count. Reinforces transparency.

Because the extension can't import Node modules, `scripts/sync-shared.js` copies
`shared/matcher.js` and `shared/protocol.js` into `extension/vendor/` and the
extension imports those. Keep extension logic dependent only on those two pure
modules.

Include a `extension/README.md` with load-unpacked install steps for Chrome/Edge.

## System agent (`agent/`) — OS-level defense in depth

A Node CLI (`safeweb-agent`) that blocks adult domains for **all** apps (not just
the browser) by managing the OS hosts file between marker comments.

- Commands: `enroll --server <url> --code <code>` (claims a code, stores token +
  serverUrl in a user config file under the OS config dir),
  `install` (writes hosts entries for the current config's blockedDomains,
  pointing them at 127.0.0.1; requires root/admin — detect and print a clear
  message), `status`, `sync` (re-pull config and rewrite entries),
  `uninstall` (remove the SafeWeb block, log a `PROTECTION_OFF` event first).
- Manage ONLY the region between `# >>> SafeWeb managed block >>>` and
  `# <<< SafeWeb managed block <<<`; never touch the rest of the file. Back up
  before writing. Cross-platform hosts path (`/etc/hosts`, Windows
  `System32\drivers\etc\hosts`). Keep hosts I/O in a unit-testable module that
  accepts an injectable path so tests never touch the real `/etc/hosts`.
- `agent/src/hosts.js` (pure, testable) + `agent/src/cli.js`. Tests for the
  managed-block read/modify/write round-trip against a temp file.

## Demo (`scripts/demo.js`)

A no-browser end-to-end script that: boots the server in-process with a temp data
dir, creates a partner, mints an enrollment code, claims it as a device (with
consent), pulls config, simulates a batch of events (a blocked site, a trigger
word, a bypass attempt), and prints the resulting report + the alerts that fired.
This is the primary "it works" artifact reviewers run: `npm run demo`.

## Non-negotiables checklist (all components)

1. The protected person is always informed monitoring is active (consent gate at
   enrollment + persistent on-device indicator).
2. No covert/stealth mode. No keystroke logging. No exfiltration of full page
   content or full browsing history — only categorized events + redacted
   snippets.
3. Reports and alerts go only to the enrolled accountability partner.
4. Uninstalling/turning off protection is allowed but is itself reported.
