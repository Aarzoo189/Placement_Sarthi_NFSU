import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { DbService, SYSTEM_ACTOR } from '../common/prisma.service';
import { AuditService } from '../common/audit.service';
import { CryptoService } from '../common/crypto.service';
import { MailService } from '../common/mail.service';
import { Actor } from '../common/types';
import { text } from '../common/zod.pipe';
import { categoryFor, computeDeadline } from '../policy/engine';
import { CTC_AAD, EngineService, STIPEND_AAD, catFromDb, catToDb } from '../policy/engine.service';
import { PolicyService } from '../policy/policy.service';

export const proposeSchema = z
  .object({
    drive_id: z.string().uuid(),
    student_id: z.string().uuid(),
    ctc_lpa: z.number().positive().max(1000).nullable().optional(),
    stipend_amount: z.number().min(0).max(10_000_000).nullable().optional(),
    note: text(300).optional(),
  })
  .strict();

export const directOfferSchema = z
  .object({
    student_id: z.string().uuid(),
    type: z.enum(['I', 'F', 'IF']),
    drive_id: z.string().uuid().nullable().optional(),
    off_campus_company: text(120).optional(),
    ctc_lpa: z.number().positive().max(1000).nullable().optional(),
    stipend_amount: z.number().min(0).max(10_000_000).nullable().optional(),
    noc_status: z.enum(['not_required', 'pending', 'received']).optional(),
    already_accepted: z.boolean().default(false),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (!d.drive_id && !d.off_campus_company) ctx.addIssue({ code: 'custom', path: ['off_campus_company'], message: 'Name the company for an off-campus offer' });
    if (d.type !== 'I' && d.ctc_lpa == null) ctx.addIssue({ code: 'custom', path: ['ctc_lpa'], message: 'FTE and I+F offers need a CTC' });
    if (d.type === 'I' && d.ctc_lpa != null) ctx.addIssue({ code: 'custom', path: ['ctc_lpa'], message: 'Internship-only offers carry a stipend, not a CTC' });
  });

export const respondSchema = z.object({ decision: z.enum(['accept', 'decline']) }).strict();
export const lifecycleSchema = z
  .object({
    field: z.enum(['joining_status', 'ppo_status', 'noc_status']),
    value: z.string().max(30),
    reason: text(300).optional(),
  })
  .strict();
export const correctSchema = z.object({ ctc_lpa: z.number().positive().max(1000), reason: text(300).pipe(z.string().min(10, 'Give a reason (at least 10 characters)')) }).strict();

const LIFECYCLE_VALUES: Record<string, string[]> = {
  joining_status: ['pending', 'joined', 'not_joined'],
  ppo_status: ['not_applicable', 'pending', 'confirmed', 'declined'],
  noc_status: ['not_required', 'pending', 'received'],
};

type OfferRow = Prisma.offerGetPayload<{ include: { student: { include: { programme: true } }; drive: { include: { company: true } } } }>;

@Injectable()
export class OffersService {
  private readonly log = new Logger('Offers');

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly mail: MailService,
    private readonly engine: EngineService,
    private readonly policy: PolicyService,
  ) {}

  private shape(o: OfferRow) {
    return {
      id: o.id,
      student: { id: o.student.id, placement_id: o.student.placement_id, name: o.student.name, programme_code: o.student.programme.code, batch: o.student.batch },
      drive_id: o.drive_id,
      company: o.drive?.company.name ?? o.off_campus_company,
      drive_title: o.drive?.title ?? null,
      off_campus: o.drive_id === null,
      type: o.type,
      category: catFromDb(o.category),
      ctc_lpa: this.crypto.decryptNumber(o.ctc_enc, CTC_AAD),
      stipend_amount: this.crypto.decryptNumber(o.stipend_enc, STIPEND_AAD),
      offer_date: o.offer_date,
      deadline: o.deadline,
      acceptance_status: o.acceptance_status,
      ppo_status: o.ppo_status,
      joining_status: o.joining_status,
      noc_status: o.noc_status,
      policy_version: o.policy_version,
    };
  }

  private readonly include = { student: { include: { programme: true } }, drive: { include: { company: true } } } as const;

  private scopeWhere(actor: Actor): Prisma.offerWhereInput {
    switch (actor.role) {
      case 'student':
        return { student: { user_id: actor.id } };
      case 'coordinator':
        return { student: { programme_id: { in: actor.programmeIds ?? [] } } };
      case 'hr':
        return { drive: { company_id: actor.companyId } };
      default:
        return {};
    }
  }

  async list(actor: Actor, q: { student_id?: string; status?: string }) {
    const rows = await this.db.run(actor, (tx) =>
      tx.offer.findMany({ where: { AND: [this.scopeWhere(actor), q.student_id ? { student_id: q.student_id } : {}, q.status ? { acceptance_status: q.status as never } : {}] }, include: this.include, orderBy: { offer_date: 'desc' }, take: 500 }),
    );
    if (actor.role !== 'student') await this.audit.log({ actor, action: 'OFFER_LIST_READ', entity: 'offer', meta: { count: rows.length } });
    return rows.map((r) => this.shape(r));
  }

  async events(actor: Actor, id: string) {
    const o = await this.db.run(actor, (tx) => tx.offer.findFirst({ where: { id, ...this.scopeWhere(actor) }, select: { id: true } }));
    if (!o) throw new ForbiddenException({ message: 'You do not have access to this offer.', code: 'OUT_OF_SCOPE' });
    const ev = await this.db.run(actor, (tx) => tx.offer_event.findMany({ where: { offer_id: id }, orderBy: { at: 'asc' } }));
    const money = new Set(['ctc', 'stipend']);
    return ev.map((e) => ({
      id: e.id,
      field: e.field,
      old_value: money.has(e.field) && e.old_value ? this.crypto.decrypt(e.old_value, `offer_event.${e.field}`) : e.old_value,
      new_value: money.has(e.field) && e.new_value ? this.crypto.decrypt(e.new_value, `offer_event.${e.field}`) : e.new_value,
      actor_id: e.actor_id,
      at: e.at,
    }));
  }

  private eventData(offerId: string, field: string, oldV: string | null, newV: string | null, actorId: string | null) {
    const sensitive = field === 'ctc' || field === 'stipend';
    const enc = (v: string | null) => (v && sensitive ? this.crypto.encrypt(v, `offer_event.${field}`) : v);
    return { offer_id: offerId, field, old_value: enc(oldV), new_value: enc(newV), actor_id: actorId };
  }

  // ------------------------------------------------------------ HR -> Officer ----

  /** HR proposes an offer for a selected student of THEIR drive. Nothing is binding until the Officer confirms. */
  async propose(actor: Actor, dto: z.infer<typeof proposeSchema>) {
    const drive = await this.db.prisma.drive.findUnique({ where: { id: dto.drive_id } });
    if (!drive || drive.company_id !== actor.companyId) throw new ForbiddenException({ message: 'This drive belongs to another company.', code: 'OUT_OF_SCOPE' });
    if (drive.offer_type !== 'I' && dto.ctc_lpa == null) throw new BadRequestException({ message: 'A CTC is required for this drive.', code: 'NO_CTC' });
    if (drive.offer_type === 'I' && dto.ctc_lpa != null) throw new BadRequestException({ message: 'Internship offers carry a stipend, not a CTC.', code: 'BAD_TYPE' });
    const p = await this.db.run(actor, async (tx) => {
      const app = await tx.application.findUnique({ where: { student_id_drive_id: { student_id: dto.student_id, drive_id: dto.drive_id } } });
      if (!app || app.stage !== 'selected') throw new ConflictException({ message: 'Only students you have marked as selected for this drive can receive an offer proposal.', code: 'NOT_SELECTED' });
      if (await tx.offer_proposal.findFirst({ where: { drive_id: dto.drive_id, student_id: dto.student_id, status: 'proposed' } })) throw new ConflictException({ message: 'A proposal for this student is already waiting for the Placement Officer.', code: 'DUPLICATE' });
      const row = await tx.offer_proposal.create({
        data: { drive_id: dto.drive_id, student_id: dto.student_id, proposed_by: actor.id, ctc_enc: this.crypto.encryptNumber(dto.ctc_lpa, CTC_AAD), stipend_enc: this.crypto.encryptNumber(dto.stipend_amount, STIPEND_AAD), note: dto.note },
      });
      await this.audit.log({ actor, action: 'OFFER_PROPOSED', entity: 'offer_proposal', entity_id: row.id, meta: { drive_id: dto.drive_id, student_id: dto.student_id } }, tx);
      return row;
    });
    return { id: p.id, status: p.status };
  }

  async listProposals(actor: Actor) {
    const rows = await this.db.run(actor, async (tx) => {
      const ps = await tx.offer_proposal.findMany({ where: { status: 'proposed', ...(actor.role === 'hr' ? { drive: { company_id: actor.companyId } } : {}) }, include: { drive: { include: { company: true } } }, orderBy: { created_at: 'asc' }, take: 200 });
      const students = await tx.student.findMany({ where: { id: { in: ps.map((p) => p.student_id) } }, include: { programme: true } });
      const sm = new Map(students.map((s) => [s.id, s]));
      return ps.map((p) => ({ p, s: sm.get(p.student_id) }));
    });
    return rows.map(({ p, s }) => ({
      id: p.id,
      drive: { id: p.drive_id, title: p.drive.title, company: p.drive.company.name, offer_type: p.drive.offer_type },
      student: s ? { id: s.id, name: s.name, placement_id: s.placement_id, programme_code: s.programme.code } : null,
      ctc_lpa: this.crypto.decryptNumber(p.ctc_enc, CTC_AAD),
      stipend_amount: this.crypto.decryptNumber(p.stipend_enc, STIPEND_AAD),
      note: p.note,
      proposed_at: p.created_at,
    }));
  }

  /** Officer confirms: creates the offer with its acceptance deadline (the earlier of issue + 24 h and the company's deadline). */
  async confirmProposal(actor: Actor, id: string) {
    const { version, params } = await this.policy.current();
    const created = await this.db.run(actor, async (tx) => {
      const p = await tx.offer_proposal.findUnique({ where: { id }, include: { drive: { include: { company: true } } } });
      if (!p || p.status !== 'proposed') throw new NotFoundException('No such open proposal');
      const ctc = this.crypto.decryptNumber(p.ctc_enc, CTC_AAD);
      const category = ctc == null ? null : catToDb(categoryFor(ctc, params.thresholds));
      const issued = new Date();
      const deadline = computeDeadline(issued, p.drive.acceptance_deadline, params.acceptance.hours);
      const offer = await tx.offer.create({
        data: { student_id: p.student_id, drive_id: p.drive_id, type: p.drive.offer_type, category, ctc_enc: p.ctc_enc, stipend_enc: p.stipend_enc, offer_date: issued, deadline, policy_version: version, created_by: actor.id },
      });
      await tx.offer_event.create({ data: this.eventData(offer.id, 'created', null, 'pending', actor.id) });
      await tx.offer_proposal.update({ where: { id }, data: { status: 'confirmed', decided_by: actor.id, decided_at: issued, offer_id: offer.id } });
      await this.audit.log({ actor, action: 'OFFER_CONFIRMED', entity: 'offer', entity_id: offer.id, after: { drive_id: p.drive_id, student_id: p.student_id, category: catFromDb(category), deadline }, meta: { proposal_id: id, policy_version: version } }, tx);
      const s = await tx.student.findUniqueOrThrow({ where: { id: p.student_id } });
      return { offer, student: s, company: p.drive.company.name, deadline };
    });
    await this.engine.recomputeState(created.student.id);
    await this.mail.send(created.student.email, `New offer from ${created.company}: respond by ${created.deadline.toISOString()}`, `You have received an offer from ${created.company}.\n\nSign in to the NFSU Placement Portal and accept or decline before ${created.deadline.toISOString()}. An unanswered offer expires automatically at that time.`);
    return { offer_id: created.offer.id, deadline: created.deadline };
  }

  async rejectProposal(actor: Actor, id: string, reason: string) {
    await this.db.run(actor, async (tx) => {
      const p = await tx.offer_proposal.findUnique({ where: { id } });
      if (!p || p.status !== 'proposed') throw new NotFoundException('No such open proposal');
      await tx.offer_proposal.update({ where: { id }, data: { status: 'rejected', decided_by: actor.id, decided_at: new Date(), note: `${p.note ?? ''} | rejected: ${reason}`.slice(0, 500) } });
      await this.audit.log({ actor, action: 'OFFER_PROPOSAL_REJECTED', entity: 'offer_proposal', entity_id: id, meta: { reason } }, tx);
    });
  }

  // ----------------------------------------------------- direct (off-campus) ----

  async createDirect(actor: Actor, dto: z.infer<typeof directOfferSchema>) {
    const { version, params } = await this.policy.current();
    const offer = await this.db.run(actor, async (tx) => {
      const s = await tx.student.findFirst({ where: { id: dto.student_id } });
      if (!s) throw new ForbiddenException({ message: 'Student not found or not in your scope.', code: 'OUT_OF_SCOPE' });
      const issued = new Date();
      const accepted = dto.already_accepted;
      const category = dto.ctc_lpa == null ? null : catToDb(categoryFor(dto.ctc_lpa, params.thresholds));
      const o = await tx.offer.create({
        data: {
          student_id: dto.student_id, drive_id: dto.drive_id ?? null, off_campus_company: dto.drive_id ? null : dto.off_campus_company, type: dto.type, category,
          ctc_enc: this.crypto.encryptNumber(dto.ctc_lpa, CTC_AAD), stipend_enc: this.crypto.encryptNumber(dto.stipend_amount, STIPEND_AAD),
          offer_date: issued, deadline: accepted ? issued : computeDeadline(issued, null, params.acceptance.hours), acceptance_status: accepted ? 'accepted' : 'pending',
          noc_status: dto.drive_id ? 'not_required' : (dto.noc_status ?? 'pending'), policy_version: version, created_by: actor.id,
        },
      });
      await tx.offer_event.create({ data: this.eventData(o.id, 'created', null, o.acceptance_status, actor.id) });
      await this.audit.log({ actor, action: 'OFFER_CREATED_DIRECT', entity: 'offer', entity_id: o.id, after: { student_id: dto.student_id, type: dto.type, off_campus: !dto.drive_id, category: catFromDb(category), accepted } }, tx);
      return o;
    });
    await this.engine.recomputeState(dto.student_id);
    return { id: offer.id };
  }

  // ------------------------------------------------------------------ student ----

  /**
   * Accept or decline. Needs step-up MFA. A student can touch only acceptance_status (a DB trigger enforces that, too).
   * Accepting re-checks the offer-type and category rules against the student's OTHER accepted offers.
   */
  async respond(actor: Actor, id: string, decision: 'accept' | 'decline') {
    const result = await this.db.run(actor, async (tx) => {
      const o = await tx.offer.findFirst({ where: { id, student: { user_id: actor.id } }, include: { student: true } });
      if (!o) throw new ForbiddenException({ message: 'This offer is not yours.', code: 'OUT_OF_SCOPE' });
      if (o.acceptance_status !== 'pending') throw new ConflictException({ message: `This offer is already ${o.acceptance_status}.`, code: 'BAD_STATE' });
      if (o.deadline.getTime() <= Date.now()) throw new ConflictException({ message: 'The acceptance deadline has passed. The offer has expired.', code: 'EXPIRED' });

      if (decision === 'accept' && o.drive_id) {
        const r = await this.engine.evaluateOne(tx, o.student_id, o.drive_id, 'apply', { persist: false, excludeOfferIds: [o.id] });
        const hard = r.decision.fired_rules.find((f) => (f.code === 'R5' || f.code === 'R6') && f.outcome === 'BLOCK');
        if (hard) return { blocked: hard.message, student_id: o.student_id };
      }
      const status = decision === 'accept' ? 'accepted' : 'declined';
      await tx.offer.update({ where: { id }, data: { acceptance_status: status } });
      await tx.offer_event.create({ data: this.eventData(id, 'acceptance_status', 'pending', status, actor.id) });
      await this.audit.log({ actor, action: decision === 'accept' ? 'OFFER_ACCEPTED' : 'OFFER_DECLINED', entity: 'offer', entity_id: id }, tx);
      return { status, student_id: o.student_id };
    });
    if ('blocked' in result) throw new ConflictException({ message: `You cannot accept this offer under the placement policy: ${result.blocked}`, code: 'POLICY_BLOCK' });
    // Acceptance triggers recomputation of placement status and switching eligibility for all upcoming drives.
    await this.engine.recomputeState(result.student_id);
    return { acceptance_status: result.status };
  }

  // --------------------------------------------------- coordinator / officer ----

  /** Joining status, PPO status and NOC are updated later by the coordinator, each as a NEW event (history kept). */
  async updateLifecycle(actor: Actor, id: string, dto: z.infer<typeof lifecycleSchema>) {
    if (!LIFECYCLE_VALUES[dto.field].includes(dto.value)) throw new BadRequestException({ message: `${dto.field} must be one of: ${LIFECYCLE_VALUES[dto.field].join(', ')}`, code: 'BAD_VALUE' });
    await this.db.run(actor, async (tx) => {
      const o = await tx.offer.findFirst({ where: { id, ...this.scopeWhere(actor) } });
      if (!o) throw new ForbiddenException({ message: 'Offer not found or not in your scope.', code: 'OUT_OF_SCOPE' });
      const old = (o as Record<string, unknown>)[dto.field] as string;
      if (old === dto.value) return;
      await tx.offer.update({ where: { id }, data: { [dto.field]: dto.value } });
      await tx.offer_event.create({ data: this.eventData(id, dto.field, old, dto.value, actor.id) });
      await this.audit.log({ actor, action: 'OFFER_LIFECYCLE_UPDATED', entity: 'offer', entity_id: id, before: { [dto.field]: old }, after: { [dto.field]: dto.value }, meta: { reason: dto.reason } }, tx);
    });
  }

  /** CTC correction: Officer/Admin only, with a reason, step-up MFA, a full before/after trail, and the category re-derived. */
  async correctCtc(actor: Actor, id: string, dto: z.infer<typeof correctSchema>) {
    const { params } = await this.policy.current();
    const sid = await this.db.run(actor, async (tx) => {
      const o = await tx.offer.findUnique({ where: { id } });
      if (!o) throw new NotFoundException('Offer not found');
      if (o.type === 'I') throw new BadRequestException({ message: 'Internship-only offers have no CTC.', code: 'BAD_TYPE' });
      const oldCtc = this.crypto.decryptNumber(o.ctc_enc, CTC_AAD);
      const category = catToDb(categoryFor(dto.ctc_lpa, params.thresholds));
      await tx.offer.update({ where: { id }, data: { ctc_enc: this.crypto.encryptNumber(dto.ctc_lpa, CTC_AAD), category } });
      await tx.offer_event.create({ data: this.eventData(id, 'ctc', oldCtc == null ? null : String(oldCtc), String(dto.ctc_lpa), actor.id) });
      await this.audit.log({ actor, action: 'OFFER_CTC_CORRECTED', entity: 'offer', entity_id: id, before: { ctc_lpa: oldCtc, category: catFromDb(o.category) }, after: { ctc_lpa: dto.ctc_lpa, category: catFromDb(category) }, meta: { reason: dto.reason } }, tx);
      return o.student_id;
    });
    await this.engine.recomputeState(sid);
  }

  // -------------------------------------------------------------- scheduled ----

  /** Mark unanswered offers expired and tell the coordinator. Runs every minute (BullMQ). */
  async expireDue(): Promise<number> {
    const due = await this.db.run(SYSTEM_ACTOR, async (tx) => {
      const rows = await tx.offer.findMany({ where: { acceptance_status: 'pending', deadline: { lte: new Date() } }, include: { student: { include: { programme: true } }, drive: { include: { company: true } } }, take: 200 });
      for (const o of rows) {
        await tx.offer.update({ where: { id: o.id }, data: { acceptance_status: 'expired' } });
        await tx.offer_event.create({ data: this.eventData(o.id, 'acceptance_status', 'pending', 'expired', null) });
        await tx.review_case.create({ data: { kind: 'expired_offer', student_id: o.student_id, programme_id: o.student.programme_id, ref_id: o.id, payload: { summary: `Offer from ${o.drive?.company.name ?? o.off_campus_company} expired unanswered`, student: o.student.name } } });
        await this.audit.log({ actor: SYSTEM_ACTOR, action: 'OFFER_EXPIRED', entity: 'offer', entity_id: o.id }, tx);
      }
      return rows;
    });
    for (const o of due) {
      await this.engine.recomputeState(o.student_id);
      const coords = await this.db.prisma.coordinator_scope.findMany({ where: { programme_id: o.student.programme_id }, include: { user: true } });
      for (const c of coords) await this.mail.send(c.user.email, 'Offer expired unanswered', `${o.student.name} (${o.student.placement_id}) did not respond to the offer from ${o.drive?.company.name ?? o.off_campus_company} before the deadline, so it has expired.`);
    }
    if (due.length) this.log.log(`Expired ${due.length} unanswered offer(s)`);
    return due.length;
  }

  /** Reminder e-mail when an unanswered offer is within 6 hours of its deadline (once per offer). */
  async remindDue(redis: { set: (...a: unknown[]) => Promise<unknown> }): Promise<number> {
    const soon = await this.db.run(SYSTEM_ACTOR, (tx) =>
      tx.offer.findMany({ where: { acceptance_status: 'pending', deadline: { gt: new Date(), lte: new Date(Date.now() + 6 * 3600_000) } }, include: { student: true, drive: { include: { company: true } } }, take: 200 }),
    );
    let n = 0;
    for (const o of soon) {
      if ((await redis.set(`remind:${o.id}`, '1', 'EX', 86_400, 'NX')) !== 'OK') continue;
      await this.mail.send(o.student.email, 'Reminder: respond to your offer', `Your offer from ${o.drive?.company.name ?? o.off_campus_company} expires at ${o.deadline.toISOString()}. Accept or decline it in the portal before then.`);
      n++;
    }
    return n;
  }

}
