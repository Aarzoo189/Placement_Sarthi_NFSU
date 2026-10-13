import { Injectable } from '@nestjs/common';
import { Response } from 'express';
import { RedisService } from '../common/redis.service';
import { CryptoService } from '../common/crypto.service';
import { PrismaService } from '../common/prisma.service';
import { SESSION_POLICY, SessionData, SessionStage, STEP_UP_WINDOW_MS } from '../common/types';
import { env, isProd } from '../config/env';

/** Cookie name: the `__Host-` prefix pins the cookie to this host, forces Secure + Path=/ and forbids a Domain. */
export const SESSION_COOKIE = env.COOKIE_SECURE ? '__Host-sid' : 'sid';
export const DEVICE_COOKIE = env.COOKIE_SECURE ? '__Host-dev' : 'dev';
export const TRUST_COOKIE = env.COOKIE_SECURE ? '__Host-trust' : 'trust';

const PRE_AUTH_TTL_MS = 10 * 60_000;

/**
 * Server-side sessions (architecture doc, section 4).
 *   - Cookie holds an opaque 256-bit random id. HttpOnly, SameSite=Strict, Secure outside local dev.
 *   - Redis holds the session under sha256(id), so neither a Redis dump nor the DB mirror yields a usable cookie.
 *   - Id is rotated at login and at step-up; every session of a user is revoked on password/MFA change.
 *   - Idle timeout is a sliding Redis TTL; the absolute timeout is checked on every read.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    private readonly prisma: PrismaService,
  ) {}

  private key(hashedId: string) {
    return `sess:${hashedId}`;
  }

  async create(
    user: { id: string; email: string; name: string; role: SessionData['role']; programme_ids?: string[]; company_id?: string },
    stage: SessionStage,
    meta: { ip: string; user_agent: string },
    carry?: Partial<Pick<SessionData, 'step_up_at' | 'scratch'>>,
  ): Promise<{ token: string; data: SessionData }> {
    const token = this.crypto.token(32);
    const id = this.crypto.sha256(token);
    const now = Date.now();
    const data: SessionData = {
      id,
      user_id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      programme_ids: user.programme_ids,
      company_id: user.company_id,
      stage,
      csrf: this.crypto.token(24),
      created_at: now,
      last_seen: now,
      step_up_at: carry?.step_up_at ?? null,
      ip: meta.ip,
      user_agent: meta.user_agent.slice(0, 300),
      scratch: carry?.scratch,
    };
    await this.save(data);
    await this.redis.sadd(`usess:${user.id}`, id);
    await this.redis.expire(`usess:${user.id}`, 24 * 3600);
    if (stage === 'full') {
      await this.prisma.session
        .create({ data: { id, user_id: user.id, ip: meta.ip, user_agent: data.user_agent, expires_at: new Date(now + SESSION_POLICY[user.role].absoluteMs) } })
        .catch(() => undefined);
    }
    return { token, data };
  }

  private ttlMs(d: SessionData) {
    return d.stage === 'full' ? SESSION_POLICY[d.role].idleMs : PRE_AUTH_TTL_MS;
  }

  private save(d: SessionData) {
    return this.redis.set(this.key(d.id), JSON.stringify(d), 'PX', this.ttlMs(d));
  }

  /** Load by cookie value; applies the absolute timeout and slides the idle timeout. */
  async get(token: string | undefined): Promise<SessionData | null> {
    if (!token || token.length < 20 || token.length > 200) return null;
    const id = this.crypto.sha256(token);
    const raw = await this.redis.get(this.key(id));
    if (!raw) return null;
    const d = JSON.parse(raw) as SessionData;
    const now = Date.now();
    const absolute = d.stage === 'full' ? SESSION_POLICY[d.role].absoluteMs : PRE_AUTH_TTL_MS;
    if (now - d.created_at > absolute) {
      await this.destroyById(id, d.user_id);
      return null;
    }
    // Only rewrite when the last write is older than 15 s to keep Redis traffic low; always extend the TTL.
    if (now - d.last_seen > 15_000) {
      d.last_seen = now;
      await this.save(d);
    } else {
      await this.redis.pexpire(this.key(id), this.ttlMs(d));
    }
    return d;
  }

  async update(d: SessionData) {
    await this.save(d);
  }

  /** Issue a new cookie value for the same session (login, step-up, stage change). The old value stops working. */
  async rotate(old: SessionData, patch: Partial<SessionData> = {}): Promise<{ token: string; data: SessionData }> {
    const { token, data } = await this.create(
      {
        id: old.user_id,
        email: old.email,
        name: old.name,
        role: old.role,
        programme_ids: patch.programme_ids ?? old.programme_ids,
        company_id: patch.company_id ?? old.company_id,
      },
      patch.stage ?? old.stage,
      { ip: old.ip, user_agent: old.user_agent },
      { step_up_at: patch.step_up_at !== undefined ? patch.step_up_at : old.step_up_at, scratch: patch.scratch },
    );
    await this.destroyById(old.id, old.user_id);
    return { token, data };
  }

  markStepUp(d: SessionData) {
    return this.rotate(d, { step_up_at: Date.now() });
  }

  hasFreshStepUp(d: SessionData): boolean {
    return d.step_up_at != null && Date.now() - d.step_up_at <= STEP_UP_WINDOW_MS;
  }

  async destroyById(hashedId: string, userId: string) {
    await this.redis.del(this.key(hashedId));
    await this.redis.srem(`usess:${userId}`, hashedId);
    await this.prisma.session.updateMany({ where: { id: hashedId, revoked_at: null }, data: { revoked_at: new Date() } }).catch(() => undefined);
  }

  async destroy(token: string | undefined) {
    if (!token) return;
    const id = this.crypto.sha256(token);
    const raw = await this.redis.get(this.key(id));
    if (!raw) return;
    await this.destroyById(id, (JSON.parse(raw) as SessionData).user_id);
  }

  /** "Log out all devices", and the response to a password / MFA change or an account being disabled. */
  async destroyAll(userId: string, exceptHashedId?: string): Promise<number> {
    const ids = (await this.redis.smembers(`usess:${userId}`)).filter((i) => i !== exceptHashedId);
    if (ids.length) {
      await this.redis.del(...ids.map((i) => this.key(i)));
      await this.redis.srem(`usess:${userId}`, ...ids);
    }
    await this.prisma.session.updateMany({ where: { user_id: userId, revoked_at: null, ...(exceptHashedId ? { id: { not: exceptHashedId } } : {}) }, data: { revoked_at: new Date() } }).catch(() => undefined);
    return ids.length;
  }

  setCookie(res: Response, token: string) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: env.COOKIE_SECURE || isProd,
      sameSite: 'strict',
      path: '/',
      // Session cookie (no Max-Age): gone when the browser closes; the server enforces idle + absolute timeouts.
    });
  }

  clearCookie(res: Response) {
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: env.COOKIE_SECURE || isProd, sameSite: 'strict', path: '/' });
  }
}
