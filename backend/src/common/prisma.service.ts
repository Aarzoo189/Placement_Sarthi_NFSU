import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { Actor } from './types';

export type Tx = Prisma.TransactionClient;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}

/**
 * Every data access that touches student/offer/application/attendance/... goes through `run`.
 *
 * `run` opens a transaction and sets two transaction-local settings (`app.user_id`, `app.role`). PostgreSQL row-level
 * security policies read them, so the database enforces role -> scope even if a service forgets a check
 * (architecture doc, section 8: "PostgreSQL row-level security as a second layer").
 *
 * `set_config(..., true)` is transaction-local, so a pooled connection never leaks one request's identity into the next.
 */
@Injectable()
export class DbService {
  constructor(readonly prisma: PrismaService) {}

  run<T>(actor: Actor, fn: (tx: Tx) => Promise<T>, opts?: { timeout?: number }): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.user_id', ${actor.id}, true), set_config('app.role', ${actor.role}, true)`;
        return fn(tx);
      },
      { timeout: opts?.timeout ?? 20_000, maxWait: 10_000 },
    );
  }
}

/** Identity used by background jobs (deadline expiry, reminders). Allowed by the `system` branch of each RLS policy. */
export const SYSTEM_ACTOR: Actor = { id: '00000000-0000-0000-0000-000000000000', role: 'system' };
