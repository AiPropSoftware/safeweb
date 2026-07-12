// SafeWeb server bootstrap.
//
// Env:
//   PORT            (default 8080)
//   DATA_DIR        (default server/.data)
//   SAFEWEB_PEPPER  (device token-hash pepper; a dev fallback is used if unset)
//   SAFEWEB_SECRET  (signing secret; dev fallback if unset)
//   ALERT_TRANSPORT ('console' default | 'webhook')
//   ALERT_WEBHOOK   (webhook URL when ALERT_TRANSPORT=webhook)

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createDb } from './db.js';
import { createApp } from './app.js';
import { createMailer } from './alerts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', '.data');
const pepper = process.env.SAFEWEB_PEPPER || 'dev-pepper-change-me';
const secret = process.env.SAFEWEB_SECRET || 'dev-secret-change-me';

if (!process.env.SAFEWEB_PEPPER) {
  console.warn('[safeweb] WARNING: SAFEWEB_PEPPER not set — using an insecure dev value. Set it in production.');
}

const db = createDb({ dataDir: DATA_DIR });
const mailer = createMailer({
  transport: process.env.ALERT_TRANSPORT || 'console',
  webhookUrl: process.env.ALERT_WEBHOOK,
  email: {
    apiUrl: process.env.EMAIL_API_URL, // defaults to Resend inside createMailer
    apiKey: process.env.EMAIL_API_KEY,
    from: process.env.EMAIL_FROM,
  },
});
const app = createApp({ db, mailer, pepper, secret });

app.listen(PORT, () => {
  console.log(`SafeWeb server listening on http://localhost:${PORT}`);
  console.log(`  data dir: ${DATA_DIR}`);
  console.log(`  dashboard: http://localhost:${PORT}/`);
});
