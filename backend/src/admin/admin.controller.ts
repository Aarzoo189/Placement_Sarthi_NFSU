import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentActor, Roles, StepUp } from '../common/decorators';
import { Actor } from '../common/types';
import { emailField, ZodPipe, text } from '../common/zod.pipe';
import { PolicyService, proposeSchema } from '../policy/policy.service';
import { UsersService } from '../users/users.service';
import { AuditService } from '../common/audit.service';
import { DbService, PrismaService } from '../common/prisma.service';
import { SystemService, settingsSchema, drillSchema } from './system.service';

const createUserSchema = z
  .object({
    email: emailField,
    name: text(120).pipe(z.string().min(2)),
    role: z.enum(['student', 'coordinator', 'officer', 'hr', 'admin', 'superadmin']),
    programme_ids: z.array(z.string().uuid()).max(10).optional(),
    company_id: z.string().uuid().optional(),
    valid_until: z.coerce.date().optional(),
  })
  .strict();
const statusSchema = z.object({ status: z.enum(['active', 'disabled']), reason: text(300).pipe(z.string().min(5)) }).strict();
const mfaResetSchema = z.object({ reason: text(400).pipe(z.string().min(15, 'Record how the person was identified (at least 15 characters)')) }).strict();
const scopeSchema = z.object({ programme_ids: z.array(z.string().uuid()).min(1).max(10) }).strict();
const rejectSchema = z.object({ reason: text(300).pipe(z.string().min(5)) }).strict();
const auditQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
  actor_id: z.string().uuid().optional(),
  action: z.string().max(60).optional(),
  entity: z.string().max(40).optional(),
  entity_id: z.string().max(80).optional(),
  alerts_only: z.enum(['true', 'false']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/** User administration, policy governance, system settings and the audit log. */
@Controller()
export class AdminController {
  constructor(
    private readonly users: UsersService,
    private readonly policy: PolicyService,
    private readonly system: SystemService,
    private readonly audit: AuditService,
    private readonly db: DbService,
    private readonly prisma: PrismaService,
  ) {}

  // ------------------------------------------------------------------- users ----

  /** Admin manages everyone below Admin; Super Admin manages Admins and Super Admins. */
  @Roles('admin', 'superadmin')
  @Get('users')
  listUsers(@CurrentActor() a: Actor, @Query('q') q?: string) {
    return this.users.list(a, q?.slice(0, 100));
  }

  @Roles('admin', 'superadmin')
  @StepUp()
  @Post('users')
  createUser(@CurrentActor() a: Actor, @Body(new ZodPipe(createUserSchema)) b: z.infer<typeof createUserSchema>) {
    return this.users.create(a, b);
  }

  @Roles('admin', 'superadmin')
  @StepUp()
  @Post('users/:id/status')
  @HttpCode(204)
  setStatus(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(statusSchema)) b: z.infer<typeof statusSchema>) {
    return this.users.setStatus(a, id, b.status, b.reason);
  }

  @Roles('admin', 'superadmin')
  @StepUp()
  @Post('users/:id/mfa-reset')
  @HttpCode(204)
  resetMfa(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(mfaResetSchema)) b: z.infer<typeof mfaResetSchema>) {
    return this.users.resetMfa(a, id, b.reason);
  }

  @Roles('admin', 'superadmin')
  @Post('users/:id/resend-activation')
  @HttpCode(204)
  resend(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.users.resendActivation(a, id);
  }

  @Roles('admin')
  @StepUp()
  @Put('users/:id/scope')
  @HttpCode(204)
  scope(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(scopeSchema)) b: z.infer<typeof scopeSchema>) {
    return this.users.setCoordinatorScope(a, id, b.programme_ids);
  }

  // ------------------------------------------------------------------ policy ----

  @Roles('student', 'coordinator', 'officer', 'admin', 'superadmin')
  @Get('policy/current')
  current() {
    return this.policy.current();
  }

  @Roles('officer', 'admin', 'superadmin')
  @Get('policy/versions')
  versions() {
    return this.policy.versions();
  }

  /** Officer proposes, Admin drafts: nothing changes until a DIFFERENT person, the Super Admin, approves and publishes. */
  @Roles('officer', 'admin')
  @StepUp()
  @Post('policy/propose')
  propose(@CurrentActor() a: Actor, @Body(new ZodPipe(proposeSchema)) b: z.infer<typeof proposeSchema>) {
    return this.policy.propose(a, b);
  }

  @Roles('superadmin')
  @Post('policy/:version/publish')
  @HttpCode(200)
  publish(@CurrentActor() a: Actor, @Param('version', ParseIntPipe) v: number) {
    return this.policy.publish(a, v);
  }

  @Roles('superadmin')
  @Post('policy/:version/reject')
  @HttpCode(204)
  reject(@CurrentActor() a: Actor, @Param('version', ParseIntPipe) v: number, @Body(new ZodPipe(rejectSchema)) b: z.infer<typeof rejectSchema>) {
    return this.policy.reject(a, v, b.reason);
  }

  // ------------------------------------------------------------------- audit ----

  /**
   * Admin / Super Admin: everything. Placement Officer: their own actions and the operational activity of coordinators, students
   * and company users (not administrator activity).
   */
  @Roles('officer', 'admin', 'superadmin')
  @Get('audit')
  async auditList(@CurrentActor() a: Actor, @Query(new ZodPipe(auditQuery)) q: z.infer<typeof auditQuery>) {
    const where = {
      AND: [
        a.role === 'officer' ? { OR: [{ actor_id: a.id }, { role: { in: ['coordinator', 'student', 'hr'] } }] } : {},
        q.actor_id ? { actor_id: q.actor_id } : {},
        q.action ? { action: { contains: q.action.toUpperCase() } } : {},
        q.entity ? { entity: q.entity } : {},
        q.entity_id ? { entity_id: q.entity_id } : {},
        q.from || q.to ? { at: { ...(q.from && { gte: q.from }), ...(q.to && { lte: q.to }) } } : {},
        q.alerts_only === 'true' ? { OR: [{ meta: { path: ['alert'], equals: true } }, { action: { in: ['ACCESS_DENIED', 'TAMPER_ATTEMPT', 'LOGIN_LOCKOUT', 'MFA_LOCKOUT'] } }] } : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.audit_log.findMany({ where, orderBy: { id: 'desc' }, skip: (q.page - 1) * q.page_size, take: q.page_size }),
      this.prisma.audit_log.count({ where }),
    ]);
    return { total, page: q.page, page_size: q.page_size, items: rows.map((r) => ({ id: r.id.toString(), at: r.at, actor_id: r.actor_id, role: r.role, action: r.action, entity: r.entity, entity_id: r.entity_id, before: r.before_json, after: r.after_json, meta: r.meta, ip: r.ip, hash: r.hash.slice(0, 16) })) };
  }

  /** Walks the whole hash chain and reports the first edited / deleted / reordered row. */
  @Roles('superadmin', 'admin')
  @Get('audit/verify')
  async verify(@CurrentActor() a: Actor) {
    const res = await this.audit.verifyChain();
    await this.audit.log({ actor: a, action: 'AUDIT_CHAIN_VERIFIED', meta: { ok: res.ok, checked: res.checked, broken_at: res.broken_at, alert: !res.ok } });
    return res;
  }

  // ------------------------------------------------------------------ system ----

  @Roles('superadmin')
  @Get('system/settings')
  settings() {
    return this.system.settings();
  }

  @Roles('superadmin')
  @Put('system/settings')
  updateSettings(@CurrentActor() a: Actor, @Body(new ZodPipe(settingsSchema)) b: z.infer<typeof settingsSchema>) {
    return this.system.updateSettings(a, b);
  }

  @Roles('superadmin')
  @Get('system/status')
  status() {
    return this.system.status();
  }

  @Roles('superadmin')
  @Get('system/backups')
  backups() {
    return this.system.backups();
  }

  @Roles('superadmin')
  @Post('system/restore-drills')
  recordDrill(@CurrentActor() a: Actor, @Body(new ZodPipe(drillSchema)) b: z.infer<typeof drillSchema>) {
    return this.system.recordDrill(a, b);
  }
}
