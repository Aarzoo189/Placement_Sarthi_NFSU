import { Injectable, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { BullModule, InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { appendFile, mkdir } from 'fs/promises';
import { resolve } from 'path';
import { redisConnectionOptions, RedisService } from '../common/redis.service';
import { DbService, PrismaService, SYSTEM_ACTOR } from '../common/prisma.service';
import { AuditService } from '../common/audit.service';
import { EngineService } from '../policy/engine.service';
import { OffersService } from '../offers/offers.service';
import { env } from '../config/env';
import { DomainModule } from '../domain.module';

const QUEUE = 'maintenance';

/** Scheduled work (architecture doc: "Redis + BullMQ: deadline expiry, reminders"). All jobs are idempotent. */
@Processor(QUEUE)
export class MaintenanceProcessor extends WorkerHost {
  private readonly log = new Logger('Jobs');

  constructor(
    private readonly offers: OffersService,
    private readonly engine: EngineService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case 'expire-offers':
        return this.offers.expireDue();
      case 'remind-offers':
        return this.offers.remindDue(this.redis as never);
      case 'recompute-state':
        return this.engine.recomputeAll();
      case 'archive-audit':
        return this.archiveAudit();
      case 'purge':
        return this.purge();
      case 'retention':
        return this.retention();
      default:
        this.log.warn(`Unknown job ${job.name}`);
    }
  }

  /**
   * Copy new audit rows to an append-only file. Prototype stand-in for a write-once (object-lock) bucket: even if the table is
   * later tampered with, the archive holds the original rows and their hashes.
   */
  private async archiveAudit(): Promise<number> {
    const cursorKey = 'audit-archive:last-id';
    const last = BigInt((await this.redis.get(cursorKey)) ?? '0');
    const rows = await this.prisma.audit_log.findMany({ where: { id: { gt: last } }, orderBy: { id: 'asc' }, take: 2000 });
    if (!rows.length) return 0;
    const dir = resolve(env.AUDIT_ARCHIVE_DIR);
    await mkdir(dir, { recursive: true });
    const byDay = new Map<string, string[]>();
    for (const r of rows) {
      const day = r.at.toISOString().slice(0, 10);
      byDay.set(day, [...(byDay.get(day) ?? []), JSON.stringify({ ...r, id: r.id.toString() })]);
    }
    for (const [day, lines] of byDay) await appendFile(resolve(dir, `audit-${day}.jsonl`), lines.join('\n') + '\n', { flag: 'a' });
    await this.redis.set(cursorKey, rows[rows.length - 1].id.toString());
    return rows.length;
  }

  /** Housekeeping: session mirror rows and expired activation links / trusted devices. */
  private async purge() {
    const old = new Date(Date.now() - 30 * 86_400_000);
    const [s, d, a] = await Promise.all([
      this.prisma.session.deleteMany({ where: { expires_at: { lt: old } } }),
      this.prisma.trusted_device.deleteMany({ where: { expires_at: { lt: new Date() } } }),
      this.prisma.user_account.updateMany({ where: { status: 'invited', activation_expires: { lt: new Date() } }, data: { activation_token_hash: null } }),
    ]);
    return { sessions: s.count, devices: d.count, activations: a.count };
  }

  /** Retention: archive students once their batch is older than the configured retention (logged). */
  private async retention() {
    const setting = await this.prisma.system_setting.findUnique({ where: { key: 'retention_years' } });
    const years = Number(setting?.value_json ?? 3);
    const cutoffBatch = new Date().getFullYear() - years;
    const n = await this.db.run(SYSTEM_ACTOR, async (tx) => {
      const r = await tx.student.updateMany({ where: { archived_at: null, batch: { lt: cutoffBatch } }, data: { archived_at: new Date() } });
      if (r.count) await this.audit.log({ actor: SYSTEM_ACTOR, action: 'RETENTION_ARCHIVED', entity: 'student', meta: { count: r.count, batch_before: cutoffBatch, retention_years: years } }, tx);
      return r.count;
    });
    return n;
  }
}

@Injectable()
export class JobScheduler implements OnApplicationBootstrap {
  private readonly log = new Logger('Scheduler');
  constructor(@InjectQueue(QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap() {
    if (process.env.NODE_ENV === 'test' && process.env.ENABLE_JOBS !== 'true') return;
    const every = (name: string, ms: number) => this.queue.upsertJobScheduler(name, { every: ms }, { name, opts: { removeOnComplete: 20, removeOnFail: 50 } });
    await every('expire-offers', 60_000);
    await every('remind-offers', 15 * 60_000);
    await every('archive-audit', 30_000);
    await every('recompute-state', 30 * 60_000);
    await every('purge', 6 * 3600_000);
    await every('retention', 24 * 3600_000);
    this.log.log('Scheduled: expire-offers 1m, remind-offers 15m, archive-audit 30s, recompute-state 30m, purge 6h, retention 24h');
  }
}

@Module({
  imports: [DomainModule, BullModule.forRoot({ connection: redisConnectionOptions() }), BullModule.registerQueue({ name: QUEUE })],
  providers: [MaintenanceProcessor, JobScheduler],
})
export class JobsModule {}
