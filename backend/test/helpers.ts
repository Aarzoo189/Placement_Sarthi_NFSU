import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient, Role } from '@prisma/client';
import { authenticator } from 'otplib';
import { createHash, randomBytes } from 'crypto';
import Redis from 'ioredis';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/main';
import { CryptoService } from '../src/common/crypto.service';

export const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5173';
authenticator.options = { window: 1 };

export interface TestUser {
  id: string;
  email: string;
  password: string;
  totp: string;
  role: Role;
}

export class Env {
  app!: NestExpressApplication;
  owner = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_DATABASE_URL } } });
  redis = new Redis(process.env.REDIS_URL!);
  crypto = new CryptoService();
  uniq = randomBytes(3).toString('hex');

  async start() {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    this.app = mod.createNestApplication<NestExpressApplication>();
    configureApp(this.app);
    await this.app.init();
    // A fresh audit chain per run (the S7 test deliberately breaks it). Safe: this is the isolated test database.
    await this.owner.$executeRaw`TRUNCATE audit_log RESTART IDENTITY`;
    // Programmes are static reference data.
    for (const [code, name] of [['T-CS', 'Test Cyber Security'], ['T-AI', 'Test AI & Data Science']]) await this.owner.programme.upsert({ where: { code }, create: { code, name }, update: {} });
  }

  async stop() {
    await this.app.close();
    await this.owner.$disconnect();
    this.redis.disconnect();
  }

  get server() {
    return this.app.getHttpServer();
  }

  tag(s: string) {
    return `${s}-${this.uniq}`;
  }

  async programme(code: 'T-CS' | 'T-AI') {
    return this.owner.programme.findUniqueOrThrow({ where: { code } });
  }

  /** Create an active, MFA-enrolled user directly in the database (the owner connection bypasses RLS). */
  async user(key: string, role: Role, extra: { programmeIds?: string[]; companyId?: string; name?: string } = {}): Promise<TestUser> {
    const password = 'Correct-Horse-Battery-' + randomBytes(4).toString('hex');
    const totp = authenticator.generateSecret(20);
    const email = `${this.tag(key)}@test.example`;
    const u = await this.owner.user_account.create({
      data: { email, name: extra.name ?? key, role, status: 'active', password_hash: await this.crypto.hashPassword(password), mfa_enrolled: true },
    });
    await this.owner.mfa_factor.create({ data: { user_id: u.id, type: 'totp', secret_enc: this.crypto.encrypt(totp, 'mfa_factor.secret_enc'), confirmed_at: new Date() } });
    if (role === 'coordinator') await this.owner.coordinator_scope.createMany({ data: (extra.programmeIds ?? []).map((programme_id) => ({ user_id: u.id, programme_id })) });
    if (role === 'hr') await this.owner.hr_user.create({ data: { user_id: u.id, company_id: extra.companyId!, valid_until: new Date(Date.now() + 30 * 86_400_000) } });
    return { id: u.id, email, password, totp, role };
  }

  async student(key: string, programmeId: string, opts: { cgpa?: number; elig?: 'eligible' | 'pending' | 'ineligible'; reg?: 'registered' | 'not_registered' } = {}) {
    const u = await this.user(key, 'student', { name: `Student ${key}` });
    const mobile = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
    const s = await this.owner.student.create({
      data: {
        placement_id: `T${randomBytes(4).toString('hex').toUpperCase()}`, user_id: u.id, name: `Student ${key}`, email: u.email, mobile_enc: this.crypto.encrypt(mobile, 'student.mobile_enc'), mobile_hash: this.crypto.hmac(mobile, 'mobile'),
        programme_id: programmeId, batch: 2026, cgpa: opts.cgpa ?? 8, registration_status: opts.reg ?? 'registered', eligibility_status: opts.elig ?? 'eligible',
      },
    });
    return { user: u, student: s, mobile };
  }

  async clearTotpReplay() {
    const keys = await this.redis.keys('totp-used:*');
    if (keys.length) await this.redis.del(...keys);
  }

  /** Full sign-in through the real endpoints: password, then TOTP. */
  async login(u: TestUser): Promise<Agent> {
    await this.clearTotpReplay();
    const a = new Agent(this.server);
    const r1 = await a.post('/auth/login', { email: u.email, password: u.password });
    if (r1.status !== 200) throw new Error(`login failed ${r1.status} ${JSON.stringify(r1.body)}`);
    const r2 = await a.post('/auth/mfa/verify', { method: 'totp', code: authenticator.generate(u.totp) });
    if (r2.status !== 200) throw new Error(`mfa failed ${r2.status} ${JSON.stringify(r2.body)}`);
    return a;
  }

  /** Make the session look like its last step-up was long ago (to prove that sensitive routes demand a fresh one). */
  async expireStepUp(agent: Agent) {
    const key = `sess:${createHash('sha256').update(agent.cookies['sid']).digest('hex')}`;
    const s = JSON.parse((await this.redis.get(key))!);
    s.step_up_at = Date.now() - 3_600_000;
    await this.redis.set(key, JSON.stringify(s), 'PX', 600_000);
  }

  async stepUp(agent: Agent, u: TestUser) {
    await this.clearTotpReplay();
    const r = await agent.post('/auth/mfa/verify', { method: 'totp', code: authenticator.generate(u.totp) });
    if (r.status !== 200) throw new Error(`step-up failed ${r.status} ${JSON.stringify(r.body)}`);
  }

  async audit(action: string, actorId?: string) {
    return this.owner.audit_log.findMany({ where: { action, ...(actorId ? { actor_id: actorId } : {}) }, orderBy: { id: 'desc' } });
  }
}

export class Agent {
  cookies: Record<string, string> = {};
  csrf?: string;
  constructor(private readonly server: unknown) {}

  private apply(res: request.Response) {
    for (const c of (res.headers['set-cookie'] as unknown as string[] | undefined) ?? []) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const name = kv.slice(0, i);
      const val = kv.slice(i + 1);
      if (val === '' || /expires=thu, 01 jan 1970/i.test(c)) delete this.cookies[name];
      else this.cookies[name] = val;
    }
    if (res.body && typeof res.body === 'object' && 'csrf' in res.body) this.csrf = (res.body as { csrf: string }).csrf;
    return res;
  }

  async call(method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: unknown, o: { origin?: string | null; csrf?: string | null; file?: { name: string; data: Buffer; type?: string } } = {}) {
    let r = request(this.server as never)[method](`/api${url}`);
    if (o.origin !== null) r = r.set('Origin', o.origin ?? ORIGIN);
    const cookie = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) r = r.set('Cookie', cookie);
    const csrf = o.csrf === undefined ? this.csrf : o.csrf;
    if (csrf && method !== 'get') r = r.set('X-CSRF-Token', csrf);
    if (o.file) r = r.attach('file', o.file.data, { filename: o.file.name, contentType: o.file.type ?? 'text/csv' });
    else if (body !== undefined) r = r.send(body as never);
    return this.apply(await r);
  }
  get = (u: string, o?: Parameters<Agent['call']>[3]) => this.call('get', u, undefined, o);
  post = (u: string, b?: unknown, o?: Parameters<Agent['call']>[3]) => this.call('post', u, b ?? {}, o);
  put = (u: string, b?: unknown, o?: Parameters<Agent['call']>[3]) => this.call('put', u, b ?? {}, o);
  patch = (u: string, b?: unknown, o?: Parameters<Agent['call']>[3]) => this.call('patch', u, b ?? {}, o);
  delete = (u: string, b?: unknown, o?: Parameters<Agent['call']>[3]) => this.call('delete', u, b ?? {}, o);
}
