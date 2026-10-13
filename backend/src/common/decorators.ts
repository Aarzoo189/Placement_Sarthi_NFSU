import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Request } from 'express';
import { Actor, RoleName, SessionData, SessionStage } from './types';

export const IS_PUBLIC = 'isPublic';
export const ROLES_KEY = 'roles';
export const STAGES_KEY = 'stages';
export const STEP_UP_KEY = 'stepUp';

/** No session needed (login, activation, health). Everything else is deny-by-default. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Roles allowed on this route. A route with neither @Public nor @Roles is rejected: access is deny-by-default. */
export const Roles = (...roles: RoleName[]) => SetMetadata(ROLES_KEY, roles);

/** Any signed-in role (still needs a fully authenticated session). */
export const AnyRole = () => SetMetadata(ROLES_KEY, ['student', 'coordinator', 'officer', 'hr', 'admin', 'superadmin'] as RoleName[]);

/** Session stages allowed on this route. Default is `full` (password + MFA done). */
export const Stages = (...stages: SessionStage[]) => SetMetadata(STAGES_KEY, stages);

/** Route needs a recent step-up (fresh MFA). */
export const StepUp = () => SetMetadata(STEP_UP_KEY, true);

export interface AuthedRequest extends Request {
  user?: Actor;
  session_data?: SessionData;
}

export const CurrentActor = createParamDecorator((_d: unknown, ctx: ExecutionContext): Actor => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().user as Actor;
});

export const CurrentSession = createParamDecorator((_d: unknown, ctx: ExecutionContext): SessionData => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().session_data as SessionData;
});

export const ClientIp = createParamDecorator((_d: unknown, ctx: ExecutionContext): string => {
  return ctx.switchToHttp().getRequest<Request>().ip ?? '';
});
