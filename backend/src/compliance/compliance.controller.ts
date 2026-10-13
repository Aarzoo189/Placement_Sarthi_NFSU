import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentActor, Roles, StepUp } from '../common/decorators';
import { Actor } from '../common/types';
import { ZodPipe, text } from '../common/zod.pipe';
import { AttendanceService, attendanceSchema } from './attendance.service';
import { ExceptionsService, createExceptionSchema, decideRequestSchema, requestExceptionSchema } from './exceptions.service';
import { ReviewService, resolveSchema } from './review.service';

const statusQuery = z.object({ status: z.enum(['open', 'closed']).default('open') });
const revokeSchema = z.object({ reason: text(300).pipe(z.string().min(5)) }).strict();

@Controller()
export class ComplianceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly exceptions: ExceptionsService,
    private readonly review: ReviewService,
  ) {}

  // ---------------------------------------------------------------- attendance ----

  @Roles('coordinator', 'officer', 'hr', 'admin')
  @Post('attendance')
  @HttpCode(200)
  mark(@CurrentActor() a: Actor, @Body(new ZodPipe(attendanceSchema)) b: z.infer<typeof attendanceSchema>) {
    return this.attendance.record(a, b);
  }

  @Roles('student')
  @Get('attendance/mine')
  mine(@CurrentActor() a: Actor) {
    return this.attendance.mine(a);
  }

  @Roles('coordinator', 'officer', 'hr', 'admin')
  @Get('attendance/drive/:driveId')
  forDrive(@CurrentActor() a: Actor, @Param('driveId', ParseUUIDPipe) id: string) {
    return this.attendance.forDrive(a, id);
  }

  // ---------------------------------------------------------------- exceptions ----

  /** Only a Placement Officer or Admin records an exception: reason + expiry required, step-up MFA. */
  @Roles('officer', 'admin')
  @StepUp()
  @Post('exceptions')
  createException(@CurrentActor() a: Actor, @Body(new ZodPipe(createExceptionSchema)) b: z.infer<typeof createExceptionSchema>) {
    return this.exceptions.create(a, b);
  }

  @Roles('coordinator', 'officer', 'admin', 'superadmin')
  @Get('exceptions')
  listExceptions(@CurrentActor() a: Actor) {
    return this.exceptions.list(a);
  }

  @Roles('coordinator', 'officer', 'admin')
  @Get('exceptions/student/:studentId')
  activeFor(@CurrentActor() a: Actor, @Param('studentId', ParseUUIDPipe) id: string) {
    return this.exceptions.activeFor(a, id);
  }

  @Roles('officer', 'admin')
  @StepUp()
  @Delete('exceptions/:id')
  @HttpCode(204)
  revoke(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(revokeSchema)) b: z.infer<typeof revokeSchema>) {
    return this.exceptions.revoke(a, id, b.reason);
  }

  @Roles('coordinator')
  @Post('exceptions/requests')
  requestException(@CurrentActor() a: Actor, @Body(new ZodPipe(requestExceptionSchema)) b: z.infer<typeof requestExceptionSchema>) {
    return this.exceptions.request(a, b);
  }

  @Roles('coordinator', 'officer', 'admin')
  @Get('exceptions/requests')
  listRequests(@CurrentActor() a: Actor) {
    return this.exceptions.listRequests(a);
  }

  @Roles('officer', 'admin')
  @StepUp()
  @Post('exceptions/requests/:id/decide')
  @HttpCode(200)
  decide(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(decideRequestSchema)) b: z.infer<typeof decideRequestSchema>) {
    return this.exceptions.decide(a, id, b);
  }

  // -------------------------------------------------------------- review queue ----

  @Roles('officer', 'admin', 'coordinator')
  @Get('review')
  reviewList(@CurrentActor() a: Actor, @Query(new ZodPipe(statusQuery)) q: z.infer<typeof statusQuery>) {
    return this.review.list(a, q.status);
  }

  @Roles('officer', 'admin', 'coordinator')
  @Get('review/counts')
  reviewCounts(@CurrentActor() a: Actor) {
    return this.review.counts(a);
  }

  /** Approve an exception or confirm the block, with a written reason. Approving needs step-up MFA. */
  @Roles('officer', 'admin')
  @StepUp()
  @Post('review/:id/resolve')
  @HttpCode(200)
  resolve(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(resolveSchema)) b: z.infer<typeof resolveSchema>) {
    return this.review.resolve(a, id, b);
  }
}
