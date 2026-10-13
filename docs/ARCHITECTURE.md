# Architecture notes

How the code maps to the *NFSU Placement Portal – System Architecture* document, where it deliberately differs, and what is left.

## 1. Where each part of the document lives

| Document section | Code |
|---|---|
| 2 Architecture (modular monolith, 4 tiers) | `backend/src` modules: `auth`, `students`, `drives`, `offers`, `compliance`, `policy`, `dashboards`, `exports`, `admin`, `jobs`; Docker Compose + `nginx/` edge |
| 3 Roles and access control | `auth/guards.ts` (deny-by-default, role, stage, step-up), per-route `@Roles`, scope checks in services, `common/masking.ts`, RLS in `prisma/migrations/*_security` |
| 4 Authentication and MFA | `auth/*` (login, MFA policy per role, TOTP, e-mail OTP, WebAuthn, recovery codes, lockout, sessions in Redis, trusted devices for students) |
| 5 Policy rule engine | `policy/engine.ts` (pure functions R1–R8), `policy/policy.service.ts` (versioned rules, two-person publish), `policy/engine.service.ts` (DB side; the only writer of `student_placement_state`) |
| 6 Data model | `backend/prisma/schema.prisma` + `migrations/` (plus `offer_proposal`, `review_case`, `exception_request`, `contact_change_request`, `trusted_device`, `system_setting`) |
| 7 Workflows A–E | import → `students`; drive setup → `drives`; rounds → `drives` + `compliance/attendance`; offer + acceptance → `offers`; review/reporting → `compliance/review`, `dashboards`, `exports` |
| 8 Security controls | see section 3 below |
| 9 Dashboards | `dashboards/*` (read the views `student_status_v`, `offer_current_v`, `attendance_current_v`, `application_pipeline_v`) |
| 10 Stack and deployment | `docker-compose.yml`, `backend/Dockerfile`, `frontend/Dockerfile`, `.github/workflows/ci.yml`, `scripts/` |
| 11 Tests | `backend/test/engine.spec.ts` (P1–P10), `backend/test/security.e2e-spec.ts` (S1–S8 + controls) |

## 2. Decisions and deviations (please read)

1. **Placement Administrator removed from the UI.** As requested, the supplied frontend has no admin area. The *backend* still contains the `admin` role and its endpoints (user administration, MFA resets, exceptions, exports, audit). An account with that role who signs in is told the role is not available and is signed out. **Consequence:** with no Admin screens, nothing in the UI can create Coordinator / Officer / HR accounts or reset their MFA (HR accounts are still created by the Officer's "Invite HR"; students by CSV import). Options: (a) let the Super Admin manage those roles too (a one-line change in `users.service.ts › manageableRoles`), (b) restore an Admin area, or (c) remove the role from the backend. This needs a decision from the Placement Cell because it changes the separation of duties in section 3 of the document.
2. **Rule R5 vs R6 conflict resolved.** The offer-type table says an FTE-only holder is "blocked from another F", but the category table (and tests P2/P4) let an A/B/C holder move to a *higher-category* FTE drive. Both can only be true if, once a CTC is on record, the FTE→FTE move is governed by the category rule (R6) and R5 steps aside. With no CTC on record R5 applies as written. Tests `P6`, `P6b` document this. **Add it to the open questions for the Placement Cell.**
3. **Passkeys in development.** Passkeys are the primary factor for staff and the only one for admin roles. So that the app can be exercised without a hardware key, `ALLOW_TOTP_FOR_PRIVILEGED=true` (dev default) allows an authenticator app for those roles. **Set it to `false` in production** (the Super Admin dashboard shows a warning while it is on). Super Admin also needs two registered keys when it is off.
4. **Column encryption and aggregates.** CTC and stipend are encrypted in the application (AES-256-GCM), so SQL views cannot compute averages. Counts and statuses come from views; average/median/highest are computed in the API after decrypting accepted offers, inside the caller's RLS context. Dashboards still read only from views for the underlying rows.
5. **Placement status** lives in `student_placement_state`, written only by the rule engine as the `system` database role after every offer / policy / exception event. `student_status_v` reads from it.
6. **Officer audit scope.** The matrix says Officer sees "own actions and programme". Implemented as: their own actions plus the operational activity of coordinators, students and company users (not administrator activity).
7. **Notifications** in the student UI are derived from live records (offers, applications, registration, switching rules); there is no separate message store.
8. **Placement ID format** is assumed to be 6–20 upper-case letters, digits or dashes (`student_placement_id_format`). Student e-mails must end in `STUDENT_EMAIL_DOMAIN` (default `nfsu.ac.in`; empty = any).

## 3. Section 8 controls → mechanism

| Control | Implemented as |
|---|---|
| Authentication | Argon2id, lockout (5 failures → 15 min, Redis), same error for unknown user / wrong password (with timing-equalising dummy verify), breached/common password list, TOTP replay protection |
| Role-based access | Global guards (auth → CSRF/Origin → role+stage, deny by default → step-up), object-level checks, field masking on the server, **row-level security** (policies keyed on `app.role`/`app.user_id` set per transaction), DB triggers that stop a student session changing eligibility or offer terms |
| Confidentiality | TLS 1.3 + HSTS at the edge, AES-256-GCM columns with context (AAD) binding, versioned ciphertext, masked values |
| Input / query security | Zod schemas on every request (`.strict()` — unknown fields are a 400 and a logged tamper attempt), Prisma parameterised queries only, React output encoding, strict CSP, CSRF token + Origin check, file uploads type-checked and size-limited |
| Audit logging | `audit_log`, HMAC hash chain (key outside the DB), app role has INSERT/SELECT only, JSONL archive job (stand-in for an object-lock bucket), `GET /audit/verify` |
| Integrity | Unique Placement ID, duplicate detection (hashed mobile), server-computed status/category, append-only events, CHECK constraints |
| Session security | Opaque ids hashed in Redis, `HttpOnly`/`SameSite=Strict`/`Secure`, rotation at login and step-up, idle + absolute timeouts per role, revoke-all on password/MFA change, log out all devices |
| Backup and recovery | `scripts/backup.sh` (encrypted `pg_dump`, 30-day retention), `scripts/restore-drill.sh`, drill record in the Super Admin console. **WAL archiving / PITR is not configured in the prototype.** |
| Export security | Officer/Admin full, Coordinator masked own programme, Super Admin aggregate only; step-up; watermark; row count + SHA-256 in `export_log`; spreadsheet formula neutralisation |
| Privacy and retention | `retention_years` setting + daily archive job; deletion is not performed automatically |

## 4. Limitations of the prototype

* Secrets/keys come from the environment (`.env`), not Vault/KMS. Key *rotation* is supported by the ciphertext format (`v1.` prefix) but there is no rotation job.
* No SSO, no SMS gateway (e-mail OTP is used as the fallback factor). Mail goes to Mailpit in development.
* The WAF/TLS edge (`docker compose --profile full`) is configured but has not been load- or penetration-tested here; run OWASP ZAP against it before go-live.
* The audit "write-once store" is a local append-only file, not a bucket with object lock.
* No payroll or offer-letter verification with companies; the engine applies the published rules but cannot judge intent.
* Passkey registration/sign-in code paths are implemented but only exercised manually with a real authenticator; the automated tests use TOTP.

## 5. Open questions for the Placement Cell (from the document, plus one)

☐ Is the 1.5× rule for category B based on CTC only? ☐ What exactly can a category C student apply to? ☐ Does an internship stipend ever decide a category? ☐ Which emergencies count as valid absence exceptions, and who approves them? ☐ How long must records be retained after graduation? ☐ Is university SSO available? ☐ **Does an FTE-only (F) holder who moves to a higher-category FTE drive count as "another F"? (implemented as: no, category rules decide)** ☐ **Who administers accounts now that the Placement Administrator role is gone?**
