import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';
import { AuditService } from './audit.service';
import { DbService, SYSTEM_ACTOR } from './prisma.service';
import { AuthedRequest } from './decorators';

/** Fields a client must never be able to set: they are computed by the server. Sending one is logged as tampering. */
const DERIVED_KEYS = new Set([
  'placement_status',
  'current_category',
  'category',
  'ctc',
  'ctc_lpa',
  'ctc_enc',
  'stipend',
  'stipend_enc',
  'highest_ctc',
  'switching_json',
  'eligibility_status',
  'role',
  'user_id',
  'programme_id',
  'acceptance_status',
  'policy_version',
]);

/**
 * One place that turns every failure into a safe response and a log entry:
 *  - 403 -> audit entry "ACCESS_DENIED" (architecture doc: "403 + audit entry")
 *  - a state-changing request that names a server-computed field -> "TAMPER_ATTEMPT" (alert) and, for students,
 *    a case in the Officer's review queue ("attempt is logged and alerted")
 *  - unexpected errors -> generic 500 body; details go to the server log only
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Http');

  constructor(
    private readonly audit: AuditService,
    private readonly db: DbService,
  ) {}

  async catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<AuthedRequest>();

    const { status, body } = this.normalise(exception);

    try {
      if (status === HttpStatus.FORBIDDEN || (status === HttpStatus.BAD_REQUEST && this.hasDerivedKeys(req))) await this.record(req, status, body);
    } catch (e) {
      this.log.error(`Could not write security audit entry: ${(e as Error).message}`);
    }

    if (status >= 500) this.log.error(`${req.method} ${req.path}: ${exception instanceof Error ? exception.stack : String(exception)}`);
    res.status(status).json(body);
  }

  private normalise(e: unknown): { status: number; body: Record<string, unknown> } {
    if (e instanceof HttpException) {
      const r = e.getResponse();
      const status = e.getStatus();
      const body = typeof r === 'string' ? { message: r } : (r as Record<string, unknown>);
      return { status, body: { statusCode: status, ...body, message: body.message ?? e.message } };
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === 'P2002') return { status: 409, body: { statusCode: 409, message: 'This record already exists.', code: 'DUPLICATE' } };
      if (e.code === 'P2025') return { status: 404, body: { statusCode: 404, message: 'Record not found.', code: 'NOT_FOUND' } };
    }
    const msg = e instanceof Error ? e.message : '';
    // Row-level-security / trigger rejections come back from Postgres as SQLSTATE 42501.
    if (/row-level security|42501|may only (accept|change)|immutable/i.test(msg)) {
      return { status: 403, body: { statusCode: 403, message: 'You do not have access to this record.', code: 'DB_POLICY_DENIED' } };
    }
    if (/23514|violates check constraint/i.test(msg)) return { status: 400, body: { statusCode: 400, message: 'The value is outside the allowed range.', code: 'CONSTRAINT' } };
    return { status: 500, body: { statusCode: 500, message: 'Something went wrong. Please try again.', code: 'INTERNAL' } };
  }

  private bodyKeys(req: AuthedRequest): string[] {
    const b = req.body as unknown;
    return b && typeof b === 'object' && !Array.isArray(b) ? Object.keys(b as object) : [];
  }

  private hasDerivedKeys(req: AuthedRequest) {
    return !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && this.bodyKeys(req).some((k) => DERIVED_KEYS.has(k));
  }

  private async record(req: AuthedRequest, status: number, body: Record<string, unknown>) {
    const actor = req.user;
    if (!actor) return; // unauthenticated probes are not attributable
    const path = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path;
    const tampered = this.bodyKeys(req).filter((k) => DERIVED_KEYS.has(k));

    if (status === HttpStatus.FORBIDDEN) {
      await this.audit.log({ actor, action: 'ACCESS_DENIED', entity: 'route', entity_id: `${req.method} ${path}`, ip: req.ip, meta: { code: body.code, params: req.params } });
    }
    if (tampered.length) {
      await this.audit.log({ actor, action: 'TAMPER_ATTEMPT', entity: 'route', entity_id: `${req.method} ${path}`, ip: req.ip, meta: { alert: true, fields: tampered, status } });
      if (actor.role === 'student') {
        // Row-level security lets only the `system` role open review cases, so this runs as system.
        await this.db.run(SYSTEM_ACTOR, async (tx) => {
          const st = await tx.student.findFirst({ where: { user_id: actor.id }, select: { id: true, programme_id: true } });
          await tx.review_case.create({
            data: { kind: 'violation', student_id: st?.id ?? null, programme_id: st?.programme_id ?? null, payload: { summary: `Attempted to set server-computed field(s): ${tampered.join(', ')}`, route: `${req.method} ${path}` } },
          });
        });
      }
    }
  }
}
