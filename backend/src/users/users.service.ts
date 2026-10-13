import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Role, UserStatus } from '@prisma/client';
import { PrismaService, Tx } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { MailService } from '../common/mail.service';
import { AuditService } from '../common/audit.service';
import { SessionService } from '../auth/session.service';
import { Actor, RoleName } from '../common/types';
import { env } from '../config/env';

const BELOW_ADMIN: Role[] = ['student', 'coordinator', 'officer', 'hr'];
const PLATFORM: Role[] = ['admin', 'superadmin'];

/** Which roles an actor may manage (architecture doc section 3: Admin = all roles below Admin; Super Admin = Admins and Super Admins). */
export const manageableRoles = (role: RoleName): Role[] => (role === 'admin' ? BELOW_ADMIN : role === 'superadmin' ? PLATFORM : []);

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly mail: MailService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  activationLink(rawToken: string) {
    return `${env.WEB_ORIGIN}/activate?token=${rawToken}`;
  }

  /** Create the account row inside the caller's transaction; the e-mail is sent after commit via `sendActivation`. */
  async createAccountRow(tx: Tx | PrismaService, data: { email: string; name: string; role: Role; created_by?: string | null; ttlHours?: number }) {
    const raw = this.crypto.token(32);
    const user = await tx.user_account.create({
      data: {
        email: data.email.toLowerCase(),
        name: data.name,
        role: data.role,
        status: 'invited',
        created_by: data.created_by ?? null,
        activation_token_hash: this.crypto.sha256(raw),
        activation_expires: new Date(Date.now() + (data.ttlHours ?? 24) * 3600_000),
      },
    });
    return { user, raw };
  }

  async sendActivation(user: { email: string; name: string }, raw: string, why = 'You have been added to the NFSU Placement Portal.') {
    await this.mail.send(
      user.email,
      'Activate your NFSU Placement Portal account',
      `Hello ${user.name},\n\n${why}\n\nSet your password and register your second factor here (the link works once and expires in 24 hours):\n${this.activationLink(raw)}\n\nYou will not be able to see any data until multi-factor authentication is set up.`,
    );
  }

  async create(actor: Actor, input: { email: string; name: string; role: Role; programme_ids?: string[]; company_id?: string; valid_until?: Date }) {
    if (!manageableRoles(actor.role as RoleName).includes(input.role)) throw new ForbiddenException({ message: `Your role cannot create ${input.role} accounts`, code: 'ROLE_DENIED' });
    if (input.role === 'superadmin') {
      const count = await this.prisma.user_account.count({ where: { role: 'superadmin', status: { not: 'disabled' } } });
      if (count >= env.MAX_SUPER_ADMINS) throw new ConflictException({ message: `At most ${env.MAX_SUPER_ADMINS} Super Admin accounts are allowed.`, code: 'MAX_SUPER_ADMINS' });
    }
    if (input.role === 'coordinator' && !input.programme_ids?.length) throw new BadRequestException({ message: 'A coordinator needs at least one programme.', code: 'SCOPE_REQUIRED' });
    if (input.role === 'hr' && (!input.company_id || !input.valid_until)) throw new BadRequestException({ message: 'An HR account needs a company and an expiry date.', code: 'SCOPE_REQUIRED' });
    if (await this.prisma.user_account.findUnique({ where: { email: input.email.toLowerCase() } })) throw new ConflictException({ message: 'An account with this e-mail already exists.', code: 'DUPLICATE' });

    const { user, raw } = await this.prisma.$transaction(async (tx) => {
      const r = await this.createAccountRow(tx, { email: input.email, name: input.name, role: input.role, created_by: actor.id });
      if (input.role === 'coordinator') await tx.coordinator_scope.createMany({ data: input.programme_ids!.map((programme_id) => ({ user_id: r.user.id, programme_id })) });
      if (input.role === 'hr') await tx.hr_user.create({ data: { user_id: r.user.id, company_id: input.company_id!, valid_until: input.valid_until! } });
      await this.audit.log({ actor, action: 'USER_CREATED', entity: 'user_account', entity_id: r.user.id, after: { email: r.user.email, role: r.user.role, programme_ids: input.programme_ids, company_id: input.company_id } }, tx);
      return r;
    });
    await this.sendActivation(user, raw);
    return this.shape(user);
  }

  async list(actor: Actor, q?: string) {
    const roles = manageableRoles(actor.role as RoleName);
    const rows = await this.prisma.user_account.findMany({
      where: { role: { in: roles }, ...(q ? { OR: [{ email: { contains: q.toLowerCase() } }, { name: { contains: q, mode: 'insensitive' } }] } : {}) },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
      take: 500,
      include: { coordinator_scope: { include: { programme: true } }, hr_user: { include: { company: true } } },
    });
    return rows.map((u) => ({
      ...this.shape(u),
      programmes: u.coordinator_scope.map((s) => s.programme.code),
      company: u.hr_user?.company.name ?? null,
      valid_until: u.hr_user?.valid_until ?? null,
    }));
  }

  private shape(u: { id: string; email: string; name: string; role: Role; status: UserStatus; mfa_enrolled: boolean; last_login: Date | null; created_at: Date }) {
    return { id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, mfa_enrolled: u.mfa_enrolled, last_login: u.last_login, created_at: u.created_at };
  }

  private async target(actor: Actor, id: string) {
    const u = await this.prisma.user_account.findUnique({ where: { id } });
    if (!u) throw new NotFoundException('User not found');
    if (!manageableRoles(actor.role as RoleName).includes(u.role)) throw new ForbiddenException({ message: 'Your role cannot manage this account', code: 'ROLE_DENIED' });
    return u;
  }

  async setStatus(actor: Actor, id: string, status: 'active' | 'disabled', reason: string) {
    const u = await this.target(actor, id);
    if (u.id === actor.id) throw new ForbiddenException({ message: 'You cannot change your own account status.', code: 'SELF_ACTION' });
    if (status === 'active' && !u.password_hash) throw new BadRequestException({ message: 'This account has not been activated yet.', code: 'NOT_ACTIVATED' });
    if (u.role === 'superadmin' && status === 'disabled') {
      const left = await this.prisma.user_account.count({ where: { role: 'superadmin', status: 'active', id: { not: u.id } } });
      if (left < 1) throw new ConflictException({ message: 'The last active Super Admin cannot be disabled.', code: 'LAST_SUPERADMIN' });
    }
    await this.prisma.user_account.update({ where: { id }, data: { status } });
    if (status === 'disabled') await this.sessions.destroyAll(id); // leavers lose access immediately
    await this.audit.log({ actor, action: status === 'disabled' ? 'USER_DISABLED' : 'USER_ENABLED', entity: 'user_account', entity_id: id, before: { status: u.status }, after: { status }, meta: { reason } });
  }

  /**
   * MFA reset: admin-only, needs identity verification (the reason records how), writes an audit entry, e-mails the user.
   * A Super Admin can be reset only by the OTHER Super Admin, never by themselves.
   */
  async resetMfa(actor: Actor, id: string, reason: string) {
    const u = await this.target(actor, id);
    if (u.id === actor.id) throw new ForbiddenException({ message: 'You cannot reset your own MFA. Ask another administrator.', code: 'SELF_ACTION' });
    await this.prisma.$transaction(async (tx) => {
      await tx.mfa_factor.deleteMany({ where: { user_id: id } });
      await tx.recovery_code.deleteMany({ where: { user_id: id } });
      await tx.trusted_device.deleteMany({ where: { user_id: id } });
      await tx.user_account.update({ where: { id }, data: { mfa_enrolled: false } });
      await this.audit.log({ actor, action: 'MFA_RESET', entity: 'user_account', entity_id: id, meta: { reason, target_role: u.role, alert: true } }, tx);
    });
    await this.sessions.destroyAll(id);
    await this.mail.send(u.email, 'Your multi-factor authentication was reset', `An administrator reset the second factor on your NFSU Placement Portal account (${new Date().toISOString()}). You will be asked to register a new one the next time you sign in.\n\nIf you did not ask for this, contact the Placement Cell immediately.`);
  }

  async resendActivation(actor: Actor, id: string) {
    const u = await this.target(actor, id);
    if (u.password_hash) throw new ConflictException({ message: 'This account is already activated.', code: 'ALREADY_ACTIVE' });
    const raw = this.crypto.token(32);
    await this.prisma.user_account.update({ where: { id }, data: { activation_token_hash: this.crypto.sha256(raw), activation_expires: new Date(Date.now() + 24 * 3600_000) } });
    await this.sendActivation(u, raw);
    await this.audit.log({ actor, action: 'ACTIVATION_RESENT', entity: 'user_account', entity_id: id });
  }

  async setCoordinatorScope(actor: Actor, id: string, programmeIds: string[]) {
    const u = await this.target(actor, id);
    if (u.role !== 'coordinator') throw new BadRequestException({ message: 'Only coordinators have a programme scope.', code: 'NOT_COORDINATOR' });
    const before = await this.prisma.coordinator_scope.findMany({ where: { user_id: id } });
    await this.prisma.$transaction(async (tx) => {
      await tx.coordinator_scope.deleteMany({ where: { user_id: id } });
      await tx.coordinator_scope.createMany({ data: programmeIds.map((programme_id) => ({ user_id: id, programme_id })) });
      await this.audit.log({ actor, action: 'COORDINATOR_SCOPE_CHANGED', entity: 'user_account', entity_id: id, before: before.map((b) => b.programme_id), after: programmeIds }, tx);
    });
    await this.sessions.destroyAll(id); // the scope is cached in the session: force a fresh sign-in
  }
}
