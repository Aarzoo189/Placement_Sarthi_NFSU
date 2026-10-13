import { BadRequestException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { MfaType } from '@prisma/client';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { CryptoService } from '../common/crypto.service';
import { RateLimitService } from '../common/rate-limit.service';
import { MailService } from '../common/mail.service';
import { AuditService } from '../common/audit.service';
import { env } from '../config/env';
import { RoleName } from '../common/types';
import { enrolmentComplete, mfaPolicy } from './mfa-policy';

authenticator.options = { window: 1, step: 30, digits: 6 };

const SECRET_AAD = 'mfa_factor.secret_enc';
const EMAIL_OTP_TTL = 5 * 60;
const EMAIL_OTP_MAX_ATTEMPTS = 5;

export type VerifyMethod = 'totp' | 'email' | 'recovery';

@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    private readonly rl: RateLimitService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ status ----

  async confirmedFactors(userId: string) {
    return this.prisma.mfa_factor.findMany({ where: { user_id: userId, confirmed_at: { not: null } }, orderBy: { created_at: 'asc' } });
  }

  /** Which methods this user can use right now (for the MFA screen). */
  async availableMethods(userId: string, role: RoleName) {
    const policy = mfaPolicy(role);
    const factors = await this.confirmedFactors(userId);
    const has = (t: MfaType) => factors.some((f) => f.type === t);
    const methods: string[] = [];
    if (policy.login.includes('passkey') && has('passkey')) methods.push('passkey');
    if (policy.login.includes('totp') && has('totp')) methods.push('totp');
    if (policy.emailOtp && policy.login.includes('email')) methods.push('email');
    if (policy.recoveryCodes && (await this.prisma.recovery_code.count({ where: { user_id: userId, used_at: null } })) > 0) methods.push('recovery');
    return { methods, primary: policy.primary };
  }

  async isEnrolmentComplete(userId: string, role: RoleName) {
    return enrolmentComplete(role, await this.confirmedFactors(userId));
  }

  // -------------------------------------------------------------------- TOTP ----

  async startTotp(email: string): Promise<{ secret: string; otpauth_url: string; qr_data_url: string }> {
    const secret = authenticator.generateSecret(20);
    const otpauth_url = authenticator.keyuri(email, env.WEBAUTHN_RP_NAME, secret);
    const qr_data_url = await QRCode.toDataURL(otpauth_url, { margin: 1, width: 220 });
    return { secret, otpauth_url, qr_data_url };
  }

  /** Confirm enrolment: the user proves they hold the secret by entering a current code. */
  async confirmTotp(userId: string, secret: string, code: string, label?: string) {
    if (!authenticator.check(code.replace(/\s/g, ''), secret)) throw new BadRequestException({ message: 'That code is not valid. Check the clock on your phone and try again.', code: 'BAD_CODE' });
    return this.prisma.mfa_factor.create({
      data: { user_id: userId, type: 'totp', secret_enc: this.crypto.encrypt(secret, SECRET_AAD), label: label ?? 'Authenticator app', confirmed_at: new Date() },
    });
  }

  private async verifyTotp(userId: string, code: string): Promise<boolean> {
    const clean = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(clean)) return false;
    const factors = await this.prisma.mfa_factor.findMany({ where: { user_id: userId, type: 'totp', confirmed_at: { not: null } } });
    for (const f of factors) {
      if (!f.secret_enc) continue;
      const secret = this.crypto.decrypt(f.secret_enc, SECRET_AAD);
      if (authenticator.check(clean, secret)) {
        // Replay protection: a code is single-use inside its validity window.
        const first = await this.redis.set(`totp-used:${userId}:${clean}`, '1', 'EX', 120, 'NX');
        return first === 'OK';
      }
    }
    return false;
  }

  // --------------------------------------------------------------- e-mail OTP ----

  async sendEmailOtp(user: { id: string; email: string; role: RoleName }, purpose: 'login' | 'step_up') {
    if (!mfaPolicy(user.role).emailOtp) throw new BadRequestException({ message: 'E-mail codes are not available for this account', code: 'METHOD_NOT_ALLOWED' });
    // At most one code per minute per user.
    const cool = await this.redis.set(`otp-cool:${user.id}`, '1', 'EX', 60, 'NX');
    if (cool !== 'OK') throw new HttpException({ message: 'A code was just sent. Wait a minute before requesting another.', code: 'OTP_COOLDOWN' }, HttpStatus.TOO_MANY_REQUESTS);
    const code = this.crypto.numericCode(6);
    await this.redis.set(`otp:${user.id}`, JSON.stringify({ h: this.crypto.hmac(code, `otp:${user.id}`), attempts: 0 }), 'EX', EMAIL_OTP_TTL);
    await this.mail.send(
      user.email,
      'Your NFSU Placement Portal sign-in code',
      `Your verification code is ${code}.\n\nIt expires in 5 minutes and works once. If you did not try to ${purpose === 'login' ? 'sign in' : 'confirm an action'}, change your password now and tell the Placement Cell.`,
    );
  }

  private async verifyEmailOtp(userId: string, code: string): Promise<boolean> {
    const raw = await this.redis.get(`otp:${userId}`);
    if (!raw) return false;
    const rec = JSON.parse(raw) as { h: string; attempts: number };
    if (rec.attempts >= EMAIL_OTP_MAX_ATTEMPTS) {
      await this.redis.del(`otp:${userId}`);
      return false;
    }
    if (this.crypto.safeEqual(this.crypto.hmac(code.replace(/\s/g, ''), `otp:${userId}`), rec.h)) {
      await this.redis.del(`otp:${userId}`); // single use
      return true;
    }
    rec.attempts += 1;
    const ttl = await this.redis.ttl(`otp:${userId}`);
    await this.redis.set(`otp:${userId}`, JSON.stringify(rec), 'EX', Math.max(ttl, 1));
    return false;
  }

  // ----------------------------------------------------------- recovery codes ----

  /** Generates 10 single-use codes. Returned once, stored only as Argon2id hashes. */
  async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: 10 }, () => {
      const raw = this.crypto.token(8).replace(/[-_]/g, 'x').toLowerCase().slice(0, 10);
      return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
    const hashes = await Promise.all(codes.map((c) => this.crypto.hashPassword(c)));
    await this.prisma.$transaction([
      this.prisma.recovery_code.deleteMany({ where: { user_id: userId } }),
      this.prisma.recovery_code.createMany({ data: hashes.map((h) => ({ user_id: userId, code_hash: h })) }),
    ]);
    return codes;
  }

  private async verifyRecovery(userId: string, code: string): Promise<boolean> {
    const norm = code.trim().toLowerCase();
    if (!/^[a-z0-9]{5}-[a-z0-9]{5}$/.test(norm)) return false;
    const rows = await this.prisma.recovery_code.findMany({ where: { user_id: userId, used_at: null } });
    for (const r of rows) {
      if (await this.crypto.verifyPassword(r.code_hash, norm)) {
        // Atomic claim: only one concurrent request can consume the code.
        const res = await this.prisma.recovery_code.updateMany({ where: { id: r.id, used_at: null }, data: { used_at: new Date() } });
        return res.count === 1;
      }
    }
    return false;
  }

  // -------------------------------------------------------------- verification ----

  /**
   * Verify a second factor. 5 consecutive failures lock MFA for 15 minutes ("deny and alert, attempt is logged").
   * Returns normally on success; throws 401 on a wrong code; throws 429 when locked.
   */
  async verify(user: { id: string; email: string; role: RoleName }, method: VerifyMethod, code: string, ip: string): Promise<void> {
    const subject = `mfa:${user.id}`;
    const left = await this.rl.lockedFor(subject);
    if (left > 0) throw new HttpException({ message: `Too many failed attempts. Try again in ${Math.ceil(left / 60)} minutes.`, code: 'LOCKED', retry_after: left }, HttpStatus.TOO_MANY_REQUESTS);

    const policy = mfaPolicy(user.role);
    let ok = false;
    if (method === 'totp' && policy.login.includes('totp')) ok = await this.verifyTotp(user.id, code);
    else if (method === 'email' && policy.emailOtp) ok = await this.verifyEmailOtp(user.id, code);
    else if (method === 'recovery' && policy.recoveryCodes) ok = await this.verifyRecovery(user.id, code);

    if (ok) {
      await this.rl.reset(subject);
      return;
    }
    await this.failed(user, method, ip);
  }

  /** Shared failure path (also used by passkey verification). */
  async failed(user: { id: string; email: string; role: RoleName }, method: string, ip: string): Promise<never> {
    const r = await this.rl.fail(`mfa:${user.id}`);
    await this.audit.log({ actor: { id: user.id, role: user.role, ip }, action: 'MFA_FAILED', entity: 'user_account', entity_id: user.id, meta: { method, failures: r.failures, locked: r.locked } });
    if (r.locked) {
      await this.audit.log({ actor: { id: user.id, role: user.role, ip }, action: 'MFA_LOCKOUT', entity: 'user_account', entity_id: user.id, meta: { alert: true } });
      await this.mail.send(user.email, 'Security alert: sign-in locked', 'There were 5 failed second-factor attempts on your NFSU Placement Portal account, so sign-in is locked for 15 minutes. If this was not you, contact the Placement Cell.');
      throw new HttpException({ message: 'Too many failed attempts. Sign-in is locked for 15 minutes.', code: 'LOCKED', retry_after: RateLimitService.LOCKOUT_SECONDS }, HttpStatus.TOO_MANY_REQUESTS);
    }
    throw new UnauthorizedException({ message: 'That code is not valid.', code: 'BAD_CODE' });
  }
}
