import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard, PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-custom';
import { Request } from 'express';
import { AuthedRequest, IS_PUBLIC, ROLES_KEY, STAGES_KEY, STEP_UP_KEY } from '../common/decorators';
import { Actor, RoleName, SessionStage } from '../common/types';
import { CryptoService } from '../common/crypto.service';
import { env } from '../config/env';
import { SESSION_COOKIE, SessionService } from './session.service';

export const SKIP_STEP_UP = 'skipStepUp';
/** The step-up and logout endpoints themselves must not demand a step-up. */
export const NoStepUp = () => SetMetadata(SKIP_STEP_UP, true);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Passport strategy: cookie -> server-side session -> actor. */
@Injectable()
export class SessionStrategy extends PassportStrategy(Strategy, 'session') {
  constructor(private readonly sessions: SessionService) {
    super();
  }

  async validate(req: AuthedRequest): Promise<Actor> {
    const s = await this.sessions.get(req.cookies?.[SESSION_COOKIE]);
    if (!s) throw new UnauthorizedException({ message: 'Not signed in', code: 'NO_SESSION' });
    req.session_data = s;
    return { id: s.user_id, role: s.role, email: s.email, ip: req.ip, programmeIds: s.programme_ids, companyId: s.company_id };
  }
}

/** 1. Authenticate: resolve the session cookie. Skipped for @Public routes. */
@Injectable()
export class SessionAuthGuard extends AuthGuard('session') {
  constructor(private readonly reflector: Reflector) {
    super();
  }
  canActivate(ctx: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    return super.canActivate(ctx);
  }
}

/**
 * 2. CSRF. Two independent defences on every state-changing request:
 *    (a) the Origin header must be our web origin (SameSite=Strict already blocks cross-site cookies; this also stops
 *        a compromised sibling subdomain), and
 *    (b) for signed-in sessions, the X-CSRF-Token header must equal the token bound to the session.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly crypto: CryptoService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (SAFE_METHODS.has(req.method)) return true;

    const origin = req.headers.origin ?? originOf(req.headers.referer);
    if (origin !== env.WEB_ORIGIN) throw new ForbiddenException({ message: 'Request origin not allowed', code: 'BAD_ORIGIN' });

    if (req.session_data) {
      const sent = req.headers['x-csrf-token'];
      if (typeof sent !== 'string' || !this.crypto.safeEqual(sent, req.session_data.csrf)) {
        throw new ForbiddenException({ message: 'Missing or invalid CSRF token', code: 'BAD_CSRF' });
      }
    }
    return true;
  }
}

function originOf(referer?: string): string | undefined {
  try {
    return referer ? new URL(referer).origin : undefined;
  } catch {
    return undefined;
  }
}

/** 3. Deny by default: a route needs @Public() or @Roles(...). Also enforces the session stage (password only vs MFA complete). */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const s = req.session_data;
    if (!s) throw new UnauthorizedException({ message: 'Not signed in', code: 'NO_SESSION' });

    const roles = this.reflector.getAllAndOverride<RoleName[]>(ROLES_KEY, targets);
    if (!roles?.length) throw new ForbiddenException({ message: 'No access rule is defined for this route (deny by default)', code: 'NO_RULE' });

    const stages = this.reflector.getAllAndOverride<SessionStage[]>(STAGES_KEY, targets) ?? ['full'];
    if (!stages.includes(s.stage)) {
      throw new UnauthorizedException({ message: s.stage === 'enrol_pending' ? 'MFA enrolment required' : 'MFA required', code: s.stage === 'enrol_pending' ? 'ENROL_REQUIRED' : 'MFA_REQUIRED', stage: s.stage });
    }
    if (!roles.includes(s.role)) throw new ForbiddenException({ message: 'Your role cannot perform this action', code: 'ROLE_DENIED' });
    return true;
  }
}

/** 4. Step-up MFA for sensitive actions. Super Admin needs a fresh step-up for every state-changing call. */
@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(SKIP_STEP_UP, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request & AuthedRequest>();
    const s = req.session_data;
    if (!s || s.stage !== 'full') return true; // RolesGuard already decided
    const flagged = this.reflector.getAllAndOverride<boolean>(STEP_UP_KEY, targets);
    const superAdminWrite = s.role === 'superadmin' && !SAFE_METHODS.has(req.method);
    if ((flagged || superAdminWrite) && !this.sessions.hasFreshStepUp(s)) {
      throw new UnauthorizedException({ message: 'Confirm with your second factor to continue', code: 'STEP_UP_REQUIRED' });
    }
    return true;
  }
}
