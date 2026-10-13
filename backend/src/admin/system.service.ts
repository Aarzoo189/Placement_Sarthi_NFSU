import { Injectable } from '@nestjs/common';
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { resolve } from 'path';
import { z } from 'zod';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { CryptoService } from '../common/crypto.service';
import { AuditService } from '../common/audit.service';
import { Actor } from '../common/types';
import { text } from '../common/zod.pipe';
import { env } from '../config/env';

export const settingsSchema = z
  .object({
    retention_years: z.number().int().min(1).max(15),
    session_alert_email: z.string().email().max(200).optional(),
    maintenance_banner: text(200).optional(),
  })
  .strict();
export const drillSchema = z
  .object({
    backup_file: z.string().trim().min(3).max(200),
    result: z.enum(['success', 'failed']),
    notes: text(600).pipe(z.string().min(10, 'Write a short record of the drill (at least 10 characters)')),
  })
  .strict();

const DEFAULTS = { retention_years: 3, session_alert_email: '', maintenance_banner: '' };

/**
 * Platform tasks owned by the Super Admin: system settings, key information, backup inventory and the monthly restore-drill record.
 * The Super Admin does not edit student or offer data.
 */
@Injectable()
export class SystemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  async settings() {
    const rows = await this.prisma.system_setting.findMany();
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value_json]));
    return { ...DEFAULTS, ...m };
  }

  async updateSettings(actor: Actor, dto: z.infer<typeof settingsSchema>) {
    const before = await this.settings();
    for (const [key, value] of Object.entries(dto)) {
      await this.prisma.system_setting.upsert({ where: { key }, create: { key, value_json: value as never, updated_by: actor.id }, update: { value_json: value as never, updated_by: actor.id } });
    }
    await this.audit.log({ actor, action: 'SYSTEM_SETTINGS_CHANGED', entity: 'system_setting', before, after: dto });
    return this.settings();
  }

  /** Health and key information for the Super Admin console. Never returns key material, only fingerprints. */
  async status() {
    const [db, redis, drill, offers] = await Promise.all([
      this.prisma.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`.then(() => true).catch(() => false),
      this.redis.ping().then((p) => p === 'PONG').catch(() => false),
      this.prisma.system_setting.findUnique({ where: { key: 'last_restore_drill' } }),
      this.prisma.audit_log.count(),
    ]);
    return {
      database: db ? 'up' : 'down',
      redis: redis ? 'up' : 'down',
      audit_entries: offers,
      encryption: { algorithm: 'AES-256-GCM (column level)', key_version: 'v1', key_fingerprint: this.crypto.sha256(Buffer.from(env.DATA_KEY, 'base64')).slice(0, 12), source: env.NODE_ENV === 'production' ? 'KMS / Vault expected' : 'environment variable (prototype only)' },
      mfa_policy: { allow_totp_for_privileged: env.ALLOW_TOTP_FOR_PRIVILEGED, superadmin_networks: env.SUPERADMIN_ALLOWED_CIDRS.split(',').map((s) => s.trim()) },
      last_restore_drill: drill?.value_json ?? null,
    };
  }

  /** Inventory of encrypted backup files (produced by scripts/backup.sh). */
  backups() {
    const dir = resolve(env.BACKUP_DIR);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const cutoff = Date.now() - 30 * 86_400_000;
    const files = readdirSync(dir)
      .filter((f) => /\.(enc|gpg|dump)$/.test(f))
      .map((f) => ({ name: f, bytes: statSync(resolve(dir, f)).size, modified: statSync(resolve(dir, f)).mtime }))
      .sort((a, b) => b.modified.getTime() - a.modified.getTime());
    return { directory: env.BACKUP_DIR, retention_days: 30, files: files.map((f) => ({ ...f, past_retention: f.modified.getTime() < cutoff })) };
  }

  async recordDrill(actor: Actor, dto: z.infer<typeof drillSchema>) {
    const value = { ...dto, at: new Date().toISOString(), by: actor.id };
    await this.prisma.system_setting.upsert({ where: { key: 'last_restore_drill' }, create: { key: 'last_restore_drill', value_json: value, updated_by: actor.id }, update: { value_json: value, updated_by: actor.id } });
    await this.audit.log({ actor, action: 'RESTORE_DRILL_RECORDED', entity: 'system_setting', entity_id: 'last_restore_drill', meta: dto });
    return value;
  }
}
