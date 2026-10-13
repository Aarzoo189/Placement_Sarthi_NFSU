import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { BlockList, isIPv4, isIPv6 } from 'net';
import { Request, Response } from 'express';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { CryptoService } from '../common/crypto.service';
import { RateLimitService } from '../common/rate-limit.service';
import { MailService } from '../common/mail.service';
import { AuditService } from '../common/audit.service';
import { SessionData } from '../common/types';
import { env, isProd } from '../config/env';
import { DEVICE_COOKIE, SessionService, TRUST_COOKIE } from './session.service';
import { MfaService, VerifyMethod } from './mfa.service';
import { WebAuthnService } from './webauthn.service';
import { checkPassword } from './password-policy';
import { mfaPolicy } from './mfa-policy';

export interface HttpCtx {
  req: Request;
  res: Response;
}

const GENERIC_LOGIN_ERROR = 'Incorrect email or password.';
const DAY = 24 * 3600_000;

const superAdminNets = new BlockList();
for (const c of env.SUPERADMIN_ALLOWED_CIDRS.split(',').map((s) => s.trim()).filter(Boolean)) {
  const [addr, bits] = c.split('/');
  if (isIPv4(addr)) superAdminNets.addSubnet(addr, Number(bits ?? 32), 'ipv4');
  else if (isIPv6(addr)) superAdminNets.addSubnet(addr, Number(bits ?? 128), 'ipv6');
}

/** Super Admin may only sign in from the university network or VPN. */
export function superAdminNetworkAllowed(ip: string): boolean {
  const clean = ip.replace(/^::ffff:/, '');
  if (isIPv4(clean)) return superAdminNets.check(clean, 'ipv4');
  if (isIPv6(clean)) return superAdminNets.check(clean, 'ipv6');
  return false;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    private readonly sessions: SessionService,
    private readonly mfa: MfaService,
    private readonly webauthn: WebAuthnService,
    private readonly rl: RateLimitService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  // ================================================================== login ====

  /** Step 1: email + password. Always responds with the same error for a wrong user or a wrong password. */
  async login(email: string, password: string, { req, res }: HttpCtx) {
    const ip = req.ip ?? '';
    await this.rl.hit(`auth-ip:${ip}`, env.AUTH_IP_LIMIT, 60);

    const subject = `login:${this.crypto.hmac(email, 'login')}`;
    const left = await this.rl.lockedFor(subject);
    if (left > 0) throw new HttpException({ message: `Too many failed attempts. Try again in ${Math.ceil(left / 60)} minutes.`, code: 'LOCKED', retry_after: left }, HttpStatus.TOO_MANY_REQUESTS);

    const user = await this.prisma.user_account.findUnique({ where: { email } });
    const usable = !!user && user.status === 'active' && !!user.password_hash;
    const ok = usable ? await this.crypto.verifyPassword(user!.password_hash, password) : await this.crypto.dummyVerify(password);

    if (!ok || !user) {
      const r = await this.rl.fail(subject);
      await this.audit.log({ actor: user ? { id: user.id, role: user.role, ip } : null, action: 'LOGIN_FAILED', entity: 'user_account', entity_id: user?.id ?? null, ip, meta: { email_hash: this.crypto.hmac(email, 'audit-email'), failures: r.failures, locked: r.locked } });
      if (r.locked) {
        await this.audit.log({ actor: user ? { id: user.id, role: user.role, ip } : null, action: 'LOGIN_LOCKOUT', entity: 'user_account', entity_id: user?.id ?? null, ip, meta: { alert: true } });
        if (user) await this.mail.send(user.email, 'Security alert: sign-in locked', 'There were 5 failed password attempts on your NFSU Placement Portal account, so sign-in is locked for 15 minutes. If this was not you, tell the Placement Cell.');
        throw new HttpException({ message: 'Too many failed attempts. Sign-in is locked for 15 minutes.', code: 'LOCKED', retry_after: RateLimitService.LOCKOUT_SECONDS }, HttpStatus.TOO_MANY_REQUESTS);
      }
      throw new UnauthorizedException({ message: GENERIC_LOGIN_ERROR, code: 'BAD_CREDENTIALS' });
    }
    await this.rl.reset(subject);

    if (user.role === 'superadmin' && !superAdminNetworkAllowed(ip)) {
      await this.audit.log({ actor: { id: user.id, role: user.role, ip }, action: 'SUPERADMIN_LOGIN_BLOCKED_NETWORK', entity: 'user_account', entity_id: user.id, ip, meta: { alert: true } });
      throw new ForbiddenException({ message: 'Super Admin sign-in is only allowed from the university network or VPN.', code: 'NETWORK_DENIED' });
    }

    const scope = await this.scopeFor(user.id, user.role);
    const base = { id: user.id, email: user.email, name: user.name, role: user.role, ...scope };
    const meta = { ip, user_agent: req.get('user-agent') ?? '' };

    // "Remember this device" (students only, 30 days): skips the second factor on a known browser.
    if (user.role === 'student' && user.mfa_enrolled && (await this.hasValidTrustCookie(req, user.id))) {
      const { token, data } = await this.sessions.create(base, 'full', meta, { step_up_at: null });
      await this.afterFullLogin(user, data, { req, res }, 'trusted-device');
      this.sessions.setCookie(res, token);
      return { session: data, payload: await this.payload(data) };
    }

    const enrolled = user.mfa_enrolled && (await this.mfa.isEnrolmentComplete(user.id, user.role));
    const { token, data } = await this.sessions.create(base, enrolled ? 'mfa_pending' : 'enrol_pending', meta);
    this.sessions.setCookie(res, token);
    return { session: data, payload: await this.payload(data) };
  }

  private async scopeFor(userId: string, role: string) {
    if (role === 'coordinator') {
      const rows = await this.prisma.coordinator_scope.findMany({ where: { user_id: userId } });
      return { programme_ids: rows.map((r) => r.programme_id) };
    }
    if (role === 'hr') {
      const hr = await this.prisma.hr_user.findUnique({ where: { user_id: userId } });
      if (!hr || hr.valid_until.getTime() < Date.now()) throw new ForbiddenException({ message: 'This company account has expired. Ask the Placement Officer to re-invite you.', code: 'HR_EXPIRED' });
      return { company_id: hr.company_id };
    }
    return {};
  }

  private async hasValidTrustCookie(req: Request, userId: string): Promise<boolean> {
    const raw = req.cookies?.[TRUST_COOKIE];
    if (!raw || typeof raw !== 'string') return false;
    const row = await this.prisma.trusted_device.findUnique({ where: { token_hash: this.crypto.sha256(raw) } });
    return !!row && row.user_id === userId && row.expires_at.getTime() > Date.now();
  }

  /** What the SPA needs to know after any auth step. */
  async payload(s: SessionData) {
    const user = await this.prisma.user_account.findUnique({ where: { id: s.user_id } });
    const policy = mfaPolicy(s.role);
    const base = {
      stage: s.stage,
      csrf: s.csrf,
      user: { id: s.user_id, email: s.email, name: s.name, role: s.role, programme_ids: s.programme_ids ?? [], company_id: s.company_id ?? null },
      step_up_fresh: this.sessions.hasFreshStepUp(s),
      session: { idle_minutes: Math.round(({ student: 15, coordinator: 15, officer: 15, hr: 15, admin: 10, superadmin: 10 } as const)[s.role]), expires_at: s.created_at + ({ student: 8, coordinator: 8, officer: 8, hr: 4, admin: 4, superadmin: 2 } as const)[s.role] * 3_600_000 },
    };
    if (s.stage === 'mfa_pending' || s.stage === 'full') {
      const m = await this.mfa.availableMethods(s.user_id, s.role);
      return { ...base, mfa: m };
    }
    const factors = await this.mfa.confirmedFactors(s.user_id);
    return {
      ...base,
      enrol: { allowed: policy.enrol, min_passkeys: policy.minPasskeys, passkeys: factors.filter((f) => f.type === 'passkey').length, totp: factors.some((f) => f.type === 'totp'), activated: !!user?.password_hash },
    };
  }

  // ============================================================ second factor ====

  /**
   * One endpoint for both purposes: while the session is `mfa_pending` a valid factor completes the sign-in; while it is
   * `full` a valid factor is a step-up (fresh MFA for a sensitive action, session id rotated).
   */
  async verifySecondFactor(s: SessionData, input: { method: VerifyMethod; code: string; remember_device?: boolean }, ctx: HttpCtx) {
    const user = await this.requireUser(s);
    await this.rl.hit(`auth-ip:${ctx.req.ip}`, env.AUTH_IP_LIMIT, 60);
    await this.mfa.verify(user, input.method, input.code, ctx.req.ip ?? '');
    return this.completeSecondFactor(s, user, ctx, input.method, !!input.remember_device);
  }

  async startPasskeyAuth(s: SessionData) {
    const { options, challenge } = await this.webauthn.authenticationOptions(s.user_id);
    await this.sessions.update({ ...s, scratch: { ...s.scratch, passkey_challenge: challenge } });
    return options;
  }

  async verifyPasskey(s: SessionData, response: AuthenticationResponseJSON, ctx: HttpCtx) {
    const user = await this.requireUser(s);
    await this.rl.hit(`auth-ip:${ctx.req.ip}`, env.AUTH_IP_LIMIT, 60);
    const left = await this.rl.lockedFor(`mfa:${user.id}`);
    if (left > 0) throw new HttpException({ message: `Too many failed attempts. Try again in ${Math.ceil(left / 60)} minutes.`, code: 'LOCKED', retry_after: left }, HttpStatus.TOO_MANY_REQUESTS);
    const challenge = s.scratch?.passkey_challenge as string | undefined;
    // Single-use challenge: clear it before checking, so a failed attempt cannot be retried against the same challenge.
    await this.sessions.update({ ...s, scratch: { ...s.scratch, passkey_challenge: undefined } });
    const ok = challenge ? await this.webauthn.verifyAuthentication(user.id, response, challenge) : false;
    if (!ok) await this.mfa.failed(user, 'passkey', ctx.req.ip ?? '');
    await this.rl.reset(`mfa:${user.id}`);
    return this.completeSecondFactor(s, user, ctx, 'passkey', false);
  }

  private async completeSecondFactor(s: SessionData, user: { id: string; email: string; name: string; role: SessionData['role'] }, ctx: HttpCtx, method: string, remember: boolean) {
    if (s.stage === 'mfa_pending') {
      const { token, data } = await this.sessions.rotate(s, { stage: 'full', step_up_at: Date.now(), scratch: undefined });
      await this.afterFullLogin(user, data, ctx, method);
      if (remember && mfaPolicy(user.role).rememberDevice) await this.rememberDevice(user.id, ctx.res);
      this.sessions.setCookie(ctx.res, token);
      return this.payload(data);
    }
    // step-up
    const { token, data } = await this.sessions.rotate(s, { step_up_at: Date.now(), scratch: undefined });
    await this.audit.log({ actor: { id: user.id, role: user.role, ip: ctx.req.ip }, action: 'STEP_UP', entity: 'user_account', entity_id: user.id, meta: { method } });
    this.sessions.setCookie(ctx.res, token);
    return this.payload(data);
  }

  private async afterFullLogin(user: { id: string; email: string; name: string; role: string }, s: SessionData, { req, res }: HttpCtx, method: string) {
    const ip = req.ip ?? '';
    await this.prisma.user_account.update({ where: { id: user.id }, data: { last_login: new Date() } });
    await this.audit.log({ actor: { id: user.id, role: user.role as never, ip }, action: 'LOGIN_SUCCESS', entity: 'user_account', entity_id: user.id, meta: { method, user_agent: s.user_agent } });

    // New-device alert: a stolen password is useless without MFA, but the owner should still hear about it.
    let dev = req.cookies?.[DEVICE_COOKIE] as string | undefined;
    if (!dev || typeof dev !== 'string' || dev.length < 20) {
      dev = this.crypto.token(24);
      res.cookie(DEVICE_COOKIE, dev, { httpOnly: true, secure: env.COOKIE_SECURE || isProd, sameSite: 'strict', path: '/', maxAge: 365 * DAY });
    }
    const dh = this.crypto.sha256(dev);
    const known = await this.redis.scard(`knowndev:${user.id}`);
    const seen = await this.redis.sismember(`knowndev:${user.id}`, dh);
    if (!seen) {
      await this.redis.sadd(`knowndev:${user.id}`, dh);
      if (known > 0) {
        await this.mail.send(user.email, 'New sign-in to your NFSU Placement Portal account', `A sign-in just happened from a device we have not seen before.\n\nTime: ${new Date().toISOString()}\nIP address: ${ip}\nBrowser: ${s.user_agent}\n\nIf this was you, no action is needed. If not, change your password and contact the Placement Cell immediately.`);
      }
    }

    // Super Admin: alert on every login.
    if (user.role === 'superadmin') {
      await this.audit.log({ actor: { id: user.id, role: 'superadmin', ip }, action: 'SUPERADMIN_LOGIN', entity: 'user_account', entity_id: user.id, meta: { alert: true, ip } });
      const others = await this.prisma.user_account.findMany({ where: { role: 'superadmin', status: 'active' }, select: { email: true } });
      for (const o of others) await this.mail.send(o.email, 'Super Admin sign-in', `${user.email} signed in as Super Admin at ${new Date().toISOString()} from ${ip}. Every Super Admin login is reported to all Super Admins.`);
    }
  }

  private async rememberDevice(userId: string, res: Response) {
    const raw = this.crypto.token(32);
    await this.prisma.trusted_device.create({ data: { user_id: userId, token_hash: this.crypto.sha256(raw), expires_at: new Date(Date.now() + 30 * DAY) } });
    res.cookie(TRUST_COOKIE, raw, { httpOnly: true, secure: env.COOKIE_SECURE || isProd, sameSite: 'strict', path: '/', maxAge: 30 * DAY });
  }

  private async requireUser(s: SessionData) {
    const user = await this.prisma.user_account.findUnique({ where: { id: s.user_id } });
    if (!user || user.status !== 'active') throw new UnauthorizedException({ message: 'Not signed in', code: 'NO_SESSION' });
    return user;
  }

  // ================================================================ enrolment ====

  async startTotpEnrol(s: SessionData) {
    if (!mfaPolicy(s.role).enrol.includes('totp')) throw new ForbiddenException({ message: 'Authenticator apps are not allowed for this role', code: 'METHOD_NOT_ALLOWED' });
    const t = await this.mfa.startTotp(s.email);
    await this.sessions.update({ ...s, scratch: { ...s.scratch, totp_secret: t.secret } });
    return { otpauth_url: t.otpauth_url, qr_data_url: t.qr_data_url, secret: t.secret };
  }

  async confirmTotpEnrol(s: SessionData, code: string, ctx: HttpCtx) {
    const secret = s.scratch?.totp_secret as string | undefined;
    if (!secret) throw new BadRequestException({ message: 'Start TOTP enrolment first', code: 'NO_PENDING_ENROLMENT' });
    await this.mfa.confirmTotp(s.user_id, secret, code);
    return this.afterEnrol(s, ctx, 'totp');
  }

  async startPasskeyEnrol(s: SessionData) {
    if (!mfaPolicy(s.role).enrol.includes('passkey')) throw new ForbiddenException({ message: 'Passkeys are not allowed for this role', code: 'METHOD_NOT_ALLOWED' });
    const { options, challenge } = await this.webauthn.registrationOptions({ id: s.user_id, email: s.email, name: s.name });
    await this.sessions.update({ ...s, scratch: { ...s.scratch, passkey_reg_challenge: challenge } });
    return options;
  }

  async confirmPasskeyEnrol(s: SessionData, response: RegistrationResponseJSON, label: string | undefined, ctx: HttpCtx) {
    const challenge = s.scratch?.passkey_reg_challenge as string | undefined;
    await this.sessions.update({ ...s, scratch: { ...s.scratch, passkey_reg_challenge: undefined } });
    if (!challenge) throw new BadRequestException({ message: 'Start passkey registration first', code: 'NO_PENDING_ENROLMENT' });
    await this.webauthn.verifyRegistration(s.user_id, response, challenge, label);
    return this.afterEnrol(s, ctx, 'passkey');
  }

  private async afterEnrol(s: SessionData, ctx: HttpCtx, type: string) {
    const user = await this.requireUser(s);
    const complete = await this.mfa.isEnrolmentComplete(user.id, user.role);
    await this.audit.log({ actor: { id: user.id, role: user.role, ip: ctx.req.ip }, action: 'MFA_FACTOR_ADDED', entity: 'mfa_factor', entity_id: user.id, meta: { type, complete } });

    let recovery_codes: string[] | undefined;
    if (complete && mfaPolicy(user.role).recoveryCodes && !user.mfa_enrolled) recovery_codes = await this.mfa.regenerateRecoveryCodes(user.id);
    if (complete && !user.mfa_enrolled) await this.prisma.user_account.update({ where: { id: user.id }, data: { mfa_enrolled: true } });

    if (complete && s.stage === 'enrol_pending') {
      // Enrolment proves possession of the factor, so the session is promoted straight to a signed-in one.
      const { token, data } = await this.sessions.rotate(s, { stage: 'full', step_up_at: Date.now(), scratch: undefined });
      await this.afterFullLogin(user, data, ctx, `enrol:${type}`);
      this.sessions.setCookie(ctx.res, token);
      return { complete, recovery_codes, ...(await this.payload(data)) };
    }
    return { complete, recovery_codes, ...(await this.payload({ ...s, scratch: undefined })) };
  }

  // ============================================================== activation ====

  /** Student / HR / staff accounts are activated from a one-time link (valid 24 h). */
  async activate(rawToken: string, password: string, ctx: HttpCtx) {
    await this.rl.hit(`auth-ip:${ctx.req.ip}`, Math.min(env.AUTH_IP_LIMIT, 20), 60);
    const user = await this.prisma.user_account.findUnique({ where: { activation_token_hash: this.crypto.sha256(rawToken) } });
    if (!user || !user.activation_expires || user.activation_expires.getTime() < Date.now() || user.status === 'disabled') {
      throw new BadRequestException({ message: 'This activation link is invalid or has expired. Ask your coordinator for a new one.', code: 'BAD_ACTIVATION' });
    }
    const pw = checkPassword(password, { email: user.email, name: user.name });
    if (!pw.ok) throw new BadRequestException({ message: 'Password not accepted', reasons: pw.reasons, code: 'WEAK_PASSWORD' });

    await this.prisma.user_account.update({
      where: { id: user.id },
      data: { password_hash: await this.crypto.hashPassword(password), status: 'active', activation_token_hash: null, activation_expires: null, password_changed_at: new Date() },
    });
    await this.audit.log({ actor: { id: user.id, role: user.role, ip: ctx.req.ip }, action: 'ACCOUNT_ACTIVATED', entity: 'user_account', entity_id: user.id });

    const scope = await this.scopeFor(user.id, user.role);
    const { token, data } = await this.sessions.create({ id: user.id, email: user.email, name: user.name, role: user.role, ...scope }, 'enrol_pending', { ip: ctx.req.ip ?? '', user_agent: ctx.req.get('user-agent') ?? '' });
    this.sessions.setCookie(ctx.res, token);
    return this.payload(data);
  }

  // ================================================================ password ====

  async changePassword(s: SessionData, current: string, next: string, ctx: HttpCtx) {
    const user = await this.requireUser(s);
    if (!(await this.crypto.verifyPassword(user.password_hash, current))) throw new UnauthorizedException({ message: 'Current password is incorrect.', code: 'BAD_CREDENTIALS' });
    const pw = checkPassword(next, { email: user.email, name: user.name });
    if (!pw.ok) throw new BadRequestException({ message: 'Password not accepted', reasons: pw.reasons, code: 'WEAK_PASSWORD' });
    await this.prisma.user_account.update({ where: { id: user.id }, data: { password_hash: await this.crypto.hashPassword(next), password_changed_at: new Date() } });
    await this.prisma.trusted_device.deleteMany({ where: { user_id: user.id } });
    // All sessions are revoked on a password change; this one is re-issued so the user is not signed out of the tab they are using.
    await this.sessions.destroyAll(user.id, s.id);
    const { token, data } = await this.sessions.rotate(s, {});
    this.sessions.setCookie(ctx.res, token);
    await this.audit.log({ actor: { id: user.id, role: user.role, ip: ctx.req.ip }, action: 'PASSWORD_CHANGED', entity: 'user_account', entity_id: user.id });
    await this.mail.send(user.email, 'Your NFSU Placement Portal password was changed', 'If you did not do this, contact the Placement Cell immediately.');
    return this.payload(data);
  }

  // ================================================================== logout ====

  async logout(s: SessionData, ctx: HttpCtx) {
    await this.sessions.destroyById(s.id, s.user_id);
    this.sessions.clearCookie(ctx.res);
    await this.audit.log({ actor: { id: s.user_id, role: s.role, ip: ctx.req.ip }, action: 'LOGOUT', entity: 'user_account', entity_id: s.user_id });
  }

  async logoutAll(s: SessionData, ctx: HttpCtx) {
    const n = await this.sessions.destroyAll(s.user_id);
    await this.prisma.trusted_device.deleteMany({ where: { user_id: s.user_id } });
    this.sessions.clearCookie(ctx.res);
    await this.audit.log({ actor: { id: s.user_id, role: s.role, ip: ctx.req.ip }, action: 'LOGOUT_ALL', entity: 'user_account', entity_id: s.user_id, meta: { sessions: n } });
  }
}
