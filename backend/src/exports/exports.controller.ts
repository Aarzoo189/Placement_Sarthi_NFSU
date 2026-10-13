import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';
import { CurrentActor, Roles, StepUp } from '../common/decorators';
import { Actor } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { ExportFile, ExportsService } from './exports.service';

const q = z.object({ format: z.enum(['csv', 'xlsx']).default('csv'), programme_id: z.string().uuid().optional(), batch: z.coerce.number().int().optional() }).strict();

const send = (res: Response, f: ExportFile) => {
  res.setHeader('Content-Type', f.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
  res.setHeader('X-Export-Id', f.export_id);
  res.setHeader('X-Export-SHA256', f.sha256);
  res.setHeader('X-Export-Rows', String(f.rows));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(f.buffer);
};

/** Every export needs step-up MFA, is watermarked, and is logged with row count, fields and file hash. */
@Controller('exports')
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Roles('officer', 'admin', 'coordinator')
  @StepUp()
  @Get('students')
  async students(@CurrentActor() a: Actor, @Query(new ZodPipe(q)) query: z.infer<typeof q>, @Res() res: Response) {
    send(res, await this.exports.students(a, query.format, query));
  }

  @Roles('officer', 'admin', 'coordinator')
  @StepUp()
  @Get('offers')
  async offers(@CurrentActor() a: Actor, @Query(new ZodPipe(q)) query: z.infer<typeof q>, @Res() res: Response) {
    send(res, await this.exports.offers(a, query.format));
  }

  @Roles('officer', 'admin', 'superadmin')
  @StepUp()
  @Get('summary')
  async summary(@CurrentActor() a: Actor, @Query(new ZodPipe(q)) query: z.infer<typeof q>, @Res() res: Response) {
    send(res, await this.exports.summary(a, query.format));
  }

  @Roles('officer', 'admin', 'superadmin')
  @Get('log')
  log(@CurrentActor() a: Actor) {
    return this.exports.log(a);
  }
}
