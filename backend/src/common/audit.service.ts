import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService, Tx } from './prisma.service';
import { CryptoService } from './crypto.service';
import { Actor } from './types';

export interface AuditEntry {
  actor?: Pick<Actor, 'id' | 'role' | 'ip'> | null;
  action: string;
  entity?: string;
  entity_id?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
  ip?: string;
}

export const GENESIS_HASH = '0'.repeat(64);
const CHAIN_LOCK_ID = 727_001;

/** Stable JSON: keys sorted at every level, so the hash does not depend on key order (jsonb reorders keys). */
export function canonical(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

const roundTrip = (v: unknown) => (v === undefined ? null : JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))));

/**
 * Append-only, hash-chained audit log (architecture doc, sections 6 and 8).
 *   hash = HMAC-SHA256(key, prev_hash || canonical(entry))
 * The HMAC key is not in the database, so someone who edits a row with direct DB access cannot recompute the chain
 * to hide the edit. The app role has INSERT/SELECT only; UPDATE and DELETE are revoked in the security migration.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /** Pass `tx` to make the audit row commit atomically with the change it describes. */
  async log(e: AuditEntry, tx?: Tx): Promise<void> {
    if (tx) return this.append(tx, e);
    await this.prisma.$transaction((t) => this.append(t, e));
  }

  private async append(tx: Tx, e: AuditEntry) {
    // Serialise chain appends: one writer at a time keeps the chain linear.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CHAIN_LOCK_ID})`;
    const last = await tx.audit_log.findFirst({ orderBy: { id: 'desc' }, select: { hash: true } });
    const prev_hash = last?.hash ?? GENESIS_HASH;
    const at = new Date();
    const row = {
      actor_id: e.actor?.id && e.actor.id !== '00000000-0000-0000-0000-000000000000' ? e.actor.id : null,
      role: e.actor?.role ?? null,
      action: e.action,
      entity: e.entity ?? null,
      entity_id: e.entity_id ?? null,
      before_json: roundTrip(e.before),
      after_json: roundTrip(e.after),
      meta: roundTrip(e.meta),
      ip: e.ip ?? e.actor?.ip ?? null,
      at,
    };
    const hash = this.hashRow(prev_hash, row);
    await tx.audit_log.create({
      data: {
        ...row,
        before_json: row.before_json ?? Prisma.DbNull,
        after_json: row.after_json ?? Prisma.DbNull,
        meta: row.meta ?? Prisma.DbNull,
        prev_hash,
        hash,
      },
    });
  }

  hashRow(
    prev_hash: string,
    r: { actor_id: string | null; role: string | null; action: string; entity: string | null; entity_id: string | null; before_json: unknown; after_json: unknown; meta: unknown; ip: string | null; at: Date },
  ): string {
    return this.crypto.hmac(
      prev_hash +
        canonical({
          actor_id: r.actor_id,
          role: r.role,
          action: r.action,
          entity: r.entity,
          entity_id: r.entity_id,
          before_json: r.before_json ?? null,
          after_json: r.after_json ?? null,
          meta: r.meta ?? null,
          ip: r.ip,
          at: r.at.toISOString(),
        }),
      'audit',
    );
  }

  /** Walk the whole chain and report the first broken link (edit, delete, or reorder). */
  async verifyChain(): Promise<{ ok: boolean; checked: number; broken_at?: string; reason?: string }> {
    let prev = GENESIS_HASH;
    let checked = 0;
    let cursor = 0n;
    for (;;) {
      const rows = await this.prisma.audit_log.findMany({ where: { id: { gt: cursor } }, orderBy: { id: 'asc' }, take: 1000 });
      if (!rows.length) break;
      for (const r of rows) {
        if (r.prev_hash !== prev) return { ok: false, checked, broken_at: r.id.toString(), reason: 'previous-hash mismatch (a row was deleted, inserted or reordered)' };
        const expect = this.hashRow(r.prev_hash, {
          actor_id: r.actor_id,
          role: r.role,
          action: r.action,
          entity: r.entity,
          entity_id: r.entity_id,
          before_json: r.before_json,
          after_json: r.after_json,
          meta: r.meta,
          ip: r.ip,
          at: r.at,
        });
        if (expect !== r.hash) return { ok: false, checked, broken_at: r.id.toString(), reason: 'row content does not match its hash (the row was edited)' };
        prev = r.hash;
        cursor = r.id;
        checked++;
      }
    }
    return { ok: true, checked };
  }
}
