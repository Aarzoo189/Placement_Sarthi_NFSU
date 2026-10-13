# NFSU Placement Portal

A secure web application for running campus placements at the National Forensic Sciences University: student onboarding, recruitment drives, a policy engine that decides who may apply to what, offers and acceptance deadlines, role-specific dashboards, masked and audited exports, and a tamper-evident audit trail.

It implements the *NFSU Placement Portal – System Architecture* document on the stack that document recommends: **React + TypeScript (Vite)**, **NestJS + Passport + Prisma**, **PostgreSQL 16 (pgcrypto, row-level security)**, **Redis + BullMQ**, **otplib / @simplewebauthn** for MFA, **ExcelJS** for exports and **Docker Compose + Nginx/ModSecurity** for deployment.

> **Status:** working prototype. Rule engine: 27 unit tests. Security and workflow behaviour: 34 end-to-end tests against a real database. See [Known limitations](#18-known-limitations) before putting it in front of real users.

## Contents

1. [What it does](#1-what-it-does)
2. [Roles at a glance](#2-roles-at-a-glance)
3. [Architecture](#3-architecture)
4. [Tech stack](#4-tech-stack)
5. [Repository layout](#5-repository-layout)
6. [Getting started](#6-getting-started)
7. [Demo accounts and signing in](#7-demo-accounts-and-signing-in)
8. [Configuration reference](#8-configuration-reference)
9. [The policy rule engine](#9-the-policy-rule-engine)
10. [Authentication, sessions and step-up](#10-authentication-sessions-and-step-up)
11. [Data model and database security](#11-data-model-and-database-security)
12. [Main workflows](#12-main-workflows)
13. [API reference](#13-api-reference)
14. [Security controls](#14-security-controls)
15. [Testing](#15-testing)
16. [Background jobs, backups and deployment](#16-background-jobs-backups-and-deployment)
17. [Troubleshooting](#17-troubleshooting)
18. [Known limitations](#18-known-limitations)
19. [Working with git](#19-working-with-git)

---

## 1. What it does

| Area | Capabilities |
|---|---|
| **Students** | CSV import with row-by-row validation, activation by e-mail, registration and eligibility verification, contact-detail change requests (approved by a coordinator), resume upload |
| **Drives** | Companies with verified e-mail domains, drives of three types (Internship `I`, Full-time `F`, Internship + PPO/FTE `IF`), company criteria (CGPA, backlogs, programme, batch), invite-only HR accounts that expire with the drive |
| **Policy engine** | ALLOW / BLOCK / REVIEW for every application, with the rules that fired and why. Category bands, switching rules, absenteeism, offer-type rules, versioned policy, exceptions with reason and expiry |
| **Offers** | HR proposes, Officer confirms, student accepts or declines before a deadline (earlier of 24 h and the company's). Unanswered offers expire automatically. Every change is an event, so history is kept |
| **Attendance** | PPT / test / interview marking, append-only; unexcused absences raise a flag that feeds the absenteeism rule |
| **Dashboards** | Role-scoped overview, programme view, company report, switching eligibility, compliance queue, student "My placement", HR drive pipeline |
| **Reporting rules** | Placed *students* and *offers* are counted separately; FTE CTC (LPA) and internship stipend (₹) are separate figures and never averaged together; averages use accepted FTE offers only |
| **Exports** | CSV / Excel, masked by role, watermarked with who and when, step-up MFA, logged with row count and file hash, spreadsheet-formula neutralised |
| **Governance** | Two-person policy changes, exception requests, review queue, MFA resets with identity record, break-glass access with alert |
| **Audit** | Hash-chained audit log, tamper detection endpoint, JSONL archive job |

## 2. Roles at a glance

| Role | Scope | Main screens | Cannot do |
|---|---|---|---|
| **Student** | Own record only | Dashboard, Drives (apply), Applications, Offers (accept/decline), Notifications, Profile & security | See other students; edit status, CTC or category |
| **Coordinator** | Own programme(s) | Programme dashboard, Students (import, eligibility), Drives & attendance, Offers lifecycle, Switching, Review (read-only), Exception requests, Masked exports | Create drives, confirm offers, approve exceptions, change CTC or policy |
| **Placement Officer** | Whole university | Overview, Drives & companies, Offer proposals, Offers (incl. CTC correction), Students, Review decisions, Exceptions, Policy proposals, Company report, Exports, Audit (own + operational) | Publish policy (needs a Super Admin); manage accounts beyond HR invites |
| **Company HR** | Own company's drive | Drive pipeline: masked applicants, shortlist/select/reject, CSV of IDs, propose offers | Browse students; see contact details before shortlist; see other companies |
| **Super Admin** | Platform (aggregate) | Policy approval, Accounts, System & keys, Audit & integrity (hash-chain verify), masked Student lookup + break-glass, aggregate export | Edit student or offer data |
| **Placement Administrator** | — | **No screens in this portal.** The backend role and endpoints still exist (see [Known limitations](#18-known-limitations)) | — |

A deeper per-role walkthrough is in [section 12](#12-main-workflows).

## 3. Architecture

```
 Browser (React SPA)
    │  HTTPS (TLS 1.3, HSTS, strict CSP)         nothing in the browser is trusted
    ▼
 Edge: Nginx + ModSecurity (OWASP CRS), rate limiting          [docker compose --profile full]
    │
    ▼
 NestJS API  (stateless, modular monolith)
    ├─ Global guards, in order:  session auth → CSRF + Origin → role + MFA stage (deny by default) → step-up
    ├─ Modules: auth · students · drives · offers · compliance (attendance, exceptions, review)
    │           policy (engine, versions) · dashboards · exports · admin/system · jobs
    ├─ Rule engine: pure functions R1–R8; the ONLY writer of placement status & switching eligibility
    └─ Audit writer: HMAC hash chain
    │  parameterised SQL only (Prisma), per-request DB context for row-level security
    ▼
 Data tier (private network): PostgreSQL 16 · Redis 7 (sessions, rate limits, queues) · encrypted backups · append-only audit archive
```

**One request, end to end:** cookie → server-side session lookup (Redis) → Origin/CSRF check → route must declare a role (otherwise denied) and the session must be fully MFA-verified → sensitive routes need a *fresh* second factor → Zod validates the body (unknown fields are rejected) → the service checks scope (own record / programme / drive) → a transaction opens with `app.role` and `app.user_id` set so PostgreSQL row-level security independently filters rows → the change is written together with its audit entry.

## 4. Tech stack

| Layer | Choice |
|---|---|
| Front end | React 19, TypeScript, Vite, Tailwind CSS v4, React Router, React Hook Form + Zod, `@simplewebauthn/browser`, lucide-react |
| API | NestJS 11, Passport (custom session strategy), Prisma 6, Zod validation, helmet, multer, csv-parse |
| Database | PostgreSQL 16 with `pgcrypto`, row-level security, views, triggers, CHECK constraints |
| Sessions / jobs | Redis 7, ioredis, BullMQ |
| MFA | `otplib` (TOTP), `@simplewebauthn/server` (passkeys), e-mail OTP, Argon2id (`@node-rs/argon2`) for passwords and recovery codes |
| Reports | SQL views, ExcelJS, CSV |
| Mail | Nodemailer → Mailpit in development, SMTP relay in production |
| Deployment | Docker Compose, Nginx, ModSecurity + OWASP Core Rule Set, GitHub Actions CI (ESLint, `npm audit`, Semgrep) |

## 5. Repository layout

```
.
├── docker-compose.yml          Postgres, Redis, Mailpit (+ api, web, WAF edge with --profile full)
├── .env.example                Configuration template (never commit .env)
├── db/init/01-roles.sh         Creates the non-owner DB role the API runs as (RLS applies to it)
├── nginx/                      Certificates folder for the TLS edge
├── scripts/
│   ├── setup-env.mjs           Cross-platform: creates .env with fresh keys, never overwrites
│   ├── gen-certs.sh            Self-signed TLS cert for the local WAF edge
│   ├── backup.sh               Encrypted pg_dump, 30-day retention
│   └── restore-drill.sh        Monthly restore drill into a separate database
├── docs/ARCHITECTURE.md        Mapping to the design document, decisions, limitations, open questions
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma       27 models
│   │   └── migrations/         tables → security (RLS, views, triggers, grants) → fixes
│   ├── src/
│   │   ├── auth/               login, MFA (TOTP/passkey/e-mail/recovery), sessions, guards, password policy
│   │   ├── policy/             engine.ts (pure rules), engine.service.ts, policy.service.ts (versions)
│   │   ├── students/ drives/ offers/ compliance/ dashboards/ exports/ admin/ users/ jobs/
│   │   ├── common/             crypto, audit chain, Prisma+RLS context, masking, rate limiting, filters
│   │   └── seed.ts             Programmes + demo accounts and scenario data
│   ├── test/                   engine.spec.ts (unit) · security.e2e-spec.ts (end-to-end) · helpers
│   └── scripts/                dev-code.js (current MFA code for a demo account), dev-accounts.js
└── frontend/
    └── src/
        ├── lib/                api client (CSRF, step-up), session state machine, types, nav
        ├── components/         ui primitives, auth (sign-in MFA, enrolment, step-up), layout, staff
        └── pages/              student/ coordinator/(shared) officer/ hr/ superadmin/ shared/ dashboards/
```

## 6. Getting started

### Prerequisites

* **Node.js 22 or newer** and npm
* **Docker Desktop** (running) for PostgreSQL, Redis and Mailpit
* Git. On Windows, `.sh` scripts need Git Bash or WSL; everything in this section works in plain PowerShell or cmd.

### Step by step

Run from the repository root unless a `cd` is shown.

```bash
# 1. Create .env with fresh encryption keys (works on Windows too; never overwrites an existing .env)
node scripts/setup-env.mjs

# 2. Start Postgres 16, Redis 7 and Mailpit (the dev e-mail inbox)
docker compose up -d

# 3. Install and prepare the API
cd backend
npm install --legacy-peer-deps
npx prisma migrate deploy        # tables, row-level security, views, grants
npm run db:seed                  # 5 programmes + demo accounts and data
npm run dev                      # API on http://localhost:4000

# 4. In a second terminal: the web app
cd frontend
npm install
npm run dev                      # http://localhost:5173 (proxies /api to :4000)
```

### What you get

| Service | URL / port |
|---|---|
| Web app | http://localhost:5173 |
| API | http://localhost:4000/api (health: `/api/health`) |
| Dev e-mail inbox (Mailpit) | http://localhost:8025 |
| PostgreSQL | `localhost:5433` (not 5432, to avoid clashing with other projects) |
| Redis | `localhost:6380` |

> **Important:** `.env` holds the keys that encrypt mobile numbers, CTC and stipend. If you lose or replace `DATA_KEY`, already-encrypted data becomes unreadable. `scripts/setup-env.mjs` therefore refuses to overwrite an existing `.env`. Never run `cp .env.example .env` over a working one (the example only has placeholders, and `cp` does not exist in Windows cmd anyway).

### Resetting the demo data

```bash
cd backend
npm run db:reset      # drops and recreates the dev database (asks for confirmation if run by an AI tool)
npm run db:seed       # fresh demo accounts, new generated passwords
```

## 7. Demo accounts and signing in

`npm run db:seed` creates one account per role plus twelve students, and writes **generated** passwords and authenticator secrets to two git-ignored files:

* `backend/.dev-accounts.json`
* `backend/.dev-accounts.md` (readable table; refresh with `node scripts/dev-accounts.js md`)

| Role | E-mail |
|---|---|
| Super Admin | `superadmin1@nfsu.ac.in`, `superadmin2@nfsu.ac.in` |
| Placement Officer | `officer@nfsu.ac.in` |
| Coordinator (M.Tech CS) | `coord.mtechcs@nfsu.ac.in` |
| Coordinator (M.Sc CS, M.Sc DFIS) | `coord.mscdfis@nfsu.ac.in` |
| Company HR (Acme Cyber Labs) | `hr@acmecyber.example` |
| Students | `aarav@`, `diya@`, `kabir@`, `neel@`, `isha@`, `rohan@`, `arjun@`, `tara@`, `meera@`, `vikram@`, `anaya@`, `sara@` `nfsu.ac.in` |
| Placement Administrator | `admin@nfsu.ac.in` (signed out by the UI: no screens) |

**Getting the 6-digit code.** The demo accounts are pre-enrolled with an authenticator secret that no phone holds, so use the helper (any folder, full path works):

```bash
node backend/scripts/dev-code.js officer          # key from .dev-accounts.md, or an e-mail address
```

It prints the current code and its remaining seconds. Each code works once. Or paste the account's secret into any authenticator app ("enter a setup key"). Students and HR can also choose **E-mail code** on the sign-in screen and read it in Mailpit. Five wrong codes lock the account for 15 minutes.

**Scenario students** (each exercises a policy rule):

| Student | Situation | What you will see |
|---|---|---|
| Aarav | Unplaced, eligible, shortlisted at Acme | Free to apply; good for the apply flow |
| Diya | Holds a category B offer (₹8 LPA) | Next drive must pay ≥ ₹12 LPA (R6) |
| Kabir | Holds an A+ offer | Blocked from every drive (R6) |
| Isha | Holds an internship; *selected* at Acme | Can apply to FTE; target for the "Propose offer" demo |
| Rohan | Category C off-campus offer, NOC missing | Compliance flag |
| Tara | Holds internship + PPO/FTE | Blocked from everything (R5) |
| Meera | Pending offer inside its window | Applications go to review (R7) |
| Vikram | Unexcused absence at the last drive | Blocked (R4) until an exception |
| Anaya | Eligibility pending | Applications go to review (R2) |
| Arjun | Marked ineligible | Blocked (R2) |
| Neel | Not registered | Must confirm registration (R1) |
| Sara | Unplaced, applied at Acme | Free to apply |

**Trying the real first-time flow.** As the officer, open **Students → Add student** with any `@nfsu.ac.in` address. The activation e-mail appears in Mailpit; open its link, choose a password (12+ characters), and register a second factor by scanning the QR code with a phone.

## 8. Configuration reference

All settings are environment variables (`.env`); the API validates them at start-up and refuses to run with a missing or malformed key.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `production` turns on `Secure` cookies and stricter behaviour |
| `PORT` | `4000` | API port |
| `DATABASE_URL` | — | Runtime connection as `placement_app` (RLS applies to this role) |
| `DIRECT_DATABASE_URL` | — | Migrations and seed, as `placement_owner` |
| `REDIS_URL` | — | Sessions, rate limits, BullMQ |
| `WEB_ORIGIN` | `http://localhost:5173` | The one allowed browser origin (CORS, CSRF Origin check, WebAuthn) |
| `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_NAME` | `localhost` / portal name | Passkey relying-party identity (must match the real domain in production) |
| `COOKIE_SECURE` | `false` | `true` uses the `__Host-` cookie prefix; required over HTTPS |
| `TRUST_PROXY` | `false` | Set `true` behind Nginx so the real client IP is used |
| `DATA_KEY` | generated | 32-byte base64 key for AES-256-GCM column encryption |
| `HMAC_KEY` | generated | 32-byte base64 key for mobile-number dedupe hashes and the audit hash chain |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `MAIL_FROM` | Mailpit | Outgoing mail |
| `SUPERADMIN_ALLOWED_CIDRS` | loopback + private ranges | Networks the Super Admin may sign in from |
| `MAX_SUPER_ADMINS` | `2` | Cap on Super Admin accounts |
| `ALLOW_TOTP_FOR_PRIVILEGED` | `true` in dev | Lets admin roles use an authenticator app instead of a passkey. **Must be `false` in production** |
| `AUTH_IP_LIMIT` | `40` | Requests per minute per IP on login/MFA/activation endpoints |
| `STUDENT_EMAIL_DOMAIN` | `nfsu.ac.in` | Required domain for student accounts (empty = any, for testing) |
| `AUDIT_ARCHIVE_DIR` / `UPLOAD_DIR` / `BACKUP_DIR` | `./audit-archive` etc. | Local folders |
| `PG_PORT` / `REDIS_PORT` | `5433` / `6380` | Host ports for the Docker data tier |
| `OWNER_DB_PASSWORD` / `APP_DB_PASSWORD` / `REDIS_PASSWORD` | dev values | Container credentials; change for anything beyond local use |

## 9. The policy rule engine

The engine answers one question: **can student S apply to drive D?** with `ALLOW`, `BLOCK` or `REVIEW`, plus the list of rules that fired. It runs when a student applies, when a shortlist is built, when a drive opens, and when an offer is accepted. Rules are small pure functions in `backend/src/policy/engine.ts`; thresholds come from the versioned `policy_rule` table, not code.

**Category bands** (from the CTC of an offer or drive; the category is derived, never typed):

| Category | CTC | After accepting an offer in this band |
|---|---|---|
| A+ | ≥ ₹16 LPA | Blocked from all further drives (out of process) |
| A | ₹10 to < ₹16 | May apply only to A+ drives |
| B | ₹6 to < ₹10 | May apply only if new CTC ≥ 1.5 × current CTC |
| C | < ₹6 | May apply to higher-category drives (A+, A, B) |

**Rules, evaluated in order** (a BLOCK wins over a REVIEW):

| # | Rule | Outcome |
|---|---|---|
| R1 | Not registered or deregistered | BLOCK |
| R2 | Ineligible → BLOCK; verification pending → REVIEW | BLOCK / REVIEW |
| R3 | Company criteria: CGPA, backlogs, programme, batch | BLOCK |
| R4 | Unexcused absence in the last 3 drives | BLOCK unless an exception exists |
| R5 | Offer-type: `I` holder → not another `I`; `F` holder → not another `F` (see note); `IF` holder → nothing | BLOCK |
| R6 | Category switching against the highest accepted FTE CTC | BLOCK |
| R7 | A pending offer still inside its acceptance window | REVIEW |
| R8 | Data conflicts: off-campus offer without NOC, missing CTC, duplicate offer | REVIEW |

*Note on R5 vs R6:* the source document's offer-type table and category table conflict for FTE-only holders. The implementation lets the category rule (R6) decide an FTE→FTE move once a CTC is on record; with no CTC, R5 applies as written. This is documented in tests `P6`/`P6b` and flagged as an open question.

Other engine behaviour:

* **Exceptions** override a specific rule for one student, with a written reason and an expiry (max 365 days); the decision then reads `ALLOW (exception #id)`. Only the Placement Officer records them; coordinators request.
* **Acceptance deadline** = the earlier of (offer issued + 24 h) and the company's stated deadline. A scheduled job marks unanswered offers `expired` and tells the coordinator.
* **Placement status** (`Unplaced`, `Internship only`, `FTE only`, `Internship + PPO/FTE`) and **switching eligibility** are recomputed from accepted offers after every offer, exception or policy event. Nobody can type them, and no API has a write path to them.
* **Exact arithmetic:** LPA values are compared in hundredths, so `1.5 × 8 = 12` has no floating-point drift at the boundary (tested).
* **Versioning:** every stored decision records the policy version used, so a past decision can be explained after the rules change. A rule change is *proposed* by an Officer or Admin and only takes effect when a **different** person (Super Admin) publishes it.

## 10. Authentication, sessions and step-up

| Role | Primary second factor | Fallbacks | Idle / absolute timeout |
|---|---|---|---|
| Student | Authenticator app (TOTP) | E-mail OTP (6 digits, 5 min), 10 single-use recovery codes, "remember device" 30 days | 15 min / 8 h |
| Coordinator, Officer | Passkey (WebAuthn) | TOTP + recovery codes | 15 min / 8 h |
| Company HR | TOTP | E-mail OTP + recovery codes | 15 min / 4 h |
| Administrator | Passkey only | Reset by a Super Admin | 10 min / 4 h |
| Super Admin | Hardware key, two registered | Sealed offline recovery codes; sign-in only from allowed networks | 10 min / 2 h |

* **Mandatory MFA for every role.** A new or reset account sees no data until a second factor is registered.
* **How the 6-digit code works:** at setup a random secret is shared (QR code). The app and the server both compute `code = f(secret, current 30-second window)`. Nothing is sent from the phone to the server except the code you type; each code is accepted once.
* **Lockout:** 5 failed passwords or codes → 15-minute lockout, alert e-mail. Unknown user and wrong password return the same message.
* **Sessions** live in Redis under a hash of the cookie value. The cookie is opaque, `HttpOnly`, `SameSite=Strict`, and `Secure` over HTTPS; the id is rotated at login and at step-up, and every session is revoked on a password or MFA change.
* **Step-up MFA** (fresh code, valid 5 minutes) is required for: students accepting/declining offers and changing contact details or password; coordinators/officers importing students, recording offers, exporting, approving exceptions; officers confirming offers or correcting CTC; HR uploading results or proposing offers; and *every* state-changing call by a Super Admin.
* **Passwords:** Argon2id, minimum 12 characters, checked against a list of common/breached passwords, no forced rotation.
* **New-device alert:** a sign-in from an unseen browser e-mails the owner. Every Super Admin login e-mails all Super Admins.

## 11. Data model and database security

27 tables (`backend/prisma/schema.prisma`), grouped:

* **Identity:** `user_account`, `mfa_factor`, `recovery_code`, `session` (audit mirror), `trusted_device`
* **People and organisations:** `programme`, `student`, `coordinator_scope`, `company`, `hr_user`
* **Recruitment:** `drive`, `application`, `attendance`
* **Offers:** `offer`, `offer_event`, `offer_proposal`
* **Policy:** `policy_version`, `policy_rule`, `engine_decision`, `student_placement_state`, `exception`, `exception_request`, `contact_change_request`, `review_case`
* **Operations:** `audit_log`, `export_log`, `system_setting`

**Views** (dashboards read only from these; they run with the caller's rights, so row-level security still filters them): `student_status_v`, `offer_current_v`, `attendance_current_v`, `application_pipeline_v`.

**Defence in depth in the database** (`prisma/migrations/*_security`):

* **Row-level security** on student, application, offer, offer events, proposals, attendance, decisions, exceptions, contact changes, placement state and review cases. Policies read `app.role` / `app.user_id`, set per transaction by the API. The API connects as `placement_app`, which is not a superuser and does not own the tables.
* **Append-only tables** (`offer_event`, `engine_decision`, `attendance`, `audit_log`, `export_log`): the API role has INSERT/SELECT only.
* **Triggers:** a student session cannot change anything on its own student row except registration, nor anything on an offer except accepting/declining; `placement_id` is immutable.
* **Constraints:** CGPA 0–10, non-negative backlogs, valid batch year, Placement ID format, CTC ranges, deadline after issue, enum columns.
* **Encryption:** mobile, CTC, stipend and TOTP secrets are AES-256-GCM ciphertext (`v1.<iv>.<tag>.<data>`), bound to their column so a value cannot be moved between columns.
* **Audit hash chain:** `hash = HMAC(key, prev_hash ‖ canonical(entry))`. The key is not in the database, so someone editing a row cannot recompute the chain.

**Migrations.** Never edit a migration that has been applied; add a new one. A new table is invisible to the API role until a migration grants it on purpose (default privileges are not used).

## 12. Main workflows

**A. Student onboarding (coordinator → student).** Upload a CSV (`placement_id, name, email, mobile, programme, batch, cgpa, backlogs`; max 1 MB / 2000 rows) → preview lists every rejected row with its reason (duplicate ID in file or database, bad mobile, wrong programme, not your programme) → commit imports only clean rows and audits the import → each student gets a 24-hour activation link, sets a password and registers MFA → the student confirms registration → the coordinator verifies eligibility.

**B. Drive setup (officer → HR).** Create the company (verified domain) and a draft drive (type, CTC and/or stipend, criteria, offer deadline) → **Open** pre-computes ALLOW/BLOCK/REVIEW for every registered student and freezes the terms → **Invite HR** (address must be on the company domain, valid 45 days).

**C. Recruitment rounds (coordinator + HR).** Students apply (the decision is stored). Coordinators mark attendance; absences raise a review flag. HR sees applicants with name, programme, CGPA and resume only; shortlisting re-runs the engine and releases contact details. HR can also upload a CSV of Placement IDs for shortlists, selections and rejections.

**D. Offer and acceptance (HR → officer → student).** HR proposes an offer for a *selected* student → the Officer confirms (creating the offer, its deadline and an e-mail to the student) → the student accepts or declines with step-up MFA → acceptance recomputes status and switching eligibility. Joining, PPO and NOC updates are later events recorded by the coordinator.

**E. Review and reporting (officer).** The review queue lists REVIEW decisions, absenteeism flags, suspected violations (e.g. a student trying to set their own CTC), expired offers and missing NOCs. The Officer approves an exception or confirms the block, always with a written reason. Dashboards and exports come from the same views, so figures match the records.

## 13. API reference

Base path `/api`, JSON, cookie session. Every state-changing request needs the `X-CSRF-Token` header returned at login and an `Origin` equal to `WEB_ORIGIN`. 🔒 = needs a fresh step-up. Roles: **S** student, **C** coordinator, **O** officer, **H** HR, **A** administrator (backend only), **SA** super admin.

| Area | Endpoint | Who |
|---|---|---|
| **Auth** | `POST /auth/login`, `POST /auth/activate` | public |
| | `GET /auth/me`, `POST /auth/mfa/verify`, `/auth/mfa/email/send`, `/auth/mfa/passkey/options`, `/auth/mfa/passkey/verify` | signed in |
| | `POST /auth/enrol/totp/start\|confirm`, `/auth/enrol/passkey/options\|verify` 🔒 | signed in |
| | `GET /auth/factors`, `POST /auth/recovery-codes/regenerate` 🔒, `/auth/password/change` 🔒, `/auth/logout`, `/auth/logout-all` | signed in |
| **Students** | `GET /students`, `GET /students/:id` (masked by role) | C O A SA (S own) |
| | `POST /students`, `PATCH /students/:id`, `POST /students/:id/eligibility` | C O A |
| | `POST /students/import/preview` 🔒, `/students/import/commit` 🔒 | C O A |
| | `GET /students/contact-changes`, `POST /students/contact-changes/:id/decide` | C O A |
| | `GET /students/me`, `POST /students/me/confirm-registration`, `/me/contact-change` 🔒, `/me/resume` | S |
| | `POST /students/:id/break-glass` | SA |
| **Drives** | `POST /companies`; `POST /drives`, `PATCH /drives/:id`, `/drives/:id/open`, `/close`, `/invite-hr` | O A |
| | `GET /companies`, `GET /drives`, `GET /drives/:id` | role-scoped |
| | `GET /drives/mine`, `GET /applications/mine`, `POST /drives/:id/apply`, `/withdraw` | S |
| | `GET /drives/:id/eligibility` | C O A |
| | `GET /drives/:id/applicants`, `POST /drives/:id/stage` | C O H A |
| | `POST /drives/:id/stage-upload` 🔒 | H O A |
| **Offers** | `GET /offers`, `GET /offers/:id/events` | S C O H A (scoped) |
| | `POST /offers/proposals` 🔒 | H |
| | `GET /offers/proposals`, `POST /offers/proposals/:id/confirm` 🔒, `/reject` | O A (H: own, read) |
| | `POST /offers` 🔒 (off-campus), `PATCH /offers/:id/lifecycle` | C O A |
| | `POST /offers/:id/correct-ctc` 🔒 | O A |
| | `POST /offers/:id/respond` 🔒 | S |
| | `PATCH /offers/:id` | always refused (405 for staff, 403 for students) |
| **Compliance** | `POST /attendance`, `GET /attendance/drive/:id` | C O H A |
| | `GET /attendance/mine` | S |
| | `POST /exceptions` 🔒, `DELETE /exceptions/:id` 🔒 | O A |
| | `GET /exceptions`, `/exceptions/student/:id`, `GET /exceptions/requests` | C O A (SA list) |
| | `POST /exceptions/requests` | C |
| | `POST /exceptions/requests/:id/decide` 🔒 | O A |
| | `GET /review`, `/review/counts` | C O A |
| | `POST /review/:id/resolve` 🔒 | O A |
| **Dashboards** | `GET /dashboards/overview` | O A SA |
| | `GET /dashboards/programme` | C |
| | `GET /dashboards/companies`, `/dashboards/compliance` | O A |
| | `GET /dashboards/switching` | C O A |
| | `GET /dashboards/my-placement` | S |
| | `GET /dashboards/drive-pipeline/:driveId` | H |
| **Exports** | `GET /exports/students`, `/exports/offers` 🔒 (`?format=csv\|xlsx`) | C (masked) O A |
| | `GET /exports/summary` 🔒, `GET /exports/log` | O A SA |
| **Policy** | `GET /policy/current` | all but H |
| | `GET /policy/versions` | O A SA |
| | `POST /policy/propose` 🔒 | O A |
| | `POST /policy/:version/publish`, `/reject` | SA |
| **Audit** | `GET /audit` (filters: action, entity, alerts) | O (scoped) A SA |
| | `GET /audit/verify` | SA A |
| **Admin / system** | `GET /users`, `POST /users` 🔒, `/users/:id/status` 🔒, `/mfa-reset` 🔒, `/resend-activation`, `PUT /users/:id/scope` 🔒 | A (below admin), SA (admins) |
| | `GET /system/settings`, `PUT /system/settings`, `GET /system/status`, `GET /system/backups`, `POST /system/restore-drills` | SA |

Errors are JSON: `{ statusCode, message, code }`. Useful codes: `STEP_UP_REQUIRED`, `MFA_REQUIRED`, `ENROL_REQUIRED`, `NO_SESSION`, `BAD_CSRF`, `BAD_ORIGIN`, `POLICY_BLOCK` (with the decision), `LOCKED`, `OUT_OF_SCOPE`, `DUPLICATE`.

## 14. Security controls

| Control | How |
|---|---|
| Authentication | Argon2id; mandatory MFA; lockout; breached-password list; TOTP replay protection; timing-equalised unknown-user path |
| Authorisation | Deny-by-default guard chain; object-level checks on every id; field masking on the server; PostgreSQL row-level security; DB triggers |
| Anti-tampering | Server-computed status/category/CTC; strict Zod schemas so unknown fields are a `400` and a logged tamper attempt; students have no write path to derived fields |
| Confidentiality | TLS 1.3 + HSTS at the edge; AES-256-GCM columns; masked values for roles without need |
| Input handling | Zod validation on every request; Prisma parameterised queries only; output encoded by React; strict CSP (`script-src 'self'`, `style-src 'self'`); uploads type-checked and size-limited |
| Sessions | Opaque ids stored hashed; rotation at login and step-up; idle + absolute timeouts per role; revoke-all on credential change |
| CSRF | Per-session token + Origin check; `SameSite=Strict` |
| Audit | Append-only, HMAC hash-chained, archived by a job; `GET /audit/verify` |
| Exports | Role-masked, step-up, watermarked, logged with file SHA-256, formula-injection neutralised |
| Privacy | Retention setting + archive job; students cannot see each other; HR sees masked data until shortlist; Super Admin sees masked data unless break-glass |

The security scenarios from the design document (S1–S8) are executable tests, not just claims; see the next section.

## 15. Testing

```bash
cd backend
npm test            # unit: 27 tests, no infrastructure needed
npm run test:e2e    # end-to-end: 34 tests, needs the Docker data tier running
npm run typecheck   # backend types
cd ../frontend
npm run build       # frontend typecheck + production bundle
```

* **Unit (`test/engine.spec.ts`)** covers P1–P10 (category boundaries at exactly ₹16/₹10/₹6, the 1.5× boundary, offer-type rules, absenteeism with and without exceptions, the 24 h / 48 h deadline case), every rule R1–R8, exceptions that are expired or revoked, and the derived placement state.
* **End-to-end (`test/security.e2e-spec.ts`)** runs the real API against real PostgreSQL (with row-level security) and Redis in a **separate database, `placement_test`** (and Redis db 1), so it never touches development data. It covers S1–S8 (status/CTC tampering, IDOR, HR scope, MFA lockout and replay, SQLi/XSS payloads, session replay after logout, audit hash-chain tampering, duplicate import rows), plus CSRF/Origin, deny-by-default, step-up freshness, the engine enforced server-side, role separation (Super Admin masking and break-glass, four-eyes policy change, MFA reset rules) and export masking.
* The e2e suite is idempotent: run it as often as you like.

## 16. Background jobs, backups and deployment

**Jobs (BullMQ, scheduled when the API starts):**

| Job | Every | What it does |
|---|---|---|
| `expire-offers` | 1 min | Marks unanswered offers expired, opens a review case, e-mails the coordinator |
| `remind-offers` | 15 min | E-mails students whose offer is within 6 hours of its deadline (once per offer) |
| `archive-audit` | 30 s | Appends new audit rows to `AUDIT_ARCHIVE_DIR/audit-YYYY-MM-DD.jsonl` |
| `recompute-state` | 30 min | Safety net: recomputes every student's placement state |
| `purge` | 6 h | Removes old session mirrors, expired devices, stale activation tokens |
| `retention` | 24 h | Archives students whose batch is older than the retention setting |

**Full stack in containers** (API, web, and a TLS 1.3 + ModSecurity edge):

```bash
sh scripts/gen-certs.sh                       # self-signed cert (Git Bash/WSL on Windows)
docker compose --profile full up -d --build   # https://localhost:8443
```

Set `WEB_ORIGIN=https://localhost:8443` and `COOKIE_SECURE=true` for this mode. Postgres and Redis sit on the internal data network; only the edge publishes a port.

**Backups:** `BACKUP_PASSPHRASE=… sh scripts/backup.sh` writes an AES-256 encrypted `pg_dump` to `backups/` and deletes files older than 30 days. `sh scripts/restore-drill.sh backups/<file>` restores into a throwaway database and counts rows; then record the drill under **Super Admin → System & keys**. Point-in-time recovery needs WAL archiving, which is not configured here.

**Production checklist**

- [ ] Real secrets from Vault or a cloud KMS, not `.env`; rotate the dev passwords in `.env.example`
- [ ] `NODE_ENV=production`, `COOKIE_SECURE=true`, `TRUST_PROXY=true`, correct `WEB_ORIGIN` and `WEBAUTHN_RP_ID`
- [ ] `ALLOW_TOTP_FOR_PRIVILEGED=false` and `SUPERADMIN_ALLOWED_CIDRS` set to the university network/VPN
- [ ] Real TLS certificate; WAF tuned and an OWASP ZAP scan run against it
- [ ] Production Postgres on a private subnet, only the API can reach it; WAL archiving enabled
- [ ] SMTP relay configured; SSO if the university provides it
- [ ] Audit archive pointed at a write-once bucket
- [ ] Monthly restore drill scheduled

## 17. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `'cp' is not recognized` | You are in Windows cmd. Use `node scripts/setup-env.mjs` (no `cp`). If a `.env` already exists, do nothing: do **not** overwrite it |
| `Cannot find module '…/dev-code.js'` | Your terminal is in the wrong folder. Use the full path: `node "C:\path\to\repo\backend\scripts\dev-code.js" officer` |
| "That code is not valid" | Codes last 30 s and work once; run `dev-code.js` again and type it straight away. `123456` in the box is only a placeholder |
| "Too many failed attempts" (locked 15 min) | Five wrong passwords or codes. In development, clear it: `docker compose exec redis redis-cli -a <REDIS_PASSWORD> FLUSHDB` (also signs everyone out) |
| Docker errors / containers missing | Start Docker Desktop, then `docker compose up -d`. Check with `docker compose ps` |
| `port is already allocated` on 5432/6379 | Another project holds it. This repo uses 5433/6380 by default; change `PG_PORT`/`REDIS_PORT` in `.env` and the matching URLs |
| `Invalid environment configuration` at API start | A key in `.env` is missing or not 32 bytes (base64). Run `node scripts/setup-env.mjs` on a clean checkout |
| Mobile numbers / CTC show errors after changing `.env` | `DATA_KEY` changed, so existing ciphertext cannot be read. Restore the old key, or `npm run db:reset && npm run db:seed` for demo data |
| Web app loads but every call fails | The API is not running on :4000, or the page is not on `http://localhost:5173` (the Origin check rejects other origins) |
| E-mail codes / activation links never arrive | Open Mailpit at http://localhost:8025; nothing is sent outside your machine in development |
| A `403` on something you expect to see | By design: scope is enforced on the server (own record, programme, drive). Check the signed-in role |
| `prisma migrate reset` refuses to run from an AI tool | Prisma requires explicit user consent for destructive resets. Run `npm run db:reset` yourself in a terminal |

## 18. Known limitations

* **No Placement Administrator screens.** The supplied front end omits this role on purpose. The backend still implements it (user administration, MFA resets, exports, audit). With no admin UI, nothing in the UI can create Coordinator/Officer accounts or reset their MFA. Decide whether the Super Admin should take over these duties, an admin area should return, or the role should be removed from the backend (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)).
* Passkey code paths are implemented but have only been exercised manually; the automated tests use TOTP.
* Keys come from the environment, not Vault/KMS; there is no key-rotation job (the ciphertext format is versioned for it).
* No SSO and no SMS gateway. WAL/point-in-time recovery and an object-lock audit store are not configured.
* The WAF edge is configured but has not been load- or penetration-tested here.
* Rule interpretations that need the Placement Cell's confirmation: the 1.5× rule is CTC-only; what category C may apply to; whether stipend ever sets a category; valid emergency exceptions and who approves them; record retention after graduation; SSO availability; and the F→F interpretation in R5/R6.

## 19. Working with git

```bash
git add -A
git commit -m "Describe the change"
git push
```

`.env`, `backend/.dev-accounts.*`, `node_modules`, build output, uploads, backups and audit archives are git-ignored; do not remove those entries. A `.gitattributes` keeps shell scripts on Unix line endings so they run inside Linux containers. CI (`.github/workflows/ci.yml`) runs type checks, unit and end-to-end tests, a dependency audit and Semgrep on every push.

For design decisions, the mapping from each section of the architecture document to code, and the open questions for the Placement Cell, read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
