import { BadRequestException, Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { z } from 'zod';
import { CurrentActor, Roles, StepUp } from '../common/decorators';
import { Actor } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { DrivesService, companySchema, createDriveSchema, inviteSchema, stageSchema, updateDriveSchema } from './drives.service';

const csvUpload = FileInterceptor('file', {
  storage: memoryStorage(),
  limits: { fileSize: 256 * 1024, files: 1 },
  fileFilter: (_r, f, cb) => {
    const ok = /\.(csv|txt)$/i.test(f.originalname) && /^(text\/csv|text\/plain|application\/vnd\.ms-excel|application\/csv)$/.test(f.mimetype);
    cb(ok ? null : new BadRequestException({ message: 'Upload a .csv file with one Placement ID per line.', code: 'BAD_FILE_TYPE' }), ok);
  },
});
const stageQuery = z.object({ stage: z.enum(['shortlisted', 'selected', 'rejected']) }).strict();

@Controller()
export class DrivesController {
  constructor(private readonly drives: DrivesService) {}

  // ---- companies (Placement Officer creates the company, then invites its HR contact) ----

  @Roles('officer', 'admin')
  @Post('companies')
  createCompany(@CurrentActor() a: Actor, @Body(new ZodPipe(companySchema)) b: z.infer<typeof companySchema>) {
    return this.drives.createCompany(a, b);
  }

  @Roles('officer', 'admin', 'coordinator')
  @Get('companies')
  companies() {
    return this.drives.listCompanies();
  }

  // ---- drives ----

  @Roles('officer', 'admin')
  @Post('drives')
  create(@CurrentActor() a: Actor, @Body(new ZodPipe(createDriveSchema)) b: z.infer<typeof createDriveSchema>) {
    return this.drives.create(a, b);
  }

  @Roles('student', 'coordinator', 'officer', 'hr', 'admin')
  @Get('drives')
  list(@CurrentActor() a: Actor) {
    return this.drives.list(a);
  }

  /** Student: open drives with the engine's verdict and the rules that fired, so a blocked student sees the reason. */
  @Roles('student')
  @Get('drives/mine')
  mine(@CurrentActor() a: Actor) {
    return this.drives.myDrives(a);
  }

  @Roles('student', 'coordinator', 'officer', 'hr', 'admin')
  @Get('drives/:id')
  get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.drives.get(a, id);
  }

  @Roles('officer', 'admin')
  @Patch('drives/:id')
  update(@Param('id', ParseUUIDPipe) id: string, @CurrentActor() a: Actor, @Body(new ZodPipe(updateDriveSchema)) b: z.infer<typeof updateDriveSchema>) {
    return this.drives.update(a, id, b);
  }

  @Roles('officer', 'admin')
  @Post('drives/:id/open')
  @HttpCode(200)
  open(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.drives.open(a, id);
  }

  @Roles('officer', 'admin')
  @Post('drives/:id/close')
  @HttpCode(200)
  close(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.drives.close(a, id);
  }

  @Roles('officer', 'admin')
  @Post('drives/:id/invite-hr')
  @HttpCode(200)
  invite(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(inviteSchema)) b: z.infer<typeof inviteSchema>) {
    return this.drives.inviteHr(a, id, b);
  }

  // ---- student actions ----

  @Roles('student')
  @Get('applications/mine')
  myApplications(@CurrentActor() a: Actor) {
    return this.drives.myApplications(a);
  }

  @Roles('student')
  @Post('drives/:id/apply')
  @HttpCode(201)
  apply(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.drives.apply(a, id);
  }

  @Roles('student')
  @Post('drives/:id/withdraw')
  @HttpCode(204)
  withdraw(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.drives.withdraw(a, id);
  }

  // ---- coordinator / officer / HR ----

  @Roles('coordinator', 'officer', 'admin')
  @Get('drives/:id/eligibility')
  eligibility(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.drives.eligibility(a, id);
  }

  @Roles('coordinator', 'officer', 'hr', 'admin')
  @Get('drives/:id/applicants')
  applicants(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.drives.applicants(a, id);
  }

  @Roles('coordinator', 'officer', 'hr', 'admin')
  @Post('drives/:id/stage')
  @HttpCode(200)
  stage(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(stageSchema)) b: z.infer<typeof stageSchema>) {
    return this.drives.setStage(a, id, b.student_ids, b.stage);
  }

  /** HR uploads shortlists and final results as a CSV of Placement IDs (own drive only; step-up MFA). */
  @Roles('hr', 'officer', 'admin')
  @StepUp()
  @Post('drives/:id/stage-upload')
  @UseInterceptors(csvUpload)
  @HttpCode(200)
  stageUpload(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodPipe(stageQuery)) q: z.infer<typeof stageQuery>, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException({ message: 'Attach a CSV file.', code: 'NO_FILE' });
    return this.drives.stageFromCsv(a, id, q.stage, file.buffer);
  }
}
