/**
 * Loads ../.env, then points the e2e project at a SEPARATE database (`placement_test`) and Redis db 1, so tests (which
 * deliberately tamper with audit rows, lock accounts, etc.) never touch development data. The Docker data tier must be running.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

for (const file of ['../.env', '.env']) {
  try {
    for (const line of readFileSync(resolve(__dirname, '..', file), 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  } catch {
    /* file not present */
  }
}

process.env.NODE_ENV = 'test';
process.env.DISABLE_JOBS = 'true';
process.env.AUTH_IP_LIMIT = '100000';
process.env.ALLOW_TOTP_FOR_PRIVILEGED = 'true';
process.env.STUDENT_EMAIL_DOMAIN = '';
process.env.SMTP_PORT = '1'; // mail goes nowhere in tests (failures are swallowed by MailService)
process.env.UPLOAD_DIR = './uploads-test';
process.env.AUDIT_ARCHIVE_DIR = './audit-archive-test';

const swapDb = (u?: string) => (u ? u.replace(/\/placement(\?|$)/, '/placement_test$1') : u);
process.env.DATABASE_URL = swapDb(process.env.DATABASE_URL);
process.env.DIRECT_DATABASE_URL = swapDb(process.env.DIRECT_DATABASE_URL);
process.env.REDIS_URL = (process.env.REDIS_URL ?? '').replace(/\/\d+$/, '') + '/1';
