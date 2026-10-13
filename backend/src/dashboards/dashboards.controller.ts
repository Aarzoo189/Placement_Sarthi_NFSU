import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentActor, Roles } from '../common/decorators';
import { Actor } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { DashboardsService } from './dashboards.service';

const programmeQuery = z.object({ programme_id: z.string().uuid().optional() });

@Controller('dashboards')
export class DashboardsController {
  constructor(private readonly dash: DashboardsService) {}

  /** Officer / Admin: university-wide. Super Admin: the same figures, aggregate only (no student rows). */
  @Roles('officer', 'admin', 'superadmin')
  @Get('overview')
  overview(@CurrentActor() a: Actor, @Query(new ZodPipe(programmeQuery)) q: z.infer<typeof programmeQuery>) {
    return this.dash.overview(a, q.programme_id);
  }

  /** Coordinator: the same metrics for their own programme(s) (row-level security scopes the rows; the filter picks one). */
  @Roles('coordinator')
  @Get('programme')
  programme(@CurrentActor() a: Actor, @Query(new ZodPipe(programmeQuery)) q: z.infer<typeof programmeQuery>) {
    this.dash.assertScope(a, q.programme_id);
    return this.dash.overview(a, q.programme_id ?? (a.programmeIds?.length === 1 ? a.programmeIds[0] : undefined));
  }

  @Roles('officer', 'admin')
  @Get('companies')
  companies(@CurrentActor() a: Actor) {
    return this.dash.companyReport(a);
  }

  @Roles('officer', 'coordinator', 'admin')
  @Get('switching')
  switching(@CurrentActor() a: Actor) {
    return this.dash.switching(a);
  }

  @Roles('officer', 'admin')
  @Get('compliance')
  compliance(@CurrentActor() a: Actor) {
    return this.dash.compliance(a);
  }

  @Roles('student')
  @Get('my-placement')
  mine(@CurrentActor() a: Actor) {
    return this.dash.myPlacement(a);
  }

  @Roles('hr')
  @Get('drive-pipeline/:driveId')
  pipeline(@CurrentActor() a: Actor, @Param('driveId', ParseUUIDPipe) id: string) {
    return this.dash.drivePipeline(a, id);
  }
}
