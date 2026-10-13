import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { env } from '../config/env';

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  constructor() {
    super(env.REDIS_URL, { maxRetriesPerRequest: 3, enableReadyCheck: true });
  }
  async onModuleDestroy() {
    await this.quit().catch(() => undefined);
  }
}

export const redisConnectionOptions = () => {
  const u = new URL(env.REDIS_URL);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password ? decodeURIComponent(u.password) : undefined,
    username: u.username || undefined,
    maxRetriesPerRequest: null as null, // required by BullMQ workers
  };
};
