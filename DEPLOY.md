# Giving SafeWeb to people — deployment guide

SafeWeb has three parts. Only **one** of them needs "hosting": the server.

```
   PROTECTED PERSON'S DEVICE                 SOMEWHERE ONLINE            ACCOUNTABILITY PARTNER
   ┌───────────────────────┐                ┌──────────────────┐        ┌──────────────────────┐
   │  Browser extension     │  ── reports ─► │  SafeWeb server  │ ◄────  │  Dashboard (a web     │
   │  System agent (optional)│  ◄─ config ──  │  + dashboard     │  ────► │  page, no install)    │
   └───────────────────────┘                └──────────────────┘        └──────────────────────┘
```

So the rollout is: **(1) stand up the server, (2) get the extension onto devices,
(3) the partner uses the dashboard.**

---

## Step 1 — Host the server

The server is a small, zero-dependency Node process that stores data on disk and
keeps live connections open (for real-time alerts). That means it needs a
**persistent host** — a normal VM/container, *not* a serverless platform like
Vercel/Netlify functions. Pick whichever matches you:

### Option A — One-click on Render (easiest)
1. Push this repo to your own GitHub.
2. On [Render](https://render.com): **New + → Blueprint**, pick the repo. It reads
   [`render.yaml`](./render.yaml), provisions the server + a 1 GB data disk, and
   generates the secrets for you.
3. You get an `https://your-app.onrender.com` URL. That's your server URL.

Railway and Fly.io work the same way (Docker-based); Render is the simplest.

### Option B — Any server you control, with Docker
```bash
cp .env.example .env          # then edit: set SAFEWEB_PEPPER and SAFEWEB_SECRET
docker compose up -d          # builds and runs; data persists in a volume
```
Put it behind a reverse proxy (Caddy/Nginx) or a tunnel (Cloudflare Tunnel) so it
has **HTTPS** — the browser extension and dashboard should always talk to `https://`.

### Option C — A plain VM, no Docker
```bash
git clone <your-repo> && cd safeweb
export SAFEWEB_PEPPER=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
export SAFEWEB_SECRET=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
npm run update:blocklist      # optional: full 64k-domain list
npm start                     # runs on :8080 — front it with Nginx + HTTPS
```
Use a process manager (systemd or `pm2`) so it restarts on reboot.

### Required settings
| Variable | Why |
| --- | --- |
| `SAFEWEB_PEPPER` | **Set a strong random value.** Peppers the device-token hashes. |
| `SAFEWEB_SECRET` | Signing secret. |
| `DATA_DIR` | Where data is stored (a persistent disk/volume). |

### Real notifications (optional but recommended)
By default alerts print to the server log. To notify the partner for real:
- **Webhook** (fastest): `ALERT_TRANSPORT=webhook` + `ALERT_WEBHOOK=<Slack/Discord/automation URL>`.
- **Email**: `ALERT_TRANSPORT=email` + an email API key
  (`EMAIL_API_KEY`, `EMAIL_FROM`; defaults to the [Resend](https://resend.com) API,
  override with `EMAIL_API_URL` for a compatible provider).

---

## Step 2 — Get the extension onto the protected device

### Now (works today): share the folder
Send people `dist/safeweb-extension.zip` (build it with the steps below). They:
1. Unzip it.
2. Open `chrome://extensions` (or `edge://extensions`) → enable **Developer mode**.
3. **Load unpacked** → select the folder.
4. Click the icon → **Settings** → enter your server URL + an enrollment code → tick consent.

Rebuild the zip anytime:
```bash
npm run build && node scripts/gen-icons.js
rm -rf dist/safeweb-extension && mkdir -p dist/safeweb-extension
cp -r extension/* dist/safeweb-extension/ && rm -f dist/safeweb-extension/*.test.js
( cd dist && zip -rq safeweb-extension.zip safeweb-extension )
```

### For everyone (one-click): publish to the Chrome Web Store
"Load unpacked" is fine for testing but clumsy for non-technical users. For a
normal install experience:
1. Create a Chrome Web Store developer account ($5 one-time).
2. Upload the zipped `extension/` folder.
3. Fill in the listing + the privacy/permissions disclosure (SafeWeb only sends
   categorized events and redacted snippets — see [`ETHICS.md`](./ETHICS.md)).
4. Submit for review (~1–3 days). You then get a public install link.

### Optional: system-wide blocking (the OS agent)
For blocking that works in every app and can't be turned off by disabling the
extension, install the agent on the computer:
```bash
node agent/src/cli.js enroll --server https://your-server --code XXXX-XXXX-XXXX --i-consent
sudo node agent/src/cli.js install
```
(Needs Node + admin. To hand this to non-technical users you'd wrap it in a
native `.exe`/`.pkg` installer — not built yet.)

---

## Step 3 — The accountability partner / parent

No install. They open your server URL in a browser, create an account, click
**Add device** to generate an enrollment code, and read that code to the person
being protected. From then on they see live activity, reports, device status, and
can adjust the blocklist and trigger words.

---

## If you host centrally for many families (SaaS), also plan for:
- A **privacy policy** and a lawful basis — you're storing families' activity
  data. SafeWeb minimizes this (categorized events + redacted snippets only), but
  the responsibility is real.
- **Backups** of the data directory.
- Keeping the blocklist fresh: run `npm run update:blocklist` on a schedule (the
  Docker image bakes it in at build time).
