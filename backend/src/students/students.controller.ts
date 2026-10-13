import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Response } from 'express';
import { z } from 'zod';
import { CurrentActor, Roles, StepUp } from '../common/decorators';
import { Actor } from '../common/types';
import { ZodPipe, paging, text } from '../common/zod.pipe';
import { StudentsService, createStudentSchema, updateStudentSchema } from './students.service';

const listQuery = paging.extend({
  programme_id: z.string().uuid().optional(),
  batch: z.coerce.number().int().optional(),
  eligibility: z.enum(['pending', 'eligible', 'ineligible']).optional(),
  registration: z.enum(['not_registered', 'registered', 'deregistered']).optional(),
  placement_status: z.enum(['Unplaced', 'Internship only', 'FTE only', 'Internship + PPO/FTE']).optional(),
});
const eligibilitySchema = z.object({ status: z.enum(['eligible', 'ineligible', 'pending']), reason: text(300).optional() }).strict();
const contactChangeSchema = z.object({ field: z.enum(['mobile', 'email']), value: z.string().trim().min(5).max(120) }).strict();
const decideSchema = z.object({ approve: z.boolean() }).strict();
const commitSchema = z.object({ token: z.string().min(10).max(100) }).strict();
const breakGlassSchema = z.object({ reason: text(300).pipe(z.string().min(15, 'Explain why you need the full record (at least 15 characters)')) }).strict();

const csvUpload = FileInterceptor('file', {
  storage: memoryStorage(),
  limits: { fileSize: 1024 * 1024, files: 1 }, // size-limited
  fileFilter: (_req, file, cb) => {
    // type-checked: extension AND declared type. The parser then rejects anything that is not well-formed CSV.
    const ok = /\.csv$/i.test(file.originalname) && /^(text\/csv|application\/vnd\.ms-excel|text\/plain|application\/csv)$/.test(file.mimetype);
    cb(ok ? null : new BadRequestException({ message: 'Upload a .csv file.', code: 'BAD_FILE_TYPE' }), ok);
  },
});
const pdfUpload = FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

@Controller()
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Roles('student', 'coordinator', 'officer', 'hr', 'admin', 'superadmin')
  @Get('programmes')
  programmes() {
    return this.students.programmes();
  }

  // ------------------------------------------------------------------ student self-service ----

  @Roles('student')
  @Get('students/me')
  me(@CurrentActor() a: Actor) {
    return this.students.me(a);
  }

  @Roles('student')
  @Post('students/me/confirm-registration')
  @HttpCode(204)
  confirm(@CurrentActor() a: Actor) {
    return this.students.confirmRegistration(a);
  }

  /** Students cannot edit contact details: they request, a coordinator approves. Changing e-mail/phone needs step-up MFA. */
  @Roles('student')
  @StepUp()
  @Post('students/me/contact-change')
  @HttpCode(204)
  requestChange(@CurrentActor() a: Actor, @Body(new ZodPipe(contactChangeSchema)) b: z.infer<typeof contactChangeSchema>) {
    return this.students.requestContactChange(a, b.field, b.value);
  }

  @Roles('student')
  @Post('students/me/resume')
  @UseInterceptors(pdfUpload)
  @HttpCode(204)
  resume(@CurrentActor() a: Actor, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException({ message: 'Attach a PDF file.', code: 'NO_FILE' });
    return this.students.saveResume(a, file);
  }

  // ------------------------------------------------------------------------- staff ----

  @Roles('coordinator', 'officer', 'admin', 'superadmin')
  @Get('students')
  list(@CurrentActor() a: Actor, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.students.list(a, q);
  }

  @Roles('coordinator', 'officer', 'admin')
  @Get('students/contact-changes')
  contactChanges(@CurrentActor() a: Actor) {
    return this.students.listContactChanges(a);
  }

  @Roles('coordinator', 'officer', 'admin')
  @Post('students/contact-changes/:id/decide')
  @HttpCode(204)
  decide(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(decideSchema)) b: z.infer<typeof decideSchema>) {
    return this.students.decideContactChange(a, id, b.approve);
  }

  /** Bulk import: step 1 (preview, nothing saved) and step 2 (commit clean rows). Needs step-up MFA. */
  @Roles('coordinator', 'officer', 'admin')
  @StepUp()
  @Post('students/import/preview')
  @UseInterceptors(csvUpload)
  @HttpCode(200)
  importPreview(@CurrentActor() a: Actor, @UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException({ message: 'Attach a CSV file.', code: 'NO_FILE' });
    return this.students.previewImport(a, file.buffer);
  }

  @Roles('coordinator', 'officer', 'admin')
  @StepUp()
  @Post('students/import/commit')
  @HttpCode(200)
  importCommit(@CurrentActor() a: Actor, @Body(new ZodPipe(commitSchema)) b: z.infer<typeof commitSchema>) {
    return this.students.commitImport(a, b.token);
  }

  @Roles('coordinator', 'officer', 'admin')
  @Post('students')
  create(@CurrentActor() a: Actor, @Body(new ZodPipe(createStudentSchema)) b: z.infer<typeof createStudentSchema>) {
    return this.students.create(a, b);
  }

  /**
   * Note what is NOT here: there is no student write path, and `placement_status`, `ctc` and `category` are not editable
   * by anyone through this endpoint (the schema is strict, so naming them is a 400 and a logged tamper attempt).
   * The student role is rejected by RolesGuard with 403 + an audit entry.
   */
  @Roles('coordinator', 'officer', 'admin')
  @Patch('students/:id')
  update(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateStudentSchema)) b: z.infer<typeof updateStudentSchema>) {
    return this.students.update(a, id, b);
  }

  @Roles('coordinator', 'officer', 'admin')
  @Post('students/:id/eligibility')
  @HttpCode(204)
  eligibility(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(eligibilitySchema)) b: z.infer<typeof eligibilitySchema>) {
    return this.students.setEligibility(a, id, b.status, b.reason);
  }

  @Roles('student', 'coordinator', 'officer', 'admin', 'superadmin')
  @Get('students/:id')
  get(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.students.get(a, id);
  }

  /** Super Admin sees student data masked. Full view needs a written reason, a step-up, and raises an alert. */
  @Roles('superadmin')
  @Post('students/:id/break-glass')
  @HttpCode(200)
  breakGlass(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(breakGlassSchema)) b: z.infer<typeof breakGlassSchema>) {
    return this.students.get(a, id, { breakGlass: true, reason: b.reason }); // the reason is written to the alert audit entry
  }

  @Roles('student', 'coordinator', 'officer', 'hr', 'admin')
  @Get('students/:id/resume')
  @Header('Content-Type', 'application/pdf')
  @Header('Content-Disposition', 'inline; filename="resume.pdf"')
  @Header('X-Content-Type-Options', 'nosniff')
  async resumeFile(@CurrentActor() a: Actor, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    res.end(await this.students.readResume(a, id));
  }
}
