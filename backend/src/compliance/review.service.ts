import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../common/prisma.service';
import { AuditService } from '../common/audit.service';
import { Actor } from '../common/types';
import { text } from '../common/zod.pipe';
import { FiredRule } from '../policy/engine';
import { EngineService } from '../policy/engine.service';
import { ExceptionsService } from './exceptions.service';

export const resolveSchema = z
  .object({
    action: z.enum(['approve', 'confirm_block', 'resolve']),
    reason: text(400).pipe(z.string().min(10, 'Write a reason (at least 10 characters)')),
    expires_at: z.coerce.date().optional(),
  })
  .strict();

/**
 * The Officer's review queue: REVIEW decisions, absenteeism flags, suspected violations and expired offers.
 * The officer approves an exception or confirms the block, always with a written reason.
 */
@Injectable()
export class ReviewService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly engine: EngineService,
    private readonly exceptions: ExceptionsService,
  ) {}

  async list(actor: Actor, status: 'open' | 'closed') {
    const cases = await this.db.run(actor, (tx) =>
      tx.review_case.findMany({ where: status === 'open' ? { status: 'open' } : { status: { not: 'open' } }, orderBy: { opened_at: status === 'open' ? 'asc' : 'desc' }, take: 300 }),
    );
    const studentIds = [...new Set(cases.map((c) => c.student_id).filter((x): x is string => !!x))];
    const students = await this.db.run(actor, (tx) => tx.student.findMany({ where: { id: { in: studentIds } }, include: { programme: true } }));
    const sm = new Map(students.map((s) => [s.id, s]));

    // Missing NOCs are derived live (they are a fact about an offer, not an event).
    const nocs =
      status === 'open'
        ? await this.db.run(actor, (tx) =>
            tx.$queryRaw<{ offer_id: string; student_id: string; student_name: string; placement_id: string; programme_code: string; company: string; offer_date: Date }[]>`
              SELECT offer_id, student_id, student_name, placement_id, programme_code, company, offer_date
              FROM offer_current_v WHERE off_campus AND noc_status = 'pending' AND acceptance_status = 'accepted' ORDER BY offer_date`,
          )
        : [];

    return [
      ...cases.map((c) => {
        const s = c.student_id ? sm.get(c.student_id) : undefined;
        return {
          id: c.id,
          kind: c.kind,
          status: c.status,
          opened_at: c.opened_at,
          resolved_at: c.resolved_at,
          resolution_reason: c.resolution_reason,
          summary: (c.payload as { summary?: string }).summary ?? c.kind,
          fired_rules: (c.payload as { fired_rules?: FiredRule[] }).fired_rules ?? null,
          student: s ? { id: s.id, name: s.name, placement_id: s.placement_id, programme_code: s.programme.code } : null,
        };
      }),
      ...nocs.map((n) => ({
        id: `noc:${n.offer_id}`,
        kind: 'missing_noc' as const,
        status: 'open' as const,
        opened_at: n.offer_date,
        resolved_at: null,
        resolution_reason: null,
        summary: `Off-campus offer from ${n.company} has no NOC on record`,
        fired_rules: null,
        student: { id: n.student_id, name: n.student_name, placement_id: n.placement_id, programme_code: n.programme_code },
      })),
    ];
  }

  async resolve(actor: Actor, id: string, dto: z.infer<typeof resolveSchema>) {
    const c = await this.db.run(actor, (tx) => tx.review_case.findUnique({ where: { id } }));
    if (!c) throw new NotFoundException('Case not found');
    if (c.status !== 'open') throw new ConflictException({ message: 'This case is already closed.', code: 'BAD_STATE' });

    let detail: Record<string, unknown> = {};
    let status: 'approved' | 'blocked' | 'resolved' = dto.action === 'approve' ? 'approved' : dto.action === 'confirm_block' ? 'blocked' : 'resolved';

    if (c.kind === 'engine_review') {
      if (!c.application_id || !c.student_id || !c.ref_id) throw new BadRequestException('Malformed case');
      if (dto.action === 'approve') {
        // Approve = record an exception for each rule that asked for review, then re-run the engine.
        const rules = ((c.payload as { fired_rules?: FiredRule[] }).fired_rules ?? []).filter((f) => f.outcome === 'REVIEW').map((f) => f.code);
        const expires = dto.expires_at ?? new Date(Date.now() + 30 * 86_400_000);
        for (const rule_code of [...new Set(rules)]) await this.exceptions.create(actor, { student_id: c.student_id, rule_code, reason: `Review approved: ${dto.reason}`.slice(0, 400), expires_at: expires });
        const re = await this.db.run(actor, async (tx) => {
          const r = await this.engine.evaluateOne(tx, c.student_id!, c.ref_id!, 'review');
          if (r.decision.result === 'ALLOW') await tx.application.update({ where: { id: c.application_id! }, data: { stage: 'applied', engine_decision_id: r.decision_id } });
          return r;
        });
        detail = { reevaluated: re.decision.result };
        if (re.decision.result !== 'ALLOW') throw new ConflictException({ message: `Approving did not clear the application: ${re.decision.summary}`, code: 'STILL_BLOCKED' });
      } else if (dto.action === 'confirm_block') {
        await this.db.run(actor, (tx) => tx.application.update({ where: { id: c.application_id! }, data: { stage: 'rejected' } }));
      }
    } else if (c.kind === 'absenteeism') {
      if (dto.action === 'approve') {
        if (!c.student_id) throw new BadRequestException('Malformed case');
        await this.exceptions.create(actor, { student_id: c.student_id, rule_code: 'R4', reason: `Emergency absence approved: ${dto.reason}`.slice(0, 400), expires_at: dto.expires_at ?? new Date(Date.now() + 30 * 86_400_000) });
      }
    } else if (dto.action === 'approve') {
      throw new BadRequestException({ message: 'Only review decisions and absenteeism flags can be approved. Use "Confirm block" or "Resolve".', code: 'BAD_ACTION' });
    }

    await this.db.run(actor, async (tx) => {
      await tx.review_case.update({ where: { id }, data: { status, resolved_by: actor.id, resolved_at: new Date(), resolution_reason: dto.reason } });
      await this.audit.log({ actor, action: `REVIEW_${dto.action.toUpperCase()}`, entity: 'review_case', entity_id: id, meta: { kind: c.kind, student_id: c.student_id, reason: dto.reason, ...detail } }, tx);
    });
    return { status };
  }

  async counts(actor: Actor) {
    const rows = await this.db.run(actor, (tx) => tx.review_case.groupBy({ by: ['kind'], where: { status: 'open' }, _count: true }));
    return Object.fromEntries(rows.map((r) => [r.kind, r._count]));
  }

  assertStaff(actor: Actor) {
    if (!['officer', 'admin', 'coordinator'].includes(actor.role)) throw new ForbiddenException();
  }
}
