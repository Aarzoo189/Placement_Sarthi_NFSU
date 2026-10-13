import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * Redis-backed counters used for login / OTP lockout (5 failures -> 15-minute lockout) and a coarse per-IP limiter.
 * Keys expire on their own, so there is nothing to clean up.
 */
@Injectable()
export class RateLimitService {
  static readonly MAX_FAILURES = 5;
  static readonly LOCKOUT_SECONDS = 15 * 60;

  constructor(private readonly redis: RedisService) {}

  /** Seconds left on a lockout, or 0 when not locked. */
  async lockedFor(subject: string): Promise<number> {
    const ttl = await this.redis.ttl(`lock:${subject}`);
    return ttl > 0 ? ttl : 0;
  }

  /** Record a failure. Returns true when this failure triggered a lockout. */
  async fail(subject: string): Promise<{ locked: boolean; failures: number }> {
    const key = `fail:${subject}`;
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, RateLimitService.LOCKOUT_SECONDS);
    if (n >= RateLimitService.MAX_FAILURES) {
      await this.redis.set(`lock:${subject}`, '1', 'EX', RateLimitService.LOCKOUT_SECONDS);
      await this.redis.del(key);
      return { locked: true, failures: n };
    }
    return { locked: false, failures: n };
  }

  async reset(subject: string) {
    await this.redis.del(`fail:${subject}`, `lock:${subject}`);
  }

  /** Fixed-window limiter for a bucket (e.g. one IP on /auth/*). Throws 429 when exceeded. */
  async hit(bucket: string, limit: number, windowSeconds: number) {
    const key = `rl:${bucket}`;
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, windowSeconds);
    if (n > limit) {
      const ttl = await this.redis.ttl(key);
      throw new HttpException({ message: 'Too many requests', retry_after: Math.max(ttl, 1) }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
