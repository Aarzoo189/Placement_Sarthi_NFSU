/**
 * Demo / development seed. Run with `npm run db:seed` (needs the Docker data tier and `npm run build`).
 *
 *  - always: the five programmes
 *  - unless SEED_DEMO=false: demo accounts for every role, companies, drives, and students that exercise each policy rule
 *
 * Demo passwords and TOTP secrets are GENERATED on every run and written to backend/.dev-accounts.json (git-ignored),
 * never printed. Demo users are pre-enrolled with an authenticator (TOTP) so you can sign in straight away: add the
 * `totp_secret` from that file to any authenticator app, or use otplib to generate codes in tests.
 * Never run the demo seed against a production database.
 */
// Must run before AppModule is imported: AppModule reads DISABLE_JOBS when its decorator is evaluated.
process.env.DISABLE_JOBS = 'true';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'fs';
import { resolve } from 'path';
import { authenticator } from 'otplib';
import { randomBytes } from 'crypto';
import { AppModule } from './app.module';
import { CryptoService } from './common/crypto.service';
import { MfaService } from './auth/mfa.service';
import { EngineService, CTC_AAD, STIPEND_AAD, catToDb } from './policy/engine.service';
import { PolicyService } from './policy/policy.service';
import { categoryFor, computeDeadline } from './policy/engine';
import { MOBILE_AAD } from './students/students.service';
import { Prisma, PrismaClient, Role } from '@prisma/client';

const PROGRAMMES = [
  { code: 'MTECH-CS', name: 'M.Tech Cyber Security' },
  { code: 'MTECH-AIDS', name: 'M.Tech Artificial Intelligence & Data Science' },
  { code: 'BTECH-MTECH-CS', name: 'B.Tech-M.Tech Computer Science & Engineering (Cyber Security)' },
  { code: 'MSC-CS', name: 'M.Sc Cyber Security' },
  { code: 'MSC-DFIS', name: 'M.Sc Digital Forensics & Information Security' },
];

const pw = () => randomBytes(12).toString('base64url') + 'aA1!';
const mobile = (i: number) => `9${String(800000000 + i * 1111).padStart(9, '0')}`;

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  // Seed writes use the OWNER connection (bypasses row-level security, which only governs the API's runtime role).
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_DATABASE_URL } } });
  const crypto = app.get(CryptoService);
  const mfa = app.get(MfaService);
  const engine = app.get(EngineService);
  const policy = app.get(PolicyService);
  await policy.onModuleInit();

  for (const p of PROGRAMMES) await prisma.programme.upsert({ where: { code: p.code }, create: p, update: { name: p.name } });
  const prog = Object.fromEntries((await prisma.programme.findMany()).map((p) => [p.code, p.id]));
  console.log(`Programmes ready: ${Object.keys(prog).join(', ')}`);

  if (process.env.SEED_DEMO === 'false') return void (await app.close(), await prisma.$disconnect());
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed demo data in production');
  if (await prisma.user_account.count()) {
    console.log('Users already exist: skipping demo data (run `npm run db:reset` first for a clean demo).');
    return void (await app.close(), await prisma.$disconnect());
  }

  const { version, params } = await policy.current();
  const accounts: Record<string, { email: string; password: string; totp_secret: string; recovery_codes?: string[]; role: string }> = {};

  async function user(key: string, email: string, name: string, role: Role) {
    const password = pw();
    const secret = authenticator.generateSecret(20);
    const u = await prisma.user_account.create({ data: { email, name, role, status: 'active', password_hash: await crypto.hashPassword(password), mfa_enrolled: true, password_changed_at: new Date() } });
    await prisma.mfa_factor.create({ data: { user_id: u.id, type: 'totp', secret_enc: crypto.encrypt(secret, 'mfa_factor.secret_enc'), label: 'Authenticator app', confirmed_at: new Date() } });
    const codes = role === 'admin' ? undefined : await mfa.regenerateRecoveryCodes(u.id);
    accounts[key] = { email, password, totp_secret: secret, recovery_codes: codes, role };
    return u;
  }

  // ---- staff ----
  await user('superadmin1', 'superadmin1@nfsu.ac.in', 'Dr. Meenakshi Rao (Placement Cell Head)', 'superadmin');
  await user('superadmin2', 'superadmin2@nfsu.ac.in', 'Hemant Joshi (IT Security Officer)', 'superadmin');
  await user('admin', 'admin@nfsu.ac.in', 'Pooja Trivedi (Placement Administrator)', 'admin');
  const officer = await user('officer', 'officer@nfsu.ac.in', 'Prof. Rakesh Pandya (Placement Officer)', 'officer');
  const coord1 = await user('coordinator_mtech_cs', 'coord.mtechcs@nfsu.ac.in', 'Dr. Sunita Desai (Coordinator, M.Tech CS)', 'coordinator');
  const coord2 = await user('coordinator_msc_dfis', 'coord.mscdfis@nfsu.ac.in', 'Dr. Imran Qureshi (Coordinator, M.Sc DFIS)', 'coordinator');
  await prisma.coordinator_scope.create({ data: { user_id: coord1.id, programme_id: prog['MTECH-CS'] } });
  await prisma.coordinator_scope.createMany({ data: [{ user_id: coord2.id, programme_id: prog['MSC-DFIS'] }, { user_id: coord2.id, programme_id: prog['MSC-CS'] }] });

  // ---- company + HR ----
  const acme = await prisma.company.create({ data: { name: 'Acme Cyber Labs', verified_domain: 'acmecyber.example', created_by: officer.id } });
  const orion = await prisma.company.create({ data: { name: 'Orion Defence Systems', verified_domain: 'oriondefence.example', created_by: officer.id } });
  const helix = await prisma.company.create({ data: { name: 'Helix Forensics', verified_domain: 'helixforensics.example', created_by: officer.id } });
  const zeta = await prisma.company.create({ data: { name: 'Zeta Systems', verified_domain: 'zetasystems.example', created_by: officer.id } });
  const hr = await user('hr_acme', 'hr@acmecyber.example', 'Nandini Rao (HR, Acme Cyber Labs)', 'hr');
  await prisma.hr_user.create({ data: { user_id: hr.id, company_id: acme.id, valid_until: new Date(Date.now() + 60 * 86_400_000) } });

  // ---- drives ----
  const cat = (ctc: number) => catToDb(categoryFor(ctc, params.thresholds));
  const mk = (company_id: string, title: string, offer_type: 'I' | 'F' | 'IF', ctc: number | null, stipend: number | null, status: 'draft' | 'open' | 'closed', criteria: object = {}) =>
    prisma.drive.create({
      data: { company_id, title, offer_type, ctc_lpa: ctc, stipend_amount: stipend, stipend_period: stipend ? 'monthly' : null, category: ctc == null ? null : cat(ctc), criteria_json: criteria as Prisma.InputJsonValue, status, created_by: officer.id, opened_at: status === 'draft' ? null : new Date(), acceptance_deadline: new Date(Date.now() + 72 * 3600_000) },
    });
  const dAplus = await mk(acme.id, 'Security Engineer (A+ drive)', 'F', 18, null, 'open', { min_cgpa: 7.5, max_backlogs: 0 });
  const dA = await mk(orion.id, 'SOC Analyst (A drive)', 'F', 12, null, 'open', { min_cgpa: 7 });
  const dB = await mk(helix.id, 'Forensics Associate (B drive)', 'F', 8, null, 'open', {});
  const dI = await mk(zeta.id, 'Summer Security Internship', 'I', null, 40000, 'open', {});
  await mk(zeta.id, 'Cloud Security PPO Internship (draft)', 'IF', 10, 50000, 'draft', {});
  const dPast = await mk(orion.id, 'Orion Pre-placement Talk (past)', 'F', 9, null, 'closed', {});

  // ---- students ----
  type S = { key: string; pid: string; name: string; programme: string; batch: number; cgpa: number; backlogs: number; reg?: 'registered' | 'not_registered'; elig?: 'eligible' | 'ineligible' | 'pending' };
  const roster: S[] = [
    { key: 'aarav', pid: 'NFSU26-MCS-001', name: 'Aarav Mehta', programme: 'MTECH-CS', batch: 2026, cgpa: 8.6, backlogs: 0 },
    { key: 'diya', pid: 'NFSU26-MCS-002', name: 'Diya Nair', programme: 'MTECH-CS', batch: 2026, cgpa: 8.1, backlogs: 0 },
    { key: 'kabir', pid: 'NFSU26-MCS-003', name: 'Kabir Shah', programme: 'MTECH-CS', batch: 2026, cgpa: 9.1, backlogs: 0 },
    { key: 'neel', pid: 'NFSU26-MCS-004', name: 'Neel Patel', programme: 'MTECH-CS', batch: 2026, cgpa: 7.4, backlogs: 0, reg: 'not_registered' },
    { key: 'isha', pid: 'NFSU26-AIDS-001', name: 'Isha Verma', programme: 'MTECH-AIDS', batch: 2026, cgpa: 8.8, backlogs: 0 },
    { key: 'rohan', pid: 'NFSU26-AIDS-002', name: 'Rohan Das', programme: 'MTECH-AIDS', batch: 2026, cgpa: 7.2, backlogs: 1 },
    { key: 'arjun', pid: 'NFSU26-BMC-001', name: 'Arjun Rao', programme: 'BTECH-MTECH-CS', batch: 2027, cgpa: 6.1, backlogs: 4, elig: 'ineligible' },
    { key: 'tara', pid: 'NFSU26-BMC-002', name: 'Tara Joshi', programme: 'BTECH-MTECH-CS', batch: 2027, cgpa: 8.3, backlogs: 0 },
    { key: 'meera', pid: 'NFSU26-MSC-001', name: 'Meera Iyer', programme: 'MSC-CS', batch: 2026, cgpa: 8.0, backlogs: 0 },
    { key: 'vikram', pid: 'NFSU26-DFIS-001', name: 'Vikram Singh', programme: 'MSC-DFIS', batch: 2026, cgpa: 7.9, backlogs: 0 },
    { key: 'anaya', pid: 'NFSU26-DFIS-002', name: 'Anaya Gupta', programme: 'MSC-DFIS', batch: 2026, cgpa: 8.4, backlogs: 0, elig: 'pending' },
    { key: 'sara', pid: 'NFSU26-DFIS-003', name: 'Sara Khan', programme: 'MSC-DFIS', batch: 2026, cgpa: 8.7, backlogs: 0 },
  ];
  const stu: Record<string, { id: string }> = {};
  let i = 0;
  for (const r of roster) {
    i++;
    const email = `${r.key}@nfsu.ac.in`;
    const u = await user(`student_${r.key}`, email, r.name, 'student');
    const m = mobile(i);
    stu[r.key] = await prisma.student.create({
      data: { placement_id: r.pid, user_id: u.id, name: r.name, email, mobile_enc: crypto.encrypt(m, MOBILE_AAD), mobile_hash: crypto.hmac(m, 'mobile'), programme_id: prog[r.programme], batch: r.batch, cgpa: r.cgpa, backlogs: r.backlogs, registration_status: r.reg ?? 'registered', eligibility_status: r.elig ?? 'eligible', created_by: officer.id },
    });
  }

  // ---- offers (every one is an event, never an overwrite) ----
  async function offer(key: string, o: { drive?: string; offCampus?: string; type: 'I' | 'F' | 'IF'; ctc?: number; stipend?: number; status: 'pending' | 'accepted'; hoursLeft?: number; noc?: 'not_required' | 'pending' | 'received' }) {
    const issued = new Date(Date.now() - 2 * 3600_000);
    const deadline = o.status === 'pending' ? new Date(Date.now() + (o.hoursLeft ?? 20) * 3600_000) : computeDeadline(issued, null, params.acceptance.hours);
    const row = await prisma.offer.create({
      data: {
        student_id: stu[key].id, drive_id: o.drive ?? null, off_campus_company: o.offCampus ?? null, type: o.type, category: o.ctc == null ? null : cat(o.ctc),
        ctc_enc: crypto.encryptNumber(o.ctc ?? null, CTC_AAD), stipend_enc: crypto.encryptNumber(o.stipend ?? null, STIPEND_AAD), offer_date: issued, deadline, acceptance_status: o.status,
        noc_status: o.noc ?? 'not_required', policy_version: version, created_by: officer.id,
      },
    });
    await prisma.offer_event.createMany({ data: [{ offer_id: row.id, field: 'created', old_value: null, new_value: 'pending', actor_id: officer.id }, ...(o.status === 'accepted' ? [{ offer_id: row.id, field: 'acceptance_status', old_value: 'pending', new_value: 'accepted', actor_id: null }] : [])] });
  }
  await offer('diya', { drive: dB.id, type: 'F', ctc: 8, status: 'accepted' }); // category B: next drive must pay >= 12 LPA
  await offer('kabir', { drive: dAplus.id, type: 'F', ctc: 18, status: 'accepted' }); // A+: out of the process
  await offer('isha', { drive: dI.id, type: 'I', stipend: 30000, status: 'accepted' }); // internship: may still apply to FTE
  await offer('rohan', { offCampus: 'Quantum Secure Pvt Ltd', type: 'F', ctc: 4.5, status: 'accepted', noc: 'pending' }); // category C + a missing NOC
  await offer('tara', { drive: dA.id, type: 'IF', ctc: 7, stipend: 25000, status: 'accepted' }); // I+F: blocked everywhere
  await offer('meera', { drive: dB.id, type: 'F', ctc: 8, status: 'pending', hoursLeft: 20 }); // pending inside the window: REVIEW

  // ---- attendance: Vikram missed the last drive with no exception ----
  for (const k of ['aarav', 'sara', 'vikram']) {
    await prisma.attendance.create({ data: { student_id: stu[k].id, drive_id: dPast.id, event: 'PPT', present: k !== 'vikram', recorded_by: coord2.id } });
  }
  await prisma.review_case.create({ data: { kind: 'absenteeism', student_id: stu.vikram.id, programme_id: prog['MSC-DFIS'], ref_id: dPast.id, payload: { summary: 'Vikram Singh was absent at the PPT for "Orion Pre-placement Talk (past)" without an exception', event: 'PPT', drive_id: dPast.id } } });

  // ---- a few applications for the HR pipeline demo ----
  for (const [k, stage] of [['aarav', 'shortlisted'], ['sara', 'applied'], ['isha', 'selected']] as const) {
    await prisma.application.create({ data: { student_id: stu[k].id, drive_id: dAplus.id, stage } });
  }

  await engine.recomputeAll();

  writeFileSync(resolve(process.cwd(), '.dev-accounts.json'), JSON.stringify({ note: 'Generated demo credentials. Never commit. Regenerated by `npm run db:reset && npm run db:seed`.', accounts }, null, 2), { mode: 0o600 });
  console.log(`Seeded ${Object.keys(accounts).length} demo accounts. Credentials: backend/.dev-accounts.json (git-ignored)`);
  await app.close();
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
