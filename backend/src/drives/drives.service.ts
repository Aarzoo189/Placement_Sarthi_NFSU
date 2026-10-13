import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { DbService, PrismaService, SYSTEM_ACTOR } from '../common/prisma.service';
import { AuditService } from '../common/audit.service';
import { CryptoService } from '../common/crypto.service';
import { Actor } from '../common/types';
import { emailField, text } from '../common/zod.pipe';
import { categoryFor, Decision } from '../policy/engine';
import { EngineService, catFromDb, catToDb } from '../policy/engine.service';
import { PolicyService } from '../policy/policy.service';
import { StudentsService } from '../students/students.service';
import { UsersService } from '../users/users.service';
import { SessionService } from '../auth/session.service';

const criteriaSchema = z
  .object({
    min_cgpa: z.number().min(0).max(10).optional(),
    max_backlogs: z.number().int().min(0).max(50).optional(),
    programmes: z.array(z.string().trim().toUpperCase().max(20)).max(10).optional(),
    batches: z.array(z.number().int().min(2000).max(2100)).max(5).optional(),
  })
  .strict();

const driveFields = z.object({
  company_id: z.string().uuid(),
  title: text(160).pipe(z.string().min(3)),
  offer_type: z.enum(['I', 'F', 'IF']),
  ctc_lpa: z.number().positive().max(1000).nullable().optional(),
  stipend_amount: z.number().min(0).max(10_000_000).nullable().optional(),
  stipend_period: z.enum(['monthly', 'total']).nullable().optional(),
  criteria: criteriaSchema.default({}),
  acceptance_deadline: z.coerce.date().nullable().optional(),
  drive_date: z.coerce.date().nullable().optional(),
});

const typeRules = (d: { offer_type: string; ctc_lpa?: number | null; stipend_amount?: number | null }, ctx: z.RefinementCtx) => {
  if (d.offer_type !== 'I' && d.ctc_lpa == null) ctx.addIssue({ code: 'custom', path: ['ctc_lpa'], message: 'FTE and I+F drives need a CTC (LPA)' });
  if (d.offer_type === 'I' && d.ctc_lpa != null) ctx.addIssue({ code: 'custom', path: ['ctc_lpa'], message: 'Internship-only drives carry a stipend, not a CTC' });
};

export const createDriveSchema = driveFields.strict().superRefine(typeRules);
export const updateDriveSchema = driveFields.omit({ company_id: true }).partial().strict();
export const companySchema = z
  .object({ name: text(120).pipe(z.string().min(2)), verified_domain: z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'Enter a domain like acme.com') })
  .strict();
export const inviteSchema = z.object({ email: emailField, name: text(120).pipe(z.string().min(2)), valid_days: z.number().int().min(1).max(365).default(45) }).strict();
export const stageSchema = z.object({ student_ids: z.array(z.string().uuid()).min(1).max(500), stage: z.enum(['shortlisted', 'selected', 'rejected']) }).strict();

export type DecisionView = { result: Decision['result']; summary: string; fired_rules: Decision['fired_rules']; decision_id?: string };

@Injectable()
export class DrivesService {
  constructor(
    private readonly db: DbService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly engine: EngineService,
    private readonly policy: PolicyService,
    private readonly students: StudentsService,
    private readonly users: UsersService,
    private readonly sessions: SessionService,
  ) {}

  // -------------------------------------------------------------- companies ----

  async createCompany(actor: Actor, dto: z.infer<typeof companySchema>) {
    if (await this.prisma.company.findUnique({ where: { name: dto.name } })) throw new ConflictException({ message: 'A company with this name exists.', code: 'DUPLICATE' });
    const c = await this.prisma.company.create({ data: { ...dto, created_by: actor.id } });
    await this.audit.log({ actor, action: 'COMPANY_CREATED', entity: 'company', entity_id: c.id, after: dto });
    return c;
  }

  listCompanies() {
    return this.prisma.company.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { drives: true } } } });
  }

  // ------------------------------------------------------------------ drives ----

  private shapeDrive(d: Prisma.driveGetPayload<{ include: { company: true } }>) {
    return {
      id: d.id,
      company_id: d.company_id,
      company: d.company.name,
      title: d.title,
      offer_type: d.offer_type,
      ctc_lpa: d.ctc_lpa == null ? null : Number(d.ctc_lpa),
      stipend_amount: d.stipend_amount == null ? null : Number(d.stipend_amount),
      stipend_period: d.stipend_period,
      category: catFromDb(d.category),
      criteria: d.criteria_json,
      acceptance_deadline: d.acceptance_deadline,
      drive_date: d.drive_date,
      status: d.status,
      opened_at: d.opened_at,
      closed_at: d.closed_at,
    };
  }

  private async categoryFrom(ctc: number | null | undefined) {
    if (ctc == null) return null;
    const { params } = await this.policy.current();
    return catToDb(categoryFor(ctc, params.thresholds));
  }

  async create(actor: Actor, dto: z.infer<typeof createDriveSchema>) {
    if (!(await this.prisma.company.findUnique({ where: { id: dto.company_id } }))) throw new BadRequestException({ message: 'Unknown company.', code: 'BAD_COMPANY' });
    const category = await this.categoryFrom(dto.ctc_lpa);
    const d = await this.prisma.drive.create({
      data: { ...dto, ctc_lpa: dto.ctc_lpa ?? null, stipend_amount: dto.stipend_amount ?? null, stipend_period: dto.stipend_period ?? null, criteria_json: dto.criteria as Prisma.InputJsonValue, category, created_by: actor.id },
      include: { company: true },
    });
    await this.audit.log({ actor, action: 'DRIVE_CREATED', entity: 'drive', entity_id: d.id, after: { ...dto, category: catFromDb(category) } });
    return this.shapeDrive(d);
  }

  async update(actor: Actor, id: string, dto: z.infer<typeof updateDriveSchema>) {
    const before = await this.prisma.drive.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Drive not found');
    if (before.status !== 'draft') throw new ConflictException({ message: 'Only a draft drive can be edited. Once a drive is open its terms are fixed.', code: 'NOT_DRAFT' });
    const merged = { offer_type: dto.offer_type ?? before.offer_type, ctc_lpa: dto.ctc_lpa !== undefined ? dto.ctc_lpa : before.ctc_lpa == null ? null : Number(before.ctc_lpa), stipend_amount: dto.stipend_amount };
    const check = z.object({ offer_type: z.string(), ctc_lpa: z.number().nullable().optional(), stipend_amount: z.number().nullable().optional() }).superRefine(typeRules).safeParse(merged);
    if (!check.success) throw new BadRequestException({ message: 'Invalid drive', errors: check.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    const category = dto.ctc_lpa !== undefined || dto.offer_type ? await this.categoryFrom(merged.offer_type === 'I' ? null : merged.ctc_lpa) : undefined;
    const d = await this.prisma.drive.update({
      where: { id },
      data: { ...dto, criteria_json: dto.criteria as Prisma.InputJsonValue | undefined, criteria: undefined, ...(category !== undefined && { category }) } as Prisma.driveUpdateInput,
      include: { company: true },
    });
    await this.audit.log({ actor, action: 'DRIVE_UPDATED', entity: 'drive', entity_id: id, before: { ctc_lpa: before.ctc_lpa?.toString(), offer_type: before.offer_type }, after: dto });
    return this.shapeDrive(d);
  }

  async list(actor: Actor) {
    const where: Prisma.driveWhereInput = actor.role === 'hr' ? { company_id: actor.companyId } : actor.role === 'student' ? { status: 'open' } : {};
    const rows = await this.prisma.drive.findMany({ where, include: { company: true }, orderBy: [{ status: 'asc' }, { created_at: 'desc' }], take: 300 });
    return rows.map((d) => this.shapeDrive(d));
  }

  async get(actor: Actor, id: string) {
    const d = await this.prisma.drive.findUnique({ where: { id }, include: { company: true } });
    if (!d) throw new NotFoundException('Drive not found');
    if (actor.role === 'hr' && d.company_id !== actor.companyId) throw new ForbiddenException({ message: 'This drive belongs to another company.', code: 'OUT_OF_SCOPE' });
    if (actor.role === 'student' && d.status !== 'open') throw new ForbiddenException({ message: 'This drive is not open.', code: 'OUT_OF_SCOPE' });
    return this.shapeDrive(d);
  }

  private async mustDrive(id: string) {
    const d = await this.prisma.drive.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('Drive not found');
    return d;
  }

  /** On opening, the engine pre-computes the eligible list: every registered student gets a stored ALLOW / BLOCK / REVIEW decision. */
  async open(actor: Actor, id: string) {
    const d = await this.mustDrive(id);
    if (d.status !== 'draft') throw new ConflictException({ message: `This drive is already ${d.status}.`, code: 'BAD_STATE' });
    if (d.offer_type !== 'I' && d.ctc_lpa == null) throw new BadRequestException({ message: 'Set the CTC before opening the drive.', code: 'NO_CTC' });
    const counts = { ALLOW: 0, BLOCK: 0, REVIEW: 0 };
    await this.db.run(
      { ...actor, role: 'system' },
      async (tx) => {
        await tx.drive.update({ where: { id }, data: { status: 'open', opened_at: new Date() } });
        const ids = (await tx.student.findMany({ where: { registration_status: 'registered', archived_at: null }, select: { id: true } })).map((s) => s.id);
        for (let i = 0; i < ids.length; i += 100) for (const r of await this.engine.evaluateMany(tx, ids.slice(i, i + 100), id, 'drive_open')) counts[r.decision.result]++;
      },
      { timeout: 120_000 },
    );
    await this.audit.log({ actor, action: 'DRIVE_OPENED', entity: 'drive', entity_id: id, meta: counts });
    return { status: 'open', precomputed: counts };
  }

  async close(actor: Actor, id: string) {
    const d = await this.mustDrive(id);
    if (d.status === 'closed') throw new ConflictException({ message: 'Already closed.', code: 'BAD_STATE' });
    await this.prisma.drive.update({ where: { id }, data: { status: 'closed', closed_at: new Date() } });
    // HR accounts expire when the company has no other live drive.
    const live = await this.prisma.drive.count({ where: { company_id: d.company_id, status: { in: ['draft', 'open'] }, id: { not: id } } });
    let expired = 0;
    if (!live) {
      const hrs = await this.prisma.hr_user.findMany({ where: { company_id: d.company_id } });
      await this.prisma.hr_user.updateMany({ where: { company_id: d.company_id }, data: { valid_until: new Date() } });
      for (const h of hrs) await this.sessions.destroyAll(h.user_id);
      expired = hrs.length;
    }
    await this.audit.log({ actor, action: 'DRIVE_CLOSED', entity: 'drive', entity_id: id, meta: { hr_accounts_expired: expired } });
    return { status: 'closed', hr_accounts_expired: expired };
  }

  /** Invite-only company accounts: the e-mail must be on the company's verified domain. */
  async inviteHr(actor: Actor, driveId: string, dto: z.infer<typeof inviteSchema>) {
    const d = await this.prisma.drive.findUnique({ where: { id: driveId }, include: { company: true } });
    if (!d) throw new NotFoundException('Drive not found');
    if (!dto.email.endsWith(`@${d.company.verified_domain}`)) throw new BadRequestException({ message: `HR contacts must use an @${d.company.verified_domain} address (the company's verified domain).`, code: 'DOMAIN_MISMATCH' });
    const valid_until = new Date(Date.now() + dto.valid_days * 86_400_000);
    const existing = await this.prisma.user_account.findUnique({ where: { email: dto.email } });
    if (existing && existing.role !== 'hr') throw new ConflictException({ message: 'This address already belongs to a non-HR account.', code: 'DUPLICATE' });
    let sent = false;
    if (existing) {
      await this.prisma.hr_user.upsert({ where: { user_id: existing.id }, create: { user_id: existing.id, company_id: d.company_id, valid_until }, update: { company_id: d.company_id, valid_until } });
    } else {
      const { user, raw } = await this.prisma.$transaction(async (tx) => {
        const r = await this.users.createAccountRow(tx, { email: dto.email, name: dto.name, role: 'hr', created_by: actor.id });
        await tx.hr_user.create({ data: { user_id: r.user.id, company_id: d.company_id, valid_until } });
        return r;
      });
      await this.users.sendActivation(user, raw, `You have been invited by the NFSU Placement Cell to run the ${d.company.name} recruitment drive "${d.title}".`);
      sent = true;
    }
    await this.audit.log({ actor, action: 'HR_INVITED', entity: 'drive', entity_id: driveId, meta: { company: d.company.name, valid_until, new_account: sent } });
    return { invited: true, new_account: sent, valid_until };
  }

  // ---------------------------------------------------------------- students ----

  private decisionView(r: { decision: Decision; decision_id?: string }): DecisionView {
    return { result: r.decision.result, summary: r.decision.summary, fired_rules: r.decision.fired_rules, decision_id: r.decision_id };
  }

  /** For the logged-in student: open drives, with the engine's verdict and reasons computed right now (not stored). */
  async myDrives(actor: Actor) {
    const me = await this.db.run(actor, (tx) => tx.student.findFirst({ where: { user_id: actor.id }, select: { id: true } }));
    if (!me) throw new NotFoundException('No student profile is linked to this account.');
    const drives = await this.prisma.drive.findMany({ where: { status: 'open' }, include: { company: true }, orderBy: { opened_at: 'desc' }, take: 100 });
    return this.db.run(actor, async (tx) => {
      const apps = new Map((await tx.application.findMany({ where: { student_id: me.id } })).map((a) => [a.drive_id, a.stage]));
      const out = [];
      for (const d of drives) {
        const r = await this.engine.evaluateOne(tx, me.id, d.id, 'apply', { persist: false });
        out.push({ ...this.shapeDrive(d), decision: this.decisionView(r), application_stage: apps.get(d.id) ?? null });
      }
      return out;
    });
  }

  /**
   * Student applies. The engine runs HERE, server-side, on every application, so calling the API directly cannot skip it.
   * ALLOW -> application; REVIEW -> application held for the Officer; BLOCK -> 403 with the reasons. The decision is stored in all cases.
   */
  async apply(actor: Actor, driveId: string) {
    const drive = await this.prisma.drive.findUnique({ where: { id: driveId } });
    if (!drive || drive.status !== 'open') throw new ForbiddenException({ message: 'This drive is not open for applications.', code: 'DRIVE_CLOSED' });
    const out = await this.db.run(actor, async (tx) => {
      const me = await tx.student.findFirst({ where: { user_id: actor.id }, select: { id: true, programme_id: true } });
      if (!me) throw new NotFoundException('No student profile is linked to this account.');
      const existing = await tx.application.findUnique({ where: { student_id_drive_id: { student_id: me.id, drive_id: driveId } } });
      if (existing && existing.stage !== 'withdrawn') throw new ConflictException({ message: 'You have already applied to this drive.', code: 'ALREADY_APPLIED' });
      const r = await this.engine.evaluateOne(tx, me.id, driveId, 'apply');
      let application = null;
      if (r.decision.result !== 'BLOCK') {
        const stage = r.decision.result === 'ALLOW' ? 'applied' : 'pending_review';
        application = existing
          ? await tx.application.update({ where: { id: existing.id }, data: { stage, engine_decision_id: r.decision_id } })
          : await tx.application.create({ data: { student_id: me.id, drive_id: driveId, engine_decision_id: r.decision_id, stage } });
      }
      await this.audit.log({ actor, action: `APPLY_${r.decision.result}`, entity: 'drive', entity_id: driveId, meta: { decision_id: r.decision_id, summary: r.decision.summary, policy_version: r.policy_version } }, tx);
      return { r, application, me };
    });
    if (out.r.decision.result === 'REVIEW') {
      await this.db.run(SYSTEM_ACTOR, (tx) =>
        tx.review_case.create({ data: { kind: 'engine_review', student_id: out.me.id, programme_id: out.me.programme_id, application_id: out.application!.id, ref_id: driveId, payload: { summary: out.r.decision.summary, fired_rules: out.r.decision.fired_rules, drive_id: driveId } as unknown as Prisma.InputJsonValue } }),
      );
    }
    if (out.r.decision.result === 'BLOCK') throw new ForbiddenException({ message: out.r.decision.summary, code: 'POLICY_BLOCK', decision: this.decisionView(out.r) });
    return { application_id: out.application!.id, stage: out.application!.stage, decision: this.decisionView(out.r) };
  }

  /** Every application the student has made (including closed drives), with the decision that was stored when they applied. */
  async myApplications(actor: Actor) {
    const rows = await this.db.run(actor, (tx) =>
      tx.application.findMany({ where: { student: { user_id: actor.id } }, include: { drive: { include: { company: true } }, decision: true }, orderBy: { created_at: 'desc' }, take: 200 }),
    );
    return rows.map((a) => ({
      application_id: a.id,
      stage: a.stage,
      applied_at: a.created_at,
      updated_at: a.updated_at,
      drive: { id: a.drive.id, title: a.drive.title, company: a.drive.company.name, offer_type: a.drive.offer_type, status: a.drive.status },
      decision: a.decision ? { result: a.decision.result, fired_rules: a.decision.fired_rules_json } : null,
    }));
  }

  async withdraw(actor: Actor, driveId: string) {
    await this.db.run(actor, async (tx) => {
      const me = await tx.student.findFirst({ where: { user_id: actor.id }, select: { id: true } });
      const app = me && (await tx.application.findUnique({ where: { student_id_drive_id: { student_id: me.id, drive_id: driveId } } }));
      if (!app || !['applied', 'pending_review'].includes(app.stage)) throw new ConflictException({ message: 'There is no open application to withdraw.', code: 'BAD_STATE' });
      await tx.application.update({ where: { id: app.id }, data: { stage: 'withdrawn' } });
      await this.audit.log({ actor, action: 'APPLICATION_WITHDRAWN', entity: 'application', entity_id: app.id }, tx);
    });
  }

  // ------------------------------------------------------- staff / HR views ----

  private async assertDriveAccess(actor: Actor, driveId: string) {
    const d = await this.mustDrive(driveId);
    if (actor.role === 'hr' && d.company_id !== actor.companyId) throw new ForbiddenException({ message: 'This drive belongs to another company.', code: 'OUT_OF_SCOPE' });
    return d;
  }

  /** Eligibility list for a drive (officer / admin: all students, coordinator: own programme). Live verdicts with reasons. */
  async eligibility(actor: Actor, driveId: string) {
    await this.mustDrive(driveId);
    return this.db.run(actor, async (tx) => {
      const ss = await tx.student.findMany({ where: { archived_at: null, ...(actor.role === 'coordinator' ? { programme_id: { in: actor.programmeIds ?? [] } } : {}) }, include: { programme: true }, orderBy: { placement_id: 'asc' }, take: 1000 });
      const res = await this.engine.evaluateMany(tx, ss.map((s) => s.id), driveId, 'shortlist', { persist: false });
      const byId = new Map(res.map((r) => [r.student_id, r]));
      const counts = { ALLOW: 0, BLOCK: 0, REVIEW: 0 };
      const items = ss.map((s) => {
        const r = byId.get(s.id)!;
        counts[r.decision.result]++;
        return { student_id: s.id, placement_id: s.placement_id, name: s.name, programme_code: s.programme.code, batch: s.batch, result: r.decision.result, summary: r.decision.summary, fired_rules: r.decision.fired_rules };
      });
      return { counts, items };
    });
  }

  /** Applicants. HR sees the masked view (name, programme, CGPA, resume) until a student is shortlisted. */
  async applicants(actor: Actor, driveId: string) {
    await this.assertDriveAccess(actor, driveId);
    const rows = await this.db.run(actor, (tx) =>
      tx.application.findMany({ where: { drive_id: driveId, stage: { not: 'withdrawn' } }, include: { student: { include: { programme: true, placement_state: true } } }, orderBy: [{ stage: 'asc' }, { created_at: 'asc' }] }),
    );
    return rows.map((a) => ({
      application_id: a.id,
      stage: a.stage,
      applied_at: a.created_at,
      student: this.students.shape(a.student, actor, { shortlisted: a.stage === 'shortlisted' || a.stage === 'selected' }),
    }));
  }

  /** Move applicants to shortlisted / selected / rejected. Shortlisting re-runs the engine, so a student who became blocked cannot be shortlisted. */
  async setStage(actor: Actor, driveId: string, studentIds: string[], stage: 'shortlisted' | 'selected' | 'rejected') {
    const d = await this.assertDriveAccess(actor, driveId);
    if (d.status === 'closed') throw new ConflictException({ message: 'This drive is closed.', code: 'DRIVE_CLOSED' });
    const updated: string[] = [];
    const failed: { student_id: string; reason: string }[] = [];
    await this.db.run(actor, async (tx) => {
      const apps = await tx.application.findMany({ where: { drive_id: driveId, student_id: { in: studentIds } } });
      const byStudent = new Map(apps.map((a) => [a.student_id, a]));
      for (const sid of studentIds) {
        const app = byStudent.get(sid);
        if (!app || app.stage === 'withdrawn') { failed.push({ student_id: sid, reason: 'No application from this student (or not in your scope).' }); continue; }
        if (stage === 'selected' && !['shortlisted', 'selected'].includes(app.stage)) { failed.push({ student_id: sid, reason: 'Only shortlisted students can be selected.' }); continue; }
        if (app.stage === 'pending_review') { failed.push({ student_id: sid, reason: 'Application is waiting for Placement Officer review.' }); continue; }
        if (stage === 'shortlisted') {
          const { decision } = await this.engine.evaluateOne(tx, sid, driveId, 'shortlist');
          if (decision.result !== 'ALLOW') { failed.push({ student_id: sid, reason: decision.summary }); continue; }
        }
        await tx.application.update({ where: { id: app.id }, data: { stage } });
        updated.push(sid);
      }
      await this.audit.log({ actor, action: `APPLICATION_${stage.toUpperCase()}`, entity: 'drive', entity_id: driveId, meta: { updated: updated.length, failed: failed.length } }, tx);
    });
    return { updated: updated.length, failed };
  }

  /** HR uploads shortlists / final selections as a CSV of Placement IDs. Only students who applied to THIS drive are touched. */
  async stageFromCsv(actor: Actor, driveId: string, stage: 'shortlisted' | 'selected' | 'rejected', csv: Buffer) {
    await this.assertDriveAccess(actor, driveId);
    let rows: string[][];
    try {
      rows = parse(csv, { skip_empty_lines: true, trim: true, bom: true, relax_column_count: true }) as string[][];
    } catch (e) {
      throw new BadRequestException({ message: `Not valid CSV: ${(e as Error).message}`, code: 'BAD_CSV' });
    }
    const ids = rows.map((r) => (r[0] ?? '').toUpperCase()).filter((v) => v && v !== 'PLACEMENT_ID');
    if (!ids.length) throw new BadRequestException({ message: 'The file has no Placement IDs (one per line).', code: 'EMPTY_CSV' });
    if (ids.length > 1000) throw new BadRequestException({ message: 'At most 1000 IDs per file.', code: 'TOO_MANY_ROWS' });
    const apps = await this.db.run(actor, (tx) => tx.application.findMany({ where: { drive_id: driveId, student: { placement_id: { in: ids } } }, include: { student: { select: { id: true, placement_id: true } } } }));
    const found = new Map(apps.map((a) => [a.student.placement_id, a.student.id]));
    const unknown = ids.filter((i) => !found.has(i));
    const r = await this.setStage(actor, driveId, [...found.values()], stage);
    return { ...r, not_applicants: unknown };
  }

  // used by dashboards / offers
  async companyIdOf(driveId: string) {
    return (await this.mustDrive(driveId)).company_id;
  }
}
