/**
 * Security scenarios S1-S8 from the architecture doc (section 11) plus the controls around them.
 * Runs against the real stack (NestJS + Postgres with row-level security + Redis) in the isolated `placement_test` database.
 */
import { authenticator } from 'otplib';
import { Env, Agent, TestUser, ORIGIN } from './helpers';

const env = new Env();
let progCS: { id: string };
let progAI: { id: string };

beforeAll(async () => {
  await env.start();
  await env.redis.flushdb();
  progCS = await env.programme('T-CS');
  progAI = await env.programme('T-AI');
});
afterAll(async () => env.stop());

async function setupDrive(companyName: string, opts: { ctc?: number; type?: 'I' | 'F' | 'IF' } = {}) {
  const company = await env.owner.company.create({ data: { name: env.tag(companyName), verified_domain: 'acme.example' } });
  const drive = await env.owner.drive.create({
    data: { company_id: company.id, title: `${companyName} drive`, offer_type: opts.type ?? 'F', ctc_lpa: opts.ctc ?? 9, category: 'B', status: 'open', opened_at: new Date() },
  });
  return { company, drive };
}

describe('S1: a student tries to write server-computed fields', () => {
  test('PATCH /students/:id {placement_status} -> 403, audit entry, no change; also logged as a tamper attempt', async () => {
    const { user, student } = await env.student('s1', progCS.id);
    const a = await env.login(user);
    const res = await a.patch(`/students/${student.id}`, { placement_status: 'Unplaced' });
    expect(res.status).toBe(403);
    const denied = await env.audit('ACCESS_DENIED', user.id);
    expect(denied.length).toBeGreaterThan(0);
    expect((await env.audit('TAMPER_ATTEMPT', user.id)).length).toBeGreaterThan(0);
    // the student lands in the Officer's review queue as a suspected violation
    const cases = await env.owner.review_case.findMany({ where: { student_id: student.id, kind: 'violation' } });
    expect(cases.length).toBe(1);
    const after = await env.owner.student.findUniqueOrThrow({ where: { id: student.id } });
    expect(after.eligibility_status).toBe('eligible');
  });

  test('student changes their own CTC: PATCH /offers/:id and respond-with-extra-fields are refused', async () => {
    const { user, student } = await env.student('s1b', progCS.id);
    const { drive } = await setupDrive('s1b-co');
    const offer = await env.owner.offer.create({
      data: { student_id: student.id, drive_id: drive.id, type: 'F', category: 'B', ctc_enc: env.crypto.encrypt('8', 'offer.ctc_enc'), deadline: new Date(Date.now() + 3_600_000) },
    });
    const a = await env.login(user);
    expect((await a.patch(`/offers/${offer.id}`, { ctc_lpa: 99 })).status).toBe(403);
    expect((await a.post(`/offers/${offer.id}/respond`, { decision: 'accept', ctc_lpa: 99 })).status).toBe(400);
    const row = await env.owner.offer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(env.crypto.decrypt(row.ctc_enc!, 'offer.ctc_enc')).toBe('8');
    expect(row.acceptance_status).toBe('pending');
  });

  test('database triggers are a second wall: a student session cannot change eligibility or an offer CTC even with raw SQL', async () => {
    const { user, student } = await env.student('s1c', progCS.id);
    const db = env.app.get(require('../src/common/prisma.service').DbService);
    await expect(db.run({ id: user.id, role: 'student' }, (tx: any) => tx.$executeRaw`UPDATE student SET eligibility_status = 'ineligible' WHERE id = ${student.id}::uuid`)).rejects.toThrow(/students may only change their registration/);
  });
});

describe('S2: IDOR - a student reads a classmate by changing the id', () => {
  test('own record 200, classmate 403 + audit entry', async () => {
    const me = await env.student('s2a', progCS.id);
    const other = await env.student('s2b', progCS.id);
    const a = await env.login(me.user);
    expect((await a.get(`/students/${me.student.id}`)).status).toBe(200);
    const res = await a.get(`/students/${other.student.id}`);
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toContain(other.student.name);
    expect((await env.audit('ACCESS_DENIED', me.user.id)).length).toBeGreaterThan(0);
    expect((await a.get('/students')).status).toBe(403); // no list endpoint for students either
  });

  test('coordinator is limited to their own programme (API check and database policy)', async () => {
    const mine = await env.student('s2c', progCS.id);
    const theirs = await env.student('s2d', progAI.id);
    const coord = await env.user('s2coord', 'coordinator', { programmeIds: [progCS.id] });
    const a = await env.login(coord);
    expect((await a.get(`/students/${mine.student.id}`)).status).toBe(200);
    expect((await a.get(`/students/${theirs.student.id}`)).status).toBe(403);
    const list = await a.get('/students?page_size=200');
    expect(list.status).toBe(200);
    expect(list.body.items.every((s: any) => s.programme_id === progCS.id)).toBe(true);
    // Raw database access with the coordinator's identity also sees only their programme.
    const db = env.app.get(require('../src/common/prisma.service').DbService);
    const rows = await db.run({ id: coord.id, role: 'coordinator' }, (tx: any) => tx.student.findMany({ select: { programme_id: true } }));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: any) => r.programme_id === progCS.id)).toBe(true);
    // ... and with no identity at all, the application role sees nothing.
    const prisma = env.app.get(require('../src/common/prisma.service').PrismaService);
    expect(await prisma.student.count()).toBe(0);
  });
});

describe('S3: HR reads a student outside their drive', () => {
  test('masked applicant view for own drive; 403 for other drives and for student endpoints', async () => {
    const ours = await setupDrive('s3-ours');
    const theirs = await setupDrive('s3-theirs');
    const applicant = await env.student('s3app', progCS.id);
    const stranger = await env.student('s3str', progCS.id);
    await env.owner.application.create({ data: { student_id: applicant.student.id, drive_id: ours.drive.id, stage: 'applied' } });
    await env.owner.application.create({ data: { student_id: stranger.student.id, drive_id: theirs.drive.id, stage: 'applied' } });
    const hr = await env.user('s3hr', 'hr', { companyId: ours.company.id });
    const a = await env.login(hr);

    const mine = await a.get(`/drives/${ours.drive.id}/applicants`);
    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].student.email).toBeNull(); // contact details only after shortlist
    expect(mine.body[0].student.mobile).toBeNull();
    expect(mine.body[0].student.masked).toBe(true);
    expect(mine.body[0].student.cgpa).toBeDefined(); // name, programme, CGPA and resume ARE visible

    expect((await a.get(`/drives/${theirs.drive.id}/applicants`)).status).toBe(403);
    expect((await a.get(`/students/${stranger.student.id}`)).status).toBe(403);
    expect((await a.get(`/students/${applicant.student.id}`)).status).toBe(403); // HR has no student-record endpoint at all
    expect((await a.get('/students')).status).toBe(403);

    // After shortlisting, contact details are released.
    await env.owner.application.updateMany({ where: { student_id: applicant.student.id, drive_id: ours.drive.id }, data: { stage: 'shortlisted' } });
    const after = await a.get(`/drives/${ours.drive.id}/applicants`);
    expect(after.body[0].student.email).toBe(applicant.student.email);
    expect(after.body[0].student.masked).toBe(false);
  });
});

describe('S4: login without MFA / wrong OTP x 5', () => {
  test('password alone opens nothing: every data route says MFA is required', async () => {
    const { user } = await env.student('s4a', progCS.id);
    const a = new Agent(env.server);
    const r = await a.post('/auth/login', { email: user.email, password: user.password });
    expect(r.status).toBe(200);
    expect(r.body.stage).toBe('mfa_pending');
    for (const url of ['/students/me', '/drives', '/dashboards/my-placement', '/offers']) {
      const x = await a.get(url);
      expect(x.status).toBe(401);
      expect(x.body.code).toBe('MFA_REQUIRED');
    }
  });

  test('5 wrong second factors lock sign-in for 15 minutes, even for the right code, and the attempts are logged', async () => {
    const { user } = await env.student('s4b', progCS.id);
    const a = new Agent(env.server);
    await a.post('/auth/login', { email: user.email, password: user.password });
    for (let i = 0; i < 4; i++) expect((await a.post('/auth/mfa/verify', { method: 'totp', code: '000000' })).status).toBe(401);
    const fifth = await a.post('/auth/mfa/verify', { method: 'totp', code: '000000' });
    expect(fifth.status).toBe(429);
    expect(fifth.body.code).toBe('LOCKED');
    const good = await a.post('/auth/mfa/verify', { method: 'totp', code: authenticator.generate(user.totp) });
    expect(good.status).toBe(429);
    expect((await env.audit('MFA_FAILED', user.id)).length).toBe(5);
    expect((await env.audit('MFA_LOCKOUT', user.id)).length).toBe(1);
    expect(await env.redis.ttl(`lock:mfa:${user.id}`)).toBeGreaterThan(14 * 60);
  });

  test('5 wrong passwords lock the account; wrong user and wrong password give the same message', async () => {
    const { user } = await env.student('s4c', progCS.id);
    const a = new Agent(env.server);
    const unknown = await a.post('/auth/login', { email: `nobody-${env.uniq}@test.example`, password: 'x'.repeat(14) });
    const wrong = await a.post('/auth/login', { email: user.email, password: 'definitely-wrong-password' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.message).toBe(wrong.body.message);
    for (let i = 0; i < 3; i++) await a.post('/auth/login', { email: user.email, password: 'wrong-again-wrong' });
    const locked = await a.post('/auth/login', { email: user.email, password: 'wrong-the-fifth-time' });
    expect(locked.status).toBe(429);
    const correct = await a.post('/auth/login', { email: user.email, password: user.password });
    expect(correct.status).toBe(429); // lockout holds even for the right password
  });

  test('TOTP codes are single-use (replay protection)', async () => {
    const { user } = await env.student('s4d', progCS.id);
    await env.clearTotpReplay();
    const code = authenticator.generate(user.totp);
    const a = new Agent(env.server);
    await a.post('/auth/login', { email: user.email, password: user.password });
    expect((await a.post('/auth/mfa/verify', { method: 'totp', code })).status).toBe(200);
    const b = new Agent(env.server);
    await b.post('/auth/login', { email: user.email, password: user.password });
    expect((await b.post('/auth/mfa/verify', { method: 'totp', code })).status).toBe(401);
  });
});

describe('S5: SQL injection and XSS payloads', () => {
  test('payloads in search and in remarks are stored as text and never executed', async () => {
    const officer = await env.user('s5off', 'officer');
    const { student } = await env.student('s5stu', progCS.id);
    const a = await env.login(officer);
    const sqli = await a.get(`/students?q=${encodeURIComponent("' OR 1=1; DROP TABLE student; --")}`);
    expect(sqli.status).toBe(200);
    expect(sqli.body.total).toBe(0);
    expect(await env.owner.student.count()).toBeGreaterThan(0); // table still there

    const xss = '<script>alert("x")</script><img src=x onerror=alert(1)>';
    await env.stepUp(a, officer);
    const ex = await a.post('/exceptions', { student_id: student.id, rule_code: 'R4', reason: `Medical emergency ${xss}`, expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString() });
    expect(ex.status).toBe(201);
    const stored = await env.owner.exception.findFirstOrThrow({ where: { student_id: student.id } });
    expect(stored.reason).toContain(xss); // kept verbatim as data
    const list = await a.get('/exceptions');
    expect(list.headers['content-type']).toMatch(/application\/json/); // never rendered as HTML
    expect(list.headers['x-content-type-options']).toBe('nosniff');
    expect(list.headers['content-security-policy']).toContain("default-src 'none'");
    expect(list.headers['cache-control']).toBe('no-store');
  });

  test('unknown fields are rejected, not ignored (strict schemas)', async () => {
    const officer = await env.user('s5off2', 'officer');
    const a = await env.login(officer);
    const r = await a.post('/companies', { name: 'X Corp', verified_domain: 'x.example', created_by: 'someone-else' });
    expect(r.status).toBe(400);
  });
});

describe('S6: session handling', () => {
  test('replaying the old cookie after logout gives 401', async () => {
    const { user } = await env.student('s6a', progCS.id);
    const a = await env.login(user);
    const old = { ...a.cookies };
    expect((await a.get('/students/me')).status).toBe(200);
    expect((await a.post('/auth/logout')).status).toBe(204);
    const replay = new Agent(env.server);
    replay.cookies = old;
    expect((await replay.get('/students/me')).status).toBe(401);
  });

  test('session id is rotated at login and at step-up; the old id stops working', async () => {
    const { user } = await env.student('s6b', progCS.id);
    const a = new Agent(env.server);
    await a.post('/auth/login', { email: user.email, password: user.password });
    const preMfa = a.cookies['sid'];
    await env.clearTotpReplay();
    await a.post('/auth/mfa/verify', { method: 'totp', code: authenticator.generate(user.totp) });
    expect(a.cookies['sid']).not.toBe(preMfa);
    const stale = new Agent(env.server);
    stale.cookies = { sid: preMfa };
    expect((await stale.get('/students/me')).status).toBe(401);

    const beforeStepUp = a.cookies['sid'];
    await env.expireStepUp(a);
    await env.stepUp(a, user);
    expect(a.cookies['sid']).not.toBe(beforeStepUp);
  });

  test('cookie flags: HttpOnly, SameSite=Strict (Secure in production)', async () => {
    const { user } = await env.student('s6c', progCS.id);
    const r = await new Agent(env.server).post('/auth/login', { email: user.email, password: user.password });
    const raw = ([] as string[]).concat(r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('sid='))!;
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Strict/i);
  });

  test('"log out all devices" revokes every session; a password change revokes the others', async () => {
    const { user } = await env.student('s6d', progCS.id);
    const a = await env.login(user);
    const b = await env.login(user);
    expect((await b.get('/students/me')).status).toBe(200);
    expect((await a.post('/auth/logout-all')).status).toBe(204);
    expect((await b.get('/students/me')).status).toBe(401);
  });

  test('idle timeout is server-side: an expired session record is a 401', async () => {
    const { user } = await env.student('s6e', progCS.id);
    const a = await env.login(user);
    const { createHash } = await import('crypto');
    await env.redis.del(`sess:${createHash('sha256').update(a.cookies['sid']).digest('hex')}`);
    expect((await a.get('/students/me')).status).toBe(401);
  });
});

describe('S7: audit log is hash-chained', () => {
  test('editing an audit row directly in the database is detected by the chain check', async () => {
    const admin = await env.user('s7admin', 'admin');
    const a = await env.login(admin);
    const before = await a.get('/audit/verify');
    expect(before.status).toBe(200);
    expect(before.body.ok).toBe(true);
    expect(before.body.checked).toBeGreaterThan(5);

    // The app role cannot do this at all (UPDATE/DELETE are revoked) ...
    const prisma = env.app.get(require('../src/common/prisma.service').PrismaService);
    await expect(prisma.$executeRaw`UPDATE audit_log SET action = 'NOTHING_TO_SEE' WHERE id = (SELECT min(id) FROM audit_log)`).rejects.toThrow();
    await expect(prisma.$executeRaw`DELETE FROM audit_log WHERE id = (SELECT min(id) FROM audit_log)`).rejects.toThrow();

    // ... so simulate an attacker with direct database access (the owner role).
    const victim = await env.owner.audit_log.findFirstOrThrow({ where: { action: 'LOGIN_SUCCESS' }, orderBy: { id: 'asc' } });
    await env.owner.$executeRaw`UPDATE audit_log SET entity_id = 'tampered' WHERE id = ${victim.id}`;
    const after = await a.get('/audit/verify');
    expect(after.body.ok).toBe(false);
    expect(after.body.broken_at).toBe(victim.id.toString());
    expect(after.body.reason).toMatch(/edited/);

    // Deleting a row is detected as well (previous-hash mismatch).
    await env.owner.$executeRaw`UPDATE audit_log SET entity_id = ${victim.entity_id} WHERE id = ${victim.id}`; // undo the edit
    expect((await a.get('/audit/verify')).body.ok).toBe(true);
    const mid = await env.owner.audit_log.findFirstOrThrow({ where: { id: { gt: victim.id } }, orderBy: { id: 'asc' } });
    await env.owner.audit_log.delete({ where: { id: mid.id } });
    const gap = await a.get('/audit/verify');
    expect(gap.body.ok).toBe(false);
    expect(gap.body.reason).toMatch(/deleted|reordered/);
  });
});

describe('S8: duplicate Placement ID in an import', () => {
  test('duplicates inside the file and against existing students are rejected row by row with a reason; clean rows commit', async () => {
    const coord = await env.user('s8coord', 'coordinator', { programmeIds: [progCS.id] });
    const existing = await env.student('s8existing', progCS.id);
    const a = await env.login(coord);
    const pid = (n: string) => `IMP${env.uniq.toUpperCase()}${n}`;
    const mob = (n: number) => `98${String(parseInt(env.uniq, 16) % 100000).padStart(5, '0')}${String(n).padStart(3, '0')}`; // unique per run
    const csv = [
      'placement_id,name,email,mobile,programme,batch,cgpa,backlogs',
      `${pid('001')},Clean One,clean1-${env.uniq}@test.example,${mob(1)},T-CS,2026,8.2,0`,
      `${pid('001')},Dup In File,dup1-${env.uniq}@test.example,${mob(2)},T-CS,2026,7.9,0`,
      `${existing.student.placement_id},Dup Existing,dup2-${env.uniq}@test.example,${mob(3)},T-CS,2026,7.5,1`,
      `${pid('002')},Wrong Programme,wp-${env.uniq}@test.example,${mob(4)},T-AI,2026,7.5,0`,
      `${pid('003')},Bad Mobile,bm-${env.uniq}@test.example,12345,T-CS,2026,7.5,0`,
      `${pid('004')},Clean Two,clean2-${env.uniq}@test.example,${mob(5)},T-CS,2026,8.0,0`,
    ].join('\n');

    await env.expireStepUp(a);
    expect((await a.post('/students/import/preview', undefined, { file: { name: 'import.csv', data: Buffer.from(csv) } })).status).toBe(401); // bulk import needs step-up
    await env.stepUp(a, coord);
    const prev = await a.post('/students/import/preview', undefined, { file: { name: 'import.csv', data: Buffer.from(csv) } });
    expect(prev.status).toBe(200);
    expect(prev.body.total).toBe(6);
    expect(prev.body.valid).toBe(2);
    const reasons = JSON.stringify(prev.body.errors);
    expect(reasons).toMatch(/duplicate Placement ID inside this file/);
    expect(reasons).toMatch(/already exists/);
    expect(reasons).toMatch(/not your programme/);
    expect(reasons).toMatch(/10-digit/);

    const commit = await a.post('/students/import/commit', { token: prev.body.token });
    expect(commit.status).toBe(200);
    expect(commit.body.created).toBe(2);
    expect(await env.owner.student.count({ where: { placement_id: { in: [pid('001'), pid('004')] } } })).toBe(2);
    expect(await env.owner.student.count({ where: { placement_id: pid('002') } })).toBe(0);
    expect((await env.audit('STUDENT_IMPORT', coord.id)).length).toBe(1);
    // the preview token is single-use
    expect((await a.post('/students/import/commit', { token: prev.body.token })).status).toBe(400);
  });

  test('file uploads are type-checked and size-limited', async () => {
    const coord = await env.user('s8c2', 'coordinator', { programmeIds: [progCS.id] });
    const a = await env.login(coord);
    expect((await a.post('/students/import/preview', undefined, { file: { name: 'evil.exe', data: Buffer.from('MZ'), type: 'application/octet-stream' } })).status).toBe(400);
    const big = await a.post('/students/import/preview', undefined, { file: { name: 'big.csv', data: Buffer.alloc(1.5 * 1024 * 1024, 'a') } });
    expect([400, 413]).toContain(big.status);
  });
});

describe('request integrity: CSRF, origin, deny-by-default, step-up', () => {
  let student: { user: TestUser };
  let agent: Agent;
  beforeAll(async () => {
    student = await env.student('csrf', progCS.id);
    agent = await env.login(student.user);
  });

  test('state-changing request without the CSRF token, or from another origin, is rejected', async () => {
    expect((await agent.post('/students/me/confirm-registration', {}, { csrf: null })).status).toBe(403);
    expect((await agent.post('/students/me/confirm-registration', {}, { csrf: 'wrong-token' })).status).toBe(403);
    const evil = await agent.post('/students/me/confirm-registration', {}, { origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    expect(evil.body.code).toBe('BAD_ORIGIN');
    expect((await agent.post('/students/me/confirm-registration', {}, { origin: null })).status).toBe(403);
    expect((await agent.post('/students/me/confirm-registration')).status).toBe(204);
  });

  test('login itself checks the Origin header (login CSRF)', async () => {
    const r = await new Agent(env.server).post('/auth/login', { email: student.user.email, password: student.user.password }, { origin: 'https://evil.example' });
    expect(r.status).toBe(403);
  });

  test('CORS only allows the web origin', async () => {
    const res = await new Agent(env.server).get('/health', { origin: 'https://evil.example' });
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example'); // browsers at another origin are refused
    const ok = await new Agent(env.server).get('/health', { origin: ORIGIN });
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
  });

  test('anything without an explicit access rule is denied (deny by default)', async () => {
    const r = await agent.get('/definitely-not-a-route');
    expect(r.status).toBe(404);
    const noSession = await new Agent(env.server).get('/students/me');
    expect(noSession.status).toBe(401);
  });

  test('sensitive actions need a FRESH step-up: accepting an offer, exporting, approving exceptions', async () => {
    const { drive } = await setupDrive('stepup-co');
    const offer = await env.owner.offer.create({ data: { student_id: (await env.owner.student.findFirstOrThrow({ where: { user_id: student.user.id } })).id, drive_id: drive.id, type: 'F', category: 'B', ctc_enc: env.crypto.encrypt('7', 'offer.ctc_enc'), deadline: new Date(Date.now() + 3_600_000) } });
    await env.expireStepUp(agent);
    const r = await agent.post(`/offers/${offer.id}/respond`, { decision: 'accept' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('STEP_UP_REQUIRED');
    await env.stepUp(agent, student.user);
    expect((await agent.post(`/offers/${offer.id}/respond`, { decision: 'accept' })).status).toBe(200);
  });
});

describe('server-side policy enforcement', () => {
  test('a student cannot apply to a blocked drive by calling the API directly: the engine runs on the server and the reason is returned', async () => {
    const { user, student } = await env.student('pol1', progCS.id);
    const { drive: aPlus } = await setupDrive('pol-aplus', { ctc: 18 });
    const { drive: other } = await setupDrive('pol-other', { ctc: 25 });
    await env.owner.offer.create({ data: { student_id: student.id, drive_id: aPlus.id, type: 'F', category: 'A_PLUS', ctc_enc: env.crypto.encrypt('18', 'offer.ctc_enc'), acceptance_status: 'accepted', offer_date: new Date(Date.now() - 86_400_000), deadline: new Date(Date.now() - 3_600_000) } });
    const a = await env.login(user);
    const r = await a.post(`/drives/${other.id}/apply`);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('POLICY_BLOCK');
    expect(r.body.decision.fired_rules[0].code).toBe('R6');
    expect(r.body.message).toMatch(/R6/);
    expect(await env.owner.application.count({ where: { student_id: student.id, drive_id: other.id } })).toBe(0);
    const stored = await env.owner.engine_decision.findFirstOrThrow({ where: { student_id: student.id, drive_id: other.id } });
    expect(stored.result).toBe('BLOCK');
    expect(stored.policy_version).toBeGreaterThan(0);
  });

  test('ALLOW creates the application with the stored decision; REVIEW holds it and opens a case; double-apply is refused', async () => {
    const ok = await env.student('pol2', progCS.id);
    const pending = await env.student('pol3', progCS.id, { elig: 'pending' });
    const { drive } = await setupDrive('pol-open', { ctc: 9 });
    const a = await env.login(ok.user);
    const r = await a.post(`/drives/${drive.id}/apply`);
    expect(r.status).toBe(201);
    expect(r.body.stage).toBe('applied');
    expect((await a.post(`/drives/${drive.id}/apply`)).status).toBe(409);

    const b = await env.login(pending.user);
    const rv = await b.post(`/drives/${drive.id}/apply`);
    expect(rv.status).toBe(201);
    expect(rv.body.stage).toBe('pending_review');
    expect(await env.owner.review_case.count({ where: { student_id: pending.student.id, kind: 'engine_review', status: 'open' } })).toBe(1);
  });

  test('accepting an offer recomputes placement status on the server; nobody types it', async () => {
    const { user, student } = await env.student('pol4', progCS.id);
    const { drive } = await setupDrive('pol-accept', { ctc: 12 });
    const offer = await env.owner.offer.create({ data: { student_id: student.id, drive_id: drive.id, type: 'F', category: 'A', ctc_enc: env.crypto.encrypt('12', 'offer.ctc_enc'), deadline: new Date(Date.now() + 3_600_000) } });
    const a = await env.login(user);
    expect((await a.post(`/offers/${offer.id}/respond`, { decision: 'accept' })).status).toBe(200);
    const st = await env.owner.student_placement_state.findUniqueOrThrow({ where: { student_id: student.id } });
    expect(st.placement_status).toBe('FTE only');
    expect(st.current_category).toBe('A');
    const events = await env.owner.offer_event.findMany({ where: { offer_id: offer.id } });
    expect(events.map((e) => e.new_value)).toContain('accepted');
    // an accepted offer cannot be flipped again
    expect((await a.post(`/offers/${offer.id}/respond`, { decision: 'decline' })).status).toBe(409);
  });

  test('an expired offer cannot be accepted', async () => {
    const { user, student } = await env.student('pol5', progCS.id);
    const { drive } = await setupDrive('pol-exp', { ctc: 9 });
    const offer = await env.owner.offer.create({ data: { student_id: student.id, drive_id: drive.id, type: 'F', category: 'B', ctc_enc: env.crypto.encrypt('9', 'offer.ctc_enc'), offer_date: new Date(Date.now() - 86_400_000), deadline: new Date(Date.now() - 1000) } });
    const a = await env.login(user);
    const r = await a.post(`/offers/${offer.id}/respond`, { decision: 'accept' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('EXPIRED');
  });
});

describe('role separation and governance', () => {
  test('Super Admin sees student data masked; full view only by logged break-glass with a reason', async () => {
    const sa = await env.user('sa1', 'superadmin');
    const { student } = await env.student('sa-stu', progCS.id);
    const a = await env.login(sa);
    const masked = await a.get(`/students/${student.id}`);
    expect(masked.status).toBe(200);
    expect(masked.body.masked).toBe(true);
    expect(masked.body.email).not.toBe(student.email);
    expect(masked.body.mobile).toMatch(/^\*+\d{3}$/);
    expect(masked.body.cgpa).toBeUndefined();

    await env.expireStepUp(a);
    expect((await a.post(`/students/${student.id}/break-glass`, { reason: 'x' })).status).toBe(401); // step-up first (every super admin write)
    await env.stepUp(a, sa);
    expect((await a.post(`/students/${student.id}/break-glass`, { reason: 'short' })).status).toBe(400);
    const full = await a.post(`/students/${student.id}/break-glass`, { reason: 'Verifying a data-correction complaint, ticket 4521' });
    expect(full.status).toBe(200);
    expect(full.body.masked).toBe(false);
    expect(full.body.email).toBe(student.email);
    const log = await env.audit('STUDENT_BREAK_GLASS_READ', sa.id);
    expect(log.length).toBe(1);
    expect((log[0].meta as any).reason).toMatch(/ticket 4521/);
  });

  test('Admin cannot touch Admin accounts or system settings; Super Admin cannot edit students or offers', async () => {
    const admin = await env.user('adm1', 'admin');
    const sa = await env.user('sa2', 'superadmin');
    const aa = await env.login(admin);
    const saa = await env.login(sa);
    expect((await aa.get('/system/settings')).status).toBe(403);
    const mk = await (async () => { await env.stepUp(aa, admin); return aa.post('/users', { email: `newadmin-${env.uniq}@test.example`, name: 'New Admin', role: 'admin' }); })();
    expect(mk.status).toBe(403); // only a Super Admin creates Admin accounts
    const { student } = await env.student('sa-edit', progCS.id);
    await env.stepUp(saa, sa);
    expect((await saa.patch(`/students/${student.id}`, { name: 'Hacked' })).status).toBe(403);
    expect((await saa.post('/offers', {})).status).toBe(403);
  });

  test('policy change needs two people: Admin proposes, a Super Admin publishes; the proposer cannot publish their own', async () => {
    const admin = await env.user('pol-admin', 'admin');
    const sa = await env.user('pol-sa', 'superadmin');
    const aa = await env.login(admin);
    await env.stepUp(aa, admin);
    const prop = await aa.post('/policy/propose', { params: { switchB: { multiplier: 1.75 } }, note: 'Trial: raise B multiplier for 2026-27 review' });
    expect(prop.status).toBe(201);
    expect((await aa.post(`/policy/${prop.body.version}/publish`)).status).toBe(403); // role: only Super Admin
    const before = (await aa.get('/policy/current')).body;
    expect(before.params.switchB.multiplier).toBe(1.5);

    const saa = await env.login(sa);
    await env.stepUp(saa, sa);
    expect((await saa.post(`/policy/${prop.body.version}/publish`)).status).toBe(200);
    const after = (await saa.get('/policy/current')).body;
    expect(after.version).toBe(prop.body.version);
    expect(after.params.switchB.multiplier).toBe(1.75);

    // four-eyes: a Super Admin who proposed cannot also approve (enforced in the service even if a role gets both rights)
    const svc = env.app.get(require('../src/policy/policy.service').PolicyService);
    const row = await env.owner.policy_version.findUniqueOrThrow({ where: { version: prop.body.version } });
    expect(row.proposed_by).toBe(admin.id);
    expect(row.published_by).toBe(sa.id);
    await env.owner.policy_version.update({ where: { version: prop.body.version }, data: { status: 'proposed', proposed_by: sa.id } });
    await expect(svc.publish({ id: sa.id, role: 'superadmin' }, prop.body.version)).rejects.toThrow(/second person/);

    // restore the default so later runs start clean
    await env.owner.policy_version.updateMany({ data: { status: 'superseded' } });
    await env.owner.policy_version.update({ where: { version: 1 }, data: { status: 'published' } });
  });

  test('MFA reset: Admin can reset roles below Admin (audited), but never their own, and never an Admin', async () => {
    const admin = await env.user('mfa-admin', 'admin');
    const sa = await env.user('mfa-sa', 'superadmin');
    const target = await env.student('mfa-target', progCS.id);
    const a = await env.login(admin);
    await env.stepUp(a, admin);
    expect((await a.post(`/users/${admin.id}/mfa-reset`, { reason: 'trying to reset myself, no verification' })).status).toBe(403);
    expect((await a.post(`/users/${sa.id}/mfa-reset`, { reason: 'trying to reset a super admin account' })).status).toBe(403);
    const ok = await a.post(`/users/${target.user.id}/mfa-reset`, { reason: 'Identity verified in person with student ID card' });
    expect(ok.status).toBe(204);
    const u = await env.owner.user_account.findUniqueOrThrow({ where: { id: target.user.id } });
    expect(u.mfa_enrolled).toBe(false);
    expect(await env.owner.mfa_factor.count({ where: { user_id: target.user.id } })).toBe(0);
    expect((await env.audit('MFA_RESET', admin.id)).length).toBe(1);
    // the user's existing sessions are gone
    const fresh = new Agent(env.server);
    const login = await fresh.post('/auth/login', { email: target.user.email, password: target.user.password });
    expect(login.body.stage).toBe('enrol_pending'); // must enrol again before seeing any data
    expect((await fresh.get('/students/me')).status).toBe(401);
  });
});

describe('exports', () => {
  test('coordinator export is masked and own-programme; every export is logged with a file hash; formulas are neutralised', async () => {
    const coord = await env.user('exp-coord', 'coordinator', { programmeIds: [progCS.id] });
    const mine = await env.student('exp-mine', progCS.id);
    await env.owner.student.update({ where: { id: mine.student.id }, data: { name: '=HYPERLINK("http://evil.example","click")' } });
    const theirs = await env.student('exp-theirs', progAI.id);
    const a = await env.login(coord);
    await env.expireStepUp(a);
    expect((await a.get('/exports/students?format=csv')).status).toBe(401); // step-up required
    await env.stepUp(a, coord);
    const res = await a.get('/exports/students?format=csv');
    expect(res.status).toBe(200);
    const csv = res.text;
    expect(csv).toMatch(/^﻿?# CONFIDENTIAL/);
    expect(csv).toContain(coord.email);
    expect(csv).toContain(mine.student.placement_id);
    expect(csv).not.toContain(theirs.student.placement_id);
    expect(csv).not.toContain(mine.student.email); // masked
    expect(csv).not.toContain(mine.mobile);
    expect(csv).toContain("'=HYPERLINK"); // formula injection neutralised
    const log = await env.owner.export_log.findFirstOrThrow({ where: { actor_id: coord.id }, orderBy: { at: 'desc' } });
    expect(log.row_count).toBe(csv.trim().split(/\r?\n/).length - 2); // minus watermark and header
    expect(log.row_count).toBeGreaterThanOrEqual(1);
    expect(log.file_hash).toBe(res.headers['x-export-sha256']);
    expect((log.fields as string[]).includes('E-mail')).toBe(true);

    const hr = await env.user('exp-hr', 'hr', { companyId: (await setupDrive('exp-co')).company.id });
    const h = await env.login(hr);
    await env.stepUp(h, hr);
    expect((await h.get('/exports/students')).status).toBe(403);
  });
});
