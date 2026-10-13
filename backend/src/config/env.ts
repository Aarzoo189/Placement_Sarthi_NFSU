import { existsSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';

// Development convenience: load the repo-root .env (or backend/.env). Variables already present in the process
// environment win, so Docker/Kubernetes-provided configuration is never overridden by a stray file.
for (const f of ['../.env', '.env']) {
  const p = resolve(process.cwd(), f);
  if (existsSync(p)) {
    try {
      process.loadEnvFile(p);
    } catch {
      /* unreadable file: fall through to the validation below */
    }
  }
}

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes'].includes(v.toLowerCase())));

const key32 = z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  WEBAUTHN_RP_ID: z.string().default('localhost'),
  WEBAUTHN_RP_NAME: z.string().default('NFSU Placement Portal'),
  COOKIE_SECURE: bool(false),
  TRUST_PROXY: bool(false),
  DATA_KEY: key32,
  HMAC_KEY: key32,
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('placement-portal@nfsu.local'),
  SUPERADMIN_ALLOWED_CIDRS: z.string().default('127.0.0.0/8,::1/128'),
  /** Requests per minute per IP on login / MFA / activation endpoints (tests raise it). */
  AUTH_IP_LIMIT: z.coerce.number().default(40),
  MAX_SUPER_ADMINS: z.coerce.number().default(2),
  ALLOW_TOTP_FOR_PRIVILEGED: bool(false),
  AUDIT_ARCHIVE_DIR: z.string().default('./audit-archive'),
  UPLOAD_DIR: z.string().default('./uploads'),
  BACKUP_DIR: z.string().default('./backups'),
  /** Institutional e-mail domain required for student accounts (empty = any domain, for local testing). */
  STUDENT_EMAIL_DOMAIN: z.string().default(''),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail closed at boot: never run with a missing or malformed key or URL.
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
