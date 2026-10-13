# NFSU Placement Portal

Implementation of the *NFSU Placement Portal – System Architecture* document, on the stack it recommends:
**React + TypeScript (Vite)** · **NestJS + Passport + Prisma** · **PostgreSQL 16 (pgcrypto, row-level security)** · **Redis + BullMQ** · **otplib / @simplewebauthn** · **ExcelJS** · **Docker Compose + Nginx/ModSecurity**.

```
frontend/   React 19 + Vite + Tailwind (your UI, wired to the API)   -> http://localhost:5173
backend/    NestJS API, Prisma schema + SQL migrations, tests         -> http://localhost:4000/api
db/ nginx/  Postgres role bootstrap, TLS/WAF edge config
scripts/    backup, restore drill, dev certificates
docs/       ARCHITECTURE.md  (what maps to what, decisions, limitations, open questions)
```

## Run it (development)

Prerequisites: Node 22+, Docker Desktop.

```bash
node scripts/setup-env.mjs        # creates .env with fresh keys (never overwrites an existing .env). No 'cp' needed, works on Windows
docker compose up -d              # Postgres 16, Redis 7, Mailpit (dev e-mail inbox: http://localhost:8025)

cd backend
npm install --legacy-peer-deps
npx prisma migrate deploy         # tables, row-level security, views, grants
npm run db:seed                   # 5 programmes + demo accounts/data (writes backend/.dev-accounts.json, git-ignored)
npm run dev                       # API on :4000

cd ../frontend
npm install
npm run dev                       # SPA on :5173 (proxies /api to :4000)
```

* Demo logins (passwords and authenticator secrets) are **generated** by the seed into `backend/.dev-accounts.json`. Every demo user is pre-enrolled with an authenticator app: add the `totp_secret` to any authenticator, or sign in and use e-mail codes (students/HR) from Mailpit.
* New accounts (students from a CSV import, HR invites, staff) get an activation link by e-mail; in development read it in Mailpit.
* Ports `5433` (Postgres) and `6380` (Redis) avoid clashing with other local projects; change `PG_PORT` / `REDIS_PORT` in `.env`.

Full stack in containers behind the TLS 1.3 + WAF edge (run the `.sh` scripts from Git Bash or WSL on Windows): `sh scripts/gen-certs.sh && docker compose --profile full up -d --build` → https://localhost:8443 (set `WEB_ORIGIN`/`WEBAUTHN_RP_ID` accordingly).

## Tests

```bash
cd backend
npm test           # 27 rule-engine tests: P1–P10 + each rule R1–R8 + derived placement state (no infrastructure needed)
npm run test:e2e   # 34 end-to-end security tests (S1–S8 and more) against real Postgres (RLS) + Redis, isolated DB `placement_test`
cd ../frontend && npm run build   # typecheck + production bundle
```

The e2e suite needs the Docker data tier running. It creates and migrates its own `placement_test` database and uses Redis db 1, so it never touches development data.

## Roles

Student · Faculty coordinator · Placement Officer · Company HR · Super Admin. **The Placement Administrator role has no screens in this portal**; see *Decisions* in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for what that means for account administration.

## Security at a glance

Password (Argon2id) + mandatory second factor for every role (TOTP, e-mail OTP, passkeys/hardware keys, recovery codes) · server-side sessions in Redis, opaque `HttpOnly; SameSite=Strict` cookie, rotated at login and step-up · CSRF token + Origin check · deny-by-default access guard (role → scope → field) · PostgreSQL row-level security as a second wall · column encryption (AES-256-GCM) for mobile/CTC/stipend · hash-chained audit log (HMAC) with tamper detection · step-up MFA for sensitive actions · masked, watermarked, logged exports · strict CSP.

Nothing in the browser is trusted: the UI hides what a role may not do, but the server re-checks every request.
