import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { existsSync, mkdirSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { DbService, PrismaService, SYSTEM_ACTOR, Tx } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { RedisService } from '../common/redis.service';
import { AuditService } from '../common/audit.service';
import { EngineService, catFromDb } from '../policy/engine.service';
import { UsersService } from '../users/users.service';
import { Actor } from '../common/types';
import { StudentRow, maskStudent } from '../common/masking';
import { emailField, indianMobile, text } from '../common/zod.pipe';
import { env } from '../config/env';

export const MOBILE_AAD = 'student.mobile_enc';
export const PLACEMENT_ID = /^[A-Z0-9-]{6,20}$/;

const emailDomainOk = (e: string) => !env.STUDENT_EMAIL_DOMAIN || e.endsWith(`@${env.STUDENT_EMAIL_DOMAIN}`);

export const studentFields = z.object({
  placement_id: z.string().trim().toUpperCase().regex(PLACEMENT_ID, 'Placement ID must be 6-20 letters, digits or dashes'),
  name: text(120).pipe(z.string().min(2)),
  email: emailField.refine(emailDomainOk, `must be an @${env.STUDENT_EMAIL_DOMAIN} address`),
  mobile: indianMobile,
  programme_code: z.string().trim().toUpperCase().min(2).max(20),
  batch: z.coerce.number().int().min(2000).max(2100),
  cgpa: z.coerce.number().min(0).max(10).default(0),
  backlogs: z.coerce.number().int().min(0).max(50).default(0),
});
export const createStudentSchema = studentFields.strict();
export const updateStudentSchema = studentFields
  .omit({ placement_id: true, programme_code: true })
  .extend({ registration_status: z.enum(['not_registered', 'registered', 'deregistered']) })
  .partial()
  .strict();

type StudentWithRel = Prisma.studentGetPayload<{ include: { programme: true; placement_state: true } }>;

@Injectable()
export class StudentsService {
  constructor(
    private readonly db: DbService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly engine: EngineService,
    private readonly users: UsersService,
  ) {}

  // ---------------------------------------------------------------- shaping ----

  shape(s: StudentWithRel, actor: Actor, opts: { shortlisted?: boolean; breakGlass?: boolean } = {}) {
    const row: StudentRow = {
      id: s.id,
      placement_id: s.placement_id,
      name: s.name,
      email: s.email,
      mobile: this.crypto.decrypt(s.mobile_enc, MOBILE_AAD),
      programme_id: s.programme_id,
      programme_code: s.programme.code,
      programme_name: s.programme.name,
      batch: s.batch,
      cgpa: Number(s.cgpa),
      backlogs: s.backlogs,
      registration_status: s.registration_status,
      eligibility_status: s.eligibility_status,
      archived_at: s.archived_at,
      has_resume: !!s.resume_path,
      placement_status: s.placement_state?.placement_status ?? 'Unplaced',
      current_category: catFromDb(s.placement_state?.current_category),
      accepted_offer_count: s.placement_state?.accepted_offer_count ?? 0,
    };
    return maskStudent(row, { role: actor.role as never, isSelf: s.user_id === actor.id, shortlisted: opts.shortlisted, breakGlass: opts.breakGlass });
  }

  private scopeWhere(actor: Actor): Prisma.studentWhereInput {
    switch (actor.role) {
      case 'student':
        return { user_id: actor.id };
      case 'coordinator':
        return { programme_id: { in: actor.programmeIds ?? [] } };
      default:
        return {};
    }
  }

  // ------------------------------------------------------------------- reads ----

  async list(actor: Actor, q: { page: number; page_size: number; q?: string; programme_id?: string; batch?: number; eligibility?: string; registration?: string; placement_status?: string }) {
    const where: Prisma.studentWhereInput = {
      AND: [
        this.scopeWhere(actor),
        { archived_at: null },
        q.programme_id ? { programme_id: q.programme_id } : {},
        q.batch ? { batch: q.batch } : {},
        q.eligibility ? { eligibility_status: q.eligibility as never } : {},
        q.registration ? { registration_status: q.registration as never } : {},
        q.placement_status ? (q.placement_status === 'Unplaced' ? { OR: [{ placement_state: null }, { placement_state: { placement_status: 'Unplaced' } }] } : { placement_state: { placement_status: q.placement_status } }) : {},
        q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { placement_id: { contains: q.q.toUpperCase() } }, { email: { contains: q.q.toLowerCase() } }] } : {},
      ],
    };
    const [rows, total] = await this.db.run(actor, async (tx) =>
      Promise.all([
        tx.student.findMany({ where, include: { programme: true, placement_state: true }, orderBy: [{ programme_id: 'asc' }, { placement_id: 'asc' }], skip: (q.page - 1) * q.page_size, take: q.page_size }),
        tx.student.count({ where }),
      ]),
    );
    await this.audit.log({ actor, action: 'STUDENT_LIST_READ', entity: 'student', meta: { count: rows.length, filter: { ...q, q: q.q ? '[text]' : undefined } } });
    return { total, page: q.page, page_size: q.page_size, items: rows.map((r) => this.shape(r, actor)) };
  }

  /** Object-level check on EVERY id: the student role may read only the record linked to their own user. */
  async get(actor: Actor, id: string, opts: { breakGlass?: boolean; reason?: string } = {}) {
    const s = await this.db.run(actor, (tx) => tx.student.findFirst({ where: { id, ...this.scopeWhere(actor) }, include: { programme: true, placement_state: true } }));
    if (!s) {
      if (actor.role === 'student' || actor.role === 'coordinator') throw new ForbiddenException({ message: 'You do not have access to this student record.', code: 'OUT_OF_SCOPE' });
      throw new NotFoundException('Student not found');
    }
    await this.audit.log({ actor, action: opts.breakGlass ? 'STUDENT_BREAK_GLASS_READ' : 'STUDENT_READ', entity: 'student', entity_id: id, meta: opts.breakGlass ? { alert: true, reason: opts.reason } : undefined });
    return this.shape(s, actor, opts);
  }

  async me(actor: Actor) {
    const s = await this.db.run(actor, (tx) => tx.student.findFirst({ where: { user_id: actor.id }, include: { programme: true, placement_state: true } }));
    if (!s) throw new NotFoundException('No student profile is linked to this account.');
    const sw = (s.placement_state?.switching_json ?? null) as Record<string, unknown> | null;
    return { ...this.shape(s, actor), switching: sw };
  }

  async programmes() {
    return this.prisma.programme.findMany({ orderBy: { code: 'asc' } });
  }

  // ------------------------------------------------------------------ writes ----

  private async programmeByCode(code: string) {
    const p = await this.prisma.programme.findUnique({ where: { code } });
    if (!p) throw new BadRequestException({ message: `Unknown programme "${code}".`, code: 'BAD_PROGRAMME' });
    return p;
  }

  private assertProgrammeScope(actor: Actor, programmeId: string) {
    if (actor.role === 'coordinator' && !actor.programmeIds?.includes(programmeId)) throw new ForbiddenException({ message: 'You can only manage students of your own programme.', code: 'OUT_OF_SCOPE' });
  }

  async create(actor: Actor, dto: z.infer<typeof createStudentSchema>) {
    const programme = await this.programmeByCode(dto.programme_code);
    this.assertProgrammeScope(actor, programme.id);
    const dup = await this.duplicates([dto.placement_id], [dto.email], [dto.mobile]);
    if (dup.length) throw new ConflictException({ message: dup[0], code: 'DUPLICATE' });

    const { student, raw, user } = await this.db.run(actor, async (tx) => {
      const acct = await this.users.createAccountRow(tx, { email: dto.email, name: dto.name, role: 'student', created_by: actor.id });
      const student = await tx.student.create({
        data: {
          placement_id: dto.placement_id, name: dto.name, email: dto.email, mobile_enc: this.crypto.encrypt(dto.mobile, MOBILE_AAD), mobile_hash: this.crypto.hmac(dto.mobile, 'mobile'),
          programme_id: programme.id, batch: dto.batch, cgpa: dto.cgpa, backlogs: dto.backlogs, user_id: acct.user.id, created_by: actor.id,
        },
        include: { programme: true, placement_state: true },
      });
      await this.audit.log({ actor, action: 'STUDENT_CREATED', entity: 'student', entity_id: student.id, after: { placement_id: dto.placement_id, programme: dto.programme_code, batch: dto.batch } }, tx);
      return { student, raw: acct.raw, user: acct.user };
    });
    await this.users.sendActivation(user, raw, 'Your coordinator has registered you on the NFSU Placement Portal.');
    await this.engine.recomputeState(student.id);
    return this.shape(student, actor);
  }

  async update(actor: Actor, id: string, dto: z.infer<typeof updateStudentSchema>) {
    const before = await this.db.run(actor, (tx) => tx.student.findFirst({ where: { id, ...this.scopeWhere(actor) } }));
    if (!before) throw new ForbiddenException({ message: 'You do not have access to this student record.', code: 'OUT_OF_SCOPE' });
    if (dto.email && dto.email !== before.email && (await this.duplicates([], [dto.email], [])).length) throw new ConflictException({ message: 'That e-mail is already used by another student.', code: 'DUPLICATE' });
    if (dto.mobile) {
      const h = this.crypto.hmac(dto.mobile, 'mobile');
      if (h !== before.mobile_hash && (await this.prisma.student.count({ where: { mobile_hash: h } }))) throw new ConflictException({ message: 'That mobile number is already used by another student.', code: 'DUPLICATE' });
    }
    const data: Prisma.studentUpdateInput = {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.email !== undefined && { email: dto.email }),
      ...(dto.mobile !== undefined && { mobile_enc: this.crypto.encrypt(dto.mobile, MOBILE_AAD), mobile_hash: this.crypto.hmac(dto.mobile, 'mobile') }),
      ...(dto.batch !== undefined && { batch: dto.batch }),
      ...(dto.cgpa !== undefined && { cgpa: dto.cgpa }),
      ...(dto.backlogs !== undefined && { backlogs: dto.backlogs }),
      ...(dto.registration_status !== undefined && { registration_status: dto.registration_status }),
    };
    const updated = await this.db.run(actor, async (tx) => {
      const u = await tx.student.update({ where: { id }, data, include: { programme: true, placement_state: true } });
      if (dto.email && before.user_id) await tx.user_account.update({ where: { id: before.user_id }, data: { email: dto.email } });
      await this.audit.log({ actor, action: 'STUDENT_UPDATED', entity: 'student', entity_id: id, before: this.diffable(before, dto), after: { ...dto, mobile: dto.mobile ? '[changed]' : undefined } }, tx);
      return u;
    });
    return this.shape(updated, actor);
  }

  private diffable(before: Prisma.studentGetPayload<object>, dto: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(dto)) out[k] = k === 'mobile' ? '[changed]' : (before as Record<string, unknown>)[k];
    return out;
  }

  async setEligibility(actor: Actor, id: string, status: 'eligible' | 'ineligible' | 'pending', reason?: string) {
    const before = await this.db.run(actor, (tx) => tx.student.findFirst({ where: { id, ...this.scopeWhere(actor) } }));
    if (!before) throw new ForbiddenException({ message: 'You do not have access to this student record.', code: 'OUT_OF_SCOPE' });
    await this.db.run(actor, async (tx) => {
      await tx.student.update({ where: { id }, data: { eligibility_status: status } });
      await this.audit.log({ actor, action: 'ELIGIBILITY_SET', entity: 'student', entity_id: id, before: { eligibility_status: before.eligibility_status }, after: { eligibility_status: status }, meta: { reason } }, tx);
    });
  }

  /** The student confirms their own registration (the only thing a student may write on their row; a DB trigger enforces it). */
  async confirmRegistration(actor: Actor) {
    const s = await this.db.run(actor, (tx) => tx.student.findFirst({ where: { user_id: actor.id } }));
    if (!s) throw new NotFoundException('No student profile is linked to this account.');
    if (s.registration_status === 'deregistered') throw new ForbiddenException({ message: 'You have been deregistered. Contact the Placement Cell.', code: 'DEREGISTERED' });
    await this.db.run(actor, async (tx) => {
      await tx.student.update({ where: { id: s.id }, data: { registration_status: 'registered' } });
      await this.audit.log({ actor, action: 'REGISTRATION_CONFIRMED', entity: 'student', entity_id: s.id, before: { registration_status: s.registration_status }, after: { registration_status: 'registered' } }, tx);
    });
  }

  // -------------------------------------------------- contact change requests ----

  async requestContactChange(actor: Actor, field: 'mobile' | 'email', value: string) {
    const s = await this.db.run(actor, (tx) => tx.student.findFirst({ where: { user_id: actor.id } }));
    if (!s) throw new NotFoundException('No student profile is linked to this account.');
    const parsed = field === 'mobile' ? indianMobile.safeParse(value) : emailField.refine(emailDomainOk).safeParse(value);
    if (!parsed.success) throw new BadRequestException({ message: `That ${field} is not valid.`, code: 'BAD_VALUE' });
    const clean = parsed.data as string;
    if (field === 'email' && (await this.duplicates([], [clean], [])).length) throw new ConflictException({ message: 'That e-mail is already registered.', code: 'DUPLICATE' });
    await this.db.run(actor, async (tx) => {
      const r = await tx.contact_change_request.create({ data: { student_id: s.id, field, new_value_enc: this.crypto.encrypt(clean, 'contact_change_request.new_value_enc') } });
      await this.audit.log({ actor, action: 'CONTACT_CHANGE_REQUESTED', entity: 'contact_change_request', entity_id: r.id, meta: { field } }, tx);
    });
  }

  async listContactChanges(actor: Actor) {
    const rows = await this.db.run(actor, (tx) =>
      tx.contact_change_request.findMany({ where: { status: 'pending', student: this.scopeWhere(actor) }, include: { student: { include: { programme: true } } }, orderBy: { created_at: 'asc' }, take: 200 }),
    );
    return rows.map((r) => ({ id: r.id, field: r.field, new_value: this.crypto.decrypt(r.new_value_enc, 'contact_change_request.new_value_enc'), requested_at: r.created_at, student: { id: r.student.id, placement_id: r.student.placement_id, name: r.student.name, programme_code: r.student.programme.code } }));
  }

  async decideContactChange(actor: Actor, id: string, approve: boolean) {
    await this.db.run(actor, async (tx) => {
      const r = await tx.contact_change_request.findFirst({ where: { id, status: 'pending', student: this.scopeWhere(actor) }, include: { student: true } });
      if (!r) throw new ForbiddenException({ message: 'Request not found or not in your scope.', code: 'OUT_OF_SCOPE' });
      const value = this.crypto.decrypt(r.new_value_enc, 'contact_change_request.new_value_enc');
      if (approve) {
        if (r.field === 'mobile') await tx.student.update({ where: { id: r.student_id }, data: { mobile_enc: this.crypto.encrypt(value, MOBILE_AAD), mobile_hash: this.crypto.hmac(value, 'mobile') } });
        else {
          await tx.student.update({ where: { id: r.student_id }, data: { email: value } });
          if (r.student.user_id) await tx.user_account.update({ where: { id: r.student.user_id }, data: { email: value } });
        }
      }
      await tx.contact_change_request.update({ where: { id }, data: { status: approve ? 'approved' : 'rejected', decided_by: actor.id, decided_at: new Date() } });
      await this.audit.log({ actor, action: approve ? 'CONTACT_CHANGE_APPROVED' : 'CONTACT_CHANGE_REJECTED', entity: 'contact_change_request', entity_id: id, meta: { field: r.field, student_id: r.student_id } }, tx);
    });
  }

  // -------------------------------------------------------------- CSV import ----

  /** Duplicate check on Placement ID, e-mail and (hashed) mobile. Returns human-readable reasons. */
  async duplicates(ids: string[], emails: string[], mobiles: string[]): Promise<string[]> {
    const hashes = mobiles.map((m) => this.crypto.hmac(m, 'mobile'));
    const rows = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.role', 'system', true)`; // existence check only, no data returned to the caller
      return tx.student.findMany({ where: { OR: [{ placement_id: { in: ids } }, { email: { in: emails } }, { mobile_hash: { in: hashes } }] }, select: { placement_id: true, email: true, mobile_hash: true } });
    });
    const out: string[] = [];
    for (const r of rows) {
      if (ids.includes(r.placement_id)) out.push(`Placement ID ${r.placement_id} already exists.`);
      if (emails.includes(r.email)) out.push(`E-mail ${r.email} is already registered.`);
      if (hashes.includes(r.mobile_hash)) out.push('Mobile number is already registered to another student.');
    }
    return out;
  }

  /** Validate a CSV and return a row-by-row preview. Nothing is written; clean rows are held for 15 minutes under a token. */
  async previewImport(actor: Actor, csv: Buffer) {
    let records: Record<string, string>[];
    try {
      records = parse(csv, { columns: (h: string[]) => h.map((x) => x.trim().toLowerCase().replace(/\s+/g, '_')), skip_empty_lines: true, trim: true, bom: true, relax_column_count: false }) as Record<string, string>[];
    } catch (e) {
      throw new BadRequestException({ message: `The file is not valid CSV: ${(e as Error).message}`, code: 'BAD_CSV' });
    }
    if (records.length === 0) throw new BadRequestException({ message: 'The file has no data rows.', code: 'EMPTY_CSV' });
    if (records.length > 2000) throw new BadRequestException({ message: 'Import at most 2000 students at a time.', code: 'TOO_MANY_ROWS' });
    const required = ['placement_id', 'name', 'email', 'mobile', 'programme', 'batch'];
    const missing = required.filter((c) => !(c in records[0]));
    if (missing.length) throw new BadRequestException({ message: `Missing column(s): ${missing.join(', ')}. Expected: placement_id, name, email, mobile, programme, batch, cgpa, backlogs.`, code: 'BAD_HEADER' });

    const programmes = new Map((await this.prisma.programme.findMany()).map((p) => [p.code, p]));
    const errors: { row: number; placement_id: string; errors: string[] }[] = [];
    const clean: (z.infer<typeof studentFields> & { programme_id: string })[] = [];
    const seenId = new Set<string>();
    const seenEmail = new Set<string>();
    const seenMobile = new Set<string>();

    records.forEach((rec, i) => {
      const row = i + 2; // header is row 1
      const errs: string[] = [];
      const r = studentFields.safeParse({ placement_id: rec.placement_id, name: rec.name, email: rec.email, mobile: rec.mobile, programme_code: rec.programme, batch: rec.batch, cgpa: rec.cgpa || 0, backlogs: rec.backlogs || 0 });
      if (!r.success) r.error.issues.forEach((x) => errs.push(`${x.path.join('.')}: ${x.message}`));
      else {
        const d = r.data;
        const p = programmes.get(d.programme_code);
        if (!p) errs.push(`programme_code: unknown programme "${d.programme_code}"`);
        else if (actor.role === 'coordinator' && !actor.programmeIds?.includes(p.id)) errs.push(`programme_code: ${d.programme_code} is not your programme`);
        if (seenId.has(d.placement_id)) errs.push('duplicate Placement ID inside this file');
        if (seenEmail.has(d.email)) errs.push('duplicate e-mail inside this file');
        if (seenMobile.has(d.mobile)) errs.push('duplicate mobile number inside this file');
        seenId.add(d.placement_id);
        seenEmail.add(d.email);
        seenMobile.add(d.mobile);
        if (!errs.length && p) clean.push({ ...d, programme_id: p.id });
      }
      if (errs.length) errors.push({ row, placement_id: rec.placement_id ?? '', errors: errs });
    });

    // Duplicates against students already in the database.
    const dbDup = new Map<string, string[]>();
    const existing = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.role', 'system', true)`;
      return tx.student.findMany({ where: { OR: [{ placement_id: { in: clean.map((c) => c.placement_id) } }, { email: { in: clean.map((c) => c.email) } }, { mobile_hash: { in: clean.map((c) => this.crypto.hmac(c.mobile, 'mobile')) } }] }, select: { placement_id: true, email: true, mobile_hash: true } });
    });
    const exId = new Set(existing.map((e) => e.placement_id));
    const exEmail = new Set(existing.map((e) => e.email));
    const exMob = new Set(existing.map((e) => e.mobile_hash));
    const finalClean = clean.filter((c) => {
      const why: string[] = [];
      if (exId.has(c.placement_id)) why.push('Placement ID already exists');
      if (exEmail.has(c.email)) why.push('e-mail already registered');
      if (exMob.has(this.crypto.hmac(c.mobile, 'mobile'))) why.push('mobile already registered');
      if (why.length) dbDup.set(c.placement_id, why);
      return !why.length;
    });
    const rowOf = new Map(records.map((r, i) => [(r.placement_id ?? '').toUpperCase(), i + 2]));
    for (const [pid, why] of dbDup) errors.push({ row: rowOf.get(pid) ?? 0, placement_id: pid, errors: why });
    errors.sort((a, b) => a.row - b.row);

    const token = this.crypto.token(24);
    await this.redis.set(`import:${token}`, JSON.stringify({ actor: actor.id, rows: finalClean, file_hash: this.crypto.sha256(csv) }), 'EX', 15 * 60);
    return { token, total: records.length, valid: finalClean.length, rejected: errors.length, errors: errors.slice(0, 500), sample: finalClean.slice(0, 5).map((c) => ({ placement_id: c.placement_id, name: c.name, programme: c.programme_code, batch: c.batch })) };
  }

  /** Commit only the clean rows from a previewed file. Re-checks scope and duplicates, creates accounts, audits the import. */
  async commitImport(actor: Actor, token: string) {
    const raw = await this.redis.get(`import:${token}`);
    if (!raw) throw new BadRequestException({ message: 'This preview has expired. Upload the file again.', code: 'PREVIEW_EXPIRED' });
    const held = JSON.parse(raw) as { actor: string; rows: (z.infer<typeof studentFields> & { programme_id: string })[]; file_hash: string };
    if (held.actor !== actor.id) throw new ForbiddenException({ message: 'This preview belongs to another user.', code: 'NOT_YOURS' });
    await this.redis.del(`import:${token}`);

    // Re-check duplicates as `system`: a coordinator's own row-level scope cannot see other programmes' students.
    const taken = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.role', 'system', true)`;
      return tx.student.findMany({ where: { OR: [{ placement_id: { in: held.rows.map((r) => r.placement_id) } }, { email: { in: held.rows.map((r) => r.email) } }, { mobile_hash: { in: held.rows.map((r) => this.crypto.hmac(r.mobile, 'mobile')) } }] }, select: { placement_id: true, email: true, mobile_hash: true } });
    });
    const tId = new Set(taken.map((x) => x.placement_id));
    const tEmail = new Set(taken.map((x) => x.email));
    const tMob = new Set(taken.map((x) => x.mobile_hash));

    const created: { user: { email: string; name: string }; raw: string }[] = [];
    let skipped = 0;
    await this.db.run(actor, async (tx) => {
      for (const d of held.rows) {
        if (actor.role === 'coordinator' && !actor.programmeIds?.includes(d.programme_id)) { skipped++; continue; }
        if (tId.has(d.placement_id) || tEmail.has(d.email) || tMob.has(this.crypto.hmac(d.mobile, 'mobile'))) { skipped++; continue; }
        const acct = await this.users.createAccountRow(tx, { email: d.email, name: d.name, role: 'student', created_by: actor.id });
        await tx.student.create({
          data: { placement_id: d.placement_id, name: d.name, email: d.email, mobile_enc: this.crypto.encrypt(d.mobile, MOBILE_AAD), mobile_hash: this.crypto.hmac(d.mobile, 'mobile'), programme_id: d.programme_id, batch: d.batch, cgpa: d.cgpa, backlogs: d.backlogs, user_id: acct.user.id, created_by: actor.id },
        });
        created.push({ user: acct.user, raw: acct.raw });
      }
      await this.audit.log({ actor, action: 'STUDENT_IMPORT', entity: 'student', meta: { created: created.length, skipped, file_sha256: held.file_hash } }, tx);
    }, { timeout: 120_000 });

    for (const c of created) await this.users.sendActivation(c.user, c.raw, 'Your coordinator has registered you on the NFSU Placement Portal.');
    return { created: created.length, skipped };
  }

  // ------------------------------------------------------------------ resume ----

  private resumePath(studentId: string) {
    const dir = resolve(env.UPLOAD_DIR, 'resumes');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return join(dir, `${studentId}.pdf`);
  }

  async saveResume(actor: Actor, file: { buffer: Buffer; size: number }) {
    if (file.size > 2 * 1024 * 1024) throw new BadRequestException({ message: 'Resume must be 2 MB or smaller.', code: 'TOO_LARGE' });
    if (file.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') throw new BadRequestException({ message: 'Resume must be a PDF file.', code: 'BAD_FILE_TYPE' });
    const s = await this.db.run(actor, (tx) => tx.student.findFirst({ where: { user_id: actor.id } }));
    if (!s) throw new NotFoundException('No student profile is linked to this account.');
    await writeFile(this.resumePath(s.id), file.buffer); // filename is our id, never the client's
    await this.db.run(actor, async (tx) => {
      await tx.student.update({ where: { id: s.id }, data: { resume_path: `resumes/${s.id}.pdf` } });
      await this.audit.log({ actor, action: 'RESUME_UPLOADED', entity: 'student', entity_id: s.id, meta: { bytes: file.size, sha256: this.crypto.sha256(file.buffer) } }, tx);
    });
  }

  async readResume(actor: Actor, studentId: string): Promise<Buffer> {
    const s = await this.db.run(actor, (tx) => tx.student.findFirst({ where: { id: studentId, ...this.scopeWhere(actor) } }));
    if (!s?.resume_path) throw new NotFoundException('No resume on file.');
    await this.audit.log({ actor, action: 'RESUME_READ', entity: 'student', entity_id: studentId });
    return readFile(this.resumePath(studentId));
  }

  // utility for other services ------------------------------------------------------------------------------------------
  async idsInScope(tx: Tx, actor: Actor): Promise<string[] | null> {
    if (actor.role === 'officer' || actor.role === 'admin' || actor.role === 'system') return null;
    const rows = await tx.student.findMany({ where: this.scopeWhere(actor), select: { id: true } });
    return rows.map((r) => r.id);
  }
}

export { SYSTEM_ACTOR };
