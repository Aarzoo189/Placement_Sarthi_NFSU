import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentActor, Roles, StepUp } from '../common/decorators';
import { Actor } from '../common/types';
import { ZodPipe, text } from '../common/zod.pipe';
import { OffersService, correctSchema, directOfferSchema, lifecycleSchema, proposeSchema, respondSchema } from './offers.service';

const listQuery = z.object({ student_id: z.string().uuid().optional(), status: z.enum(['pending', 'accepted', 'declined', 'expired']).optional() }).strict();
const rejectSchema = z.object({ reason: text(300).pipe(z.string().min(5)) }).strict();

/**
 * Offers. Note the shape of the permissions (architecture doc, section 3):
 *   - nobody sets placement status: it is derived by the rule engine after every offer event
 *   - CTC is written only by the offer workflow (confirm a proposal / direct offer / logged correction)
 *   - a student's only write is accept or decline
 */
@Controller('offers')
export class OffersController {
  constructor(private readonly offers: OffersService) {}

  @Roles('student', 'coordinator', 'officer', 'hr', 'admin')
  @Get()
  list(@CurrentActor() a: Actor, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.offers.list(a, q);
  }

  // ---- HR proposes, Officer confirms ----

  @Roles('hr')
  @StepUp()
  @Post('proposals')
  propose(@CurrentActor() a: Actor, @Body(new ZodPipe(proposeSchema)) b: z.infer<typeof proposeSchema>) {
    return this.offers.propose(a, b);
  }

  @Roles('hr', 'officer', 'admin')
  @Get('proposals')
  proposals(@CurrentActor() a: Actor) {
    return this.offers.listProposals(a);
  }

  @Roles('officer', 'admin')
  @StepUp()
  @Post('proposals/:id/confirm')
  @HttpCode(200)
  confirm(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.offers.confirmProposal(a, id);
  }

  @Roles('officer', 'admin')
  @Post('proposals/:id/reject')
  @HttpCode(204)
  reject(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(rejectSchema)) b: z.infer<typeof rejectSchema>) {
    return this.offers.rejectProposal(a, id, b.reason);
  }

  // ---- direct / off-campus offers (coordinator: own programme) ----

  @Roles('coordinator', 'officer', 'admin')
  @StepUp()
  @Post()
  create(@CurrentActor() a: Actor, @Body(new ZodPipe(directOfferSchema)) b: z.infer<typeof directOfferSchema>) {
    return this.offers.createDirect(a, b);
  }

  // ---- student ----

  @Roles('student')
  @StepUp()
  @Post(':id/respond')
  @HttpCode(200)
  respond(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(respondSchema)) b: z.infer<typeof respondSchema>) {
    return this.offers.respond(a, id, b.decision);
  }

  // ---- lifecycle & corrections ----

  @Roles('coordinator', 'officer', 'admin')
  @Patch(':id/lifecycle')
  @HttpCode(204)
  lifecycle(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(lifecycleSchema)) b: z.infer<typeof lifecycleSchema>) {
    return this.offers.updateLifecycle(a, id, b);
  }

  @Roles('officer', 'admin')
  @StepUp()
  @Post(':id/correct-ctc')
  @HttpCode(204)
  correct(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(correctSchema)) b: z.infer<typeof correctSchema>) {
    return this.offers.correctCtc(a, id, b);
  }

  /**
   * "Change placement status or CTC": there is deliberately no PATCH /offers/:id. Any role that tries to write these
   * fields is rejected; students get a 403 and an audit entry because the route does not exist for their role.
   */
  @Roles('coordinator', 'officer', 'admin')
  @Patch(':id')
  @HttpCode(405)
  forbidDirectEdit() {
    return { message: 'Offers are changed only through the offer workflow (lifecycle, correct-ctc).', code: 'USE_WORKFLOW' };
  }

  @Roles('student', 'coordinator', 'officer', 'hr', 'admin')
  @Get(':id/events')
  events(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.offers.events(a, id);
  }
}
