import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../common/prisma.service';
import { AuditService } from '../common/audit.service';
import { Actor } from '../common/types';
import { text } from '../common/zod.pipe';
import { RULE_CODES, RULE_TITLES } from '../policy/engine';
import { EngineService } from '../policy/engine.service';

const rule = z.enum(RULE_CODES as [string, ...string[]]);
const reason = text(400).pipe(z.string().min(10, 'Give a written reason (at least 10 characters)'));

export const createExceptionSchema = z.object({ student_id: z.string().uuid(), rule_code: rule, reason, expires_at: z.coerce.date() }).strict();
export const requestExceptionSchema = z.object({ student_id: z.string().uuid(), rule_code: rule, reason }).strict();
export const decideRequestSchema = z.object({ approve: z.boolean(), expires_at: z.coerce.date().optional(), note: text(300).optional() }).strict();

const MAX_DAYS = 365;

/**
 * Exceptions (policy overrides). Only a Placement Officer or Admin can record one, always with a reason and an expiry.
 * A coordinator can only REQUEST one; the engine then shows "ALLOW (exception #id)". Final disciplinary decisions stay with the Placement Cell.
 */
@Injectable()
export class ExceptionsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly engine: EngineService,
  ) {}

  private checkExpiry(d: Date) {
    const now = Date.now();
    if (d.getTime() <= now) throw new BadRequestException({ message: 'The expiry must be in the future.', code: 'BAD_EXPIRY' });
    if (d.getTime() > now + MAX_DAYS * 86_400_000) throw new BadRequestException({ message: `An exception can last at most ${MAX_DAYS} days.`, code: 'BAD_EXPIRY' });
  }

  async create(actor: Actor, dto: z.infer<typeof createExceptionSchema>, requestId?: string) {
    this.checkExpiry(dto.expires_at);
    const created = await this.db.run(actor, async (tx) => {
      const s = await tx.student.findFirst({ where: { id: dto.student_id }, select: { id: true } });
      if (!s) throw new NotFoundException('Student not found');
      const e = await tx.exception.create({ data: { student_id: dto.student_id, rule_code: dto.rule_code, reason: dto.reason, approved_by: actor.id, expires_at: dto.expires_at } });
      await this.audit.log({ actor, action: 'EXCEPTION_RECORDED', entity: 'exception', entity_id: e.id, after: { student_id: dto.student_id, rule_code: dto.rule_code, expires_at: dto.expires_at }, meta: { reason: dto.reason, request_id: requestId } }, tx);
      return e;
    });
    await this.engine.recomputeState(dto.student_id);
    return { id: created.id };
  }

  async revoke(actor: Actor, id: string, why: string) {
    await this.db.run(actor, async (tx) => {
      const e = await tx.exception.findUnique({ where: { id } });
      if (!e || e.revoked_at) throw new NotFoundException('No active exception with this id');
      await tx.exception.update({ where: { id }, data: { revoked_at: new Date() } });
      await this.audit.log({ actor, action: 'EXCEPTION_REVOKED', entity: 'exception', entity_id: id, meta: { reason: why } }, tx);
    });
  }

  async list(actor: Actor) {
    const rows = await this.db.run(actor, (tx) => tx.exception.findMany({ include: { student: { include: { programme: true } } }, orderBy: { created_at: 'desc' }, take: 300 }));
    const now = Date.now();
    return rows.map((e) => ({
      id: e.id,
      rule_code: e.rule_code,
      rule: RULE_TITLES[e.rule_code as keyof typeof RULE_TITLES] ?? e.rule_code,
      reason: e.reason,
      expires_at: e.expires_at,
      revoked_at: e.revoked_at,
      active: !e.revoked_at && e.expires_at.getTime() > now,
      approved_by: e.approved_by,
      student: { id: e.student.id, placement_id: e.student.placement_id, name: e.student.name, programme_code: e.student.programme.code },
    }));
  }

  /** Active exceptions for one student: used when a coordinator marks an excused absence. */
  async activeFor(actor: Actor, studentId: string) {
    const rows = await this.db.run(actor, (tx) => tx.exception.findMany({ where: { student_id: studentId, revoked_at: null, expires_at: { gt: new Date() } }, orderBy: { expires_at: 'asc' } }));
    return rows.map((e) => ({ id: e.id, rule_code: e.rule_code, reason: e.reason, expires_at: e.expires_at }));
  }

  // ------------------------------------------------------------------ requests ----

  async request(actor: Actor, dto: z.infer<typeof requestExceptionSchema>) {
    const ok = await this.db.run(actor, (tx) => tx.student.findFirst({ where: { id: dto.student_id }, select: { id: true } }));
    if (!ok) throw new ForbiddenException({ message: 'Student not found or not in your scope.', code: 'OUT_OF_SCOPE' });
    const r = await this.db.prisma.exception_request.create({ data: { student_id: dto.student_id, rule_code: dto.rule_code, reason: dto.reason, requested_by: actor.id } });
    await this.audit.log({ actor, action: 'EXCEPTION_REQUESTED', entity: 'exception_request', entity_id: r.id, meta: { student_id: dto.student_id, rule_code: dto.rule_code } });
    return { id: r.id };
  }

  async listRequests(actor: Actor) {
    const rows = await this.db.prisma.exception_request.findMany({ where: { status: 'pending', ...(actor.role === 'coordinator' ? { requested_by: actor.id } : {}) }, orderBy: { created_at: 'asc' }, take: 200 });
    const students = await this.db.run({ ...actor, role: actor.role === 'coordinator' ? 'coordinator' : actor.role }, (tx) => tx.student.findMany({ where: { id: { in: rows.map((r) => r.student_id) } }, include: { programme: true } }));
    const sm = new Map(students.map((s) => [s.id, s]));
    return rows.map((r) => ({ id: r.id, rule_code: r.rule_code, reason: r.reason, requested_by: r.requested_by, requested_at: r.created_at, student: sm.get(r.student_id) ? { id: r.student_id, name: sm.get(r.student_id)!.name, placement_id: sm.get(r.student_id)!.placement_id, programme_code: sm.get(r.student_id)!.programme.code } : null }));
  }

  async decide(actor: Actor, id: string, dto: z.infer<typeof decideRequestSchema>) {
    const r = await this.db.prisma.exception_request.findUnique({ where: { id } });
    if (!r || r.status !== 'pending') throw new ConflictException({ message: 'This request is not pending.', code: 'BAD_STATE' });
    if (!dto.approve) {
      await this.db.prisma.exception_request.update({ where: { id }, data: { status: 'rejected', decided_by: actor.id, decided_at: new Date() } });
      await this.audit.log({ actor, action: 'EXCEPTION_REQUEST_REJECTED', entity: 'exception_request', entity_id: id, meta: { note: dto.note } });
      return { approved: false };
    }
    const expires_at = dto.expires_at ?? new Date(Date.now() + 30 * 86_400_000);
    const e = await this.create(actor, { student_id: r.student_id, rule_code: r.rule_code, reason: `${r.reason} (requested by coordinator; ${dto.note ?? 'approved'})`.slice(0, 400), expires_at }, id);
    await this.db.prisma.exception_request.update({ where: { id }, data: { status: 'approved', decided_by: actor.id, decided_at: new Date(), exception_id: e.id } });
    return { approved: true, exception_id: e.id };
  }
}
