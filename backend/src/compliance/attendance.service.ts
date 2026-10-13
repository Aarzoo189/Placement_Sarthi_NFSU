import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { DbService, SYSTEM_ACTOR } from '../common/prisma.service';
import { AuditService } from '../common/audit.service';
import { Actor } from '../common/types';

export const attendanceSchema = z
  .object({
    drive_id: z.string().uuid(),
    event: z.enum(['PPT', 'TEST', 'INTERVIEW']),
    records: z.array(z.object({ student_id: z.string().uuid(), present: z.boolean(), exception_id: z.string().uuid().nullable().optional() }).strict()).min(1).max(1000),
  })
  .strict();

/**
 * Attendance is append-only: marking a student again adds a new row and the latest row per (student, drive, event) wins
 * (attendance_current_v). An unexcused absence raises a flag in the Officer's review queue and feeds the absenteeism rule (R4).
 */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  async record(actor: Actor, dto: z.infer<typeof attendanceSchema>) {
    const drive = await this.db.prisma.drive.findUnique({ where: { id: dto.drive_id } });
    if (!drive) throw new NotFoundException('Drive not found');
    if (actor.role === 'hr' && drive.company_id !== actor.companyId) throw new ForbiddenException({ message: 'This drive belongs to another company.', code: 'OUT_OF_SCOPE' });
    if (drive.status === 'draft') throw new ConflictException({ message: 'Open the drive before marking attendance.', code: 'BAD_STATE' });

    const ids = [...new Set(dto.records.map((r) => r.student_id))];
    if (ids.length !== dto.records.length) throw new BadRequestException({ message: 'Each student may appear once per submission.', code: 'DUPLICATE_ROWS' });

    const flags: { student_id: string; programme_id: string; name: string }[] = [];
    const result = await this.db.run(actor, async (tx) => {
      // RLS already hides students outside the actor's scope; this makes the failure explicit instead of silent.
      const visible = await tx.student.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, programme_id: true } });
      if (visible.length !== ids.length) throw new ForbiddenException({ message: 'One or more students are outside your scope.', code: 'OUT_OF_SCOPE' });
      if (actor.role === 'hr') {
        const applicants = await tx.application.count({ where: { drive_id: dto.drive_id, student_id: { in: ids }, stage: { not: 'withdrawn' } } });
        if (applicants !== ids.length) throw new ForbiddenException({ message: 'You can only mark attendance for applicants of your own drive.', code: 'OUT_OF_SCOPE' });
      }
      const exIds = dto.records.map((r) => r.exception_id).filter((x): x is string => !!x);
      const exceptions = exIds.length ? await tx.exception.findMany({ where: { id: { in: exIds }, revoked_at: null, expires_at: { gt: new Date() } } }) : [];
      const byId = new Map(exceptions.map((e) => [e.id, e]));

      let absent = 0;
      for (const r of dto.records) {
        if (r.exception_id) {
          const e = byId.get(r.exception_id);
          if (!e || e.student_id !== r.student_id) throw new BadRequestException({ message: 'The exception does not exist, has expired, or belongs to another student.', code: 'BAD_EXCEPTION' });
          if (r.present) throw new BadRequestException({ message: 'An exception only applies to an absence.', code: 'BAD_EXCEPTION' });
        }
        await tx.attendance.create({ data: { student_id: r.student_id, drive_id: dto.drive_id, event: dto.event, present: r.present, exception_id: r.exception_id ?? null, recorded_by: actor.id } });
        if (!r.present && !r.exception_id) {
          absent++;
          const s = visible.find((v) => v.id === r.student_id)!;
          flags.push({ student_id: s.id, programme_id: s.programme_id, name: s.name });
        }
      }
      await this.audit.log({ actor, action: 'ATTENDANCE_MARKED', entity: 'drive', entity_id: dto.drive_id, meta: { event: dto.event, rows: dto.records.length, unexcused_absences: absent } }, tx);
      return { rows: dto.records.length, unexcused_absences: absent };
    });

    // Absences raise an absenteeism flag for Officer review (one open flag per student + drive).
    if (flags.length) {
      await this.db.run(SYSTEM_ACTOR, async (tx) => {
        for (const f of flags) {
          const open = await tx.review_case.findFirst({ where: { kind: 'absenteeism', student_id: f.student_id, ref_id: dto.drive_id, status: 'open' } });
          if (!open) await tx.review_case.create({ data: { kind: 'absenteeism', student_id: f.student_id, programme_id: f.programme_id, ref_id: dto.drive_id, payload: { summary: `${f.name} was absent at the ${dto.event} for "${drive.title}" without an exception`, event: dto.event, drive_id: dto.drive_id } } });
        }
      });
    }
    return result;
  }

  async forDrive(actor: Actor, driveId: string) {
    const drive = await this.db.prisma.drive.findUnique({ where: { id: driveId } });
    if (!drive) throw new NotFoundException('Drive not found');
    if (actor.role === 'hr' && drive.company_id !== actor.companyId) throw new ForbiddenException({ message: 'This drive belongs to another company.', code: 'OUT_OF_SCOPE' });
    return this.db.run(actor, (tx) =>
      tx.$queryRaw<{ student_id: string; name: string; placement_id: string; event: string; present: boolean; exception_id: string | null; at: Date }[]>`
        SELECT a.student_id, s.name, s.placement_id, a.event::text AS event, a.present, a.exception_id, a.at
        FROM attendance_current_v a JOIN student s ON s.id = a.student_id
        WHERE a.drive_id = ${driveId}::uuid ORDER BY s.placement_id, a.event`,
    );
  }

  async mine(actor: Actor) {
    return this.db.run(actor, (tx) =>
      tx.$queryRaw<{ drive_id: string; title: string; event: string; present: boolean; excused: boolean; at: Date }[]>`
        SELECT a.drive_id, d.title, a.event::text AS event, a.present, (a.exception_id IS NOT NULL) AS excused, a.at
        FROM attendance_current_v a JOIN drive d ON d.id = a.drive_id
        WHERE a.student_id = app_student_id() ORDER BY a.at DESC LIMIT 100`,
    );
  }
}
