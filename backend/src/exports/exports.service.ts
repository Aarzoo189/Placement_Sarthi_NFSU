import { ForbiddenException, Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { DbService, PrismaService } from '../common/prisma.service';
import { AuditService } from '../common/audit.service';
import { CryptoService } from '../common/crypto.service';
import { Actor } from '../common/types';
import { maskEmail, maskMobile } from '../common/masking';
import { CTC_AAD, STIPEND_AAD } from '../policy/engine.service';
import { MOBILE_AAD } from '../students/students.service';
import { DashboardsService } from '../dashboards/dashboards.service';

export type ExportFormat = 'csv' | 'xlsx';
export interface ExportFile {
  buffer: Buffer;
  filename: string;
  contentType: string;
  export_id: string;
  sha256: string;
  rows: number;
}

/** Spreadsheet formula injection: a cell that starts with = + - @ (or tab/CR) would be evaluated by Excel. Prefix it with a quote. */
export const safeCell = (v: unknown): string | number | boolean => {
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const s = v == null ? '' : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};

const csvEscape = (v: string | number | boolean) => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Exports (architecture doc, sections 3 and 8): only Officer/Admin get full exports, coordinators get a masked export of their own
 * programme, the Super Admin gets aggregates only. Every export needs step-up MFA, carries a watermark (who, when), and is logged with
 * its row count, the fields included and the SHA-256 of the file.
 */
@Injectable()
export class ExportsService {
  constructor(
    private readonly db: DbService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly dash: DashboardsService,
  ) {}

  private watermark(actor: Actor, what: string) {
    return `CONFIDENTIAL - NFSU Placement Portal ${what}. Exported by ${actor.email ?? actor.id} (${actor.role}) at ${new Date().toISOString()}. Do not share.`;
  }

  private async build(actor: Actor, kind: string, title: string, headers: string[], rows: (string | number | boolean)[][], filter: unknown, format: ExportFormat): Promise<ExportFile> {
    const mark = this.watermark(actor, title);
    let buffer: Buffer;
    if (format === 'csv') {
      const lines = [`# ${mark}`, headers.map(csvEscape).join(','), ...rows.map((r) => r.map((c) => csvEscape(safeCell(c))).join(','))];
      buffer = Buffer.from('﻿' + lines.join('\r\n') + '\r\n', 'utf8');
    } else {
      const wb = new ExcelJS.Workbook();
      wb.creator = actor.email ?? 'NFSU Placement Portal';
      wb.title = title;
      wb.description = mark;
      wb.created = new Date();
      const ws = wb.addWorksheet(title.slice(0, 28));
      ws.addRow([mark]).font = { italic: true, color: { argb: 'FFB00020' } };
      ws.addRow(headers).font = { bold: true };
      rows.forEach((r) => ws.addRow(r.map(safeCell)));
      ws.views = [{ state: 'frozen', ySplit: 2 }];
      ws.headerFooter.oddFooter = `&L${mark.slice(0, 120)}&RPage &P of &N`;
      ws.columns.forEach((c) => (c.width = 18));
      buffer = Buffer.from(await wb.xlsx.writeBuffer());
    }
    const sha256 = this.crypto.sha256(buffer);
    const log = await this.prisma.export_log.create({ data: { actor_id: actor.id, kind, filter_json: (filter ?? {}) as object, row_count: rows.length, fields: headers, file_hash: sha256 } });
    await this.audit.log({ actor, action: 'EXPORT', entity: 'export_log', entity_id: log.id, meta: { kind, rows: rows.length, format, sha256 } });
    return {
      buffer,
      filename: `${kind}-${new Date().toISOString().slice(0, 10)}.${format}`,
      contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      export_id: log.id,
      sha256,
      rows: rows.length,
    };
  }

  /** Students: full for Officer/Admin; masked (no e-mail/mobile in clear), own programme, for a coordinator. */
  async students(actor: Actor, format: ExportFormat, filter: { programme_id?: string; batch?: number }) {
    if (!['officer', 'admin', 'coordinator'].includes(actor.role)) throw new ForbiddenException({ message: 'Your role cannot export student data.', code: 'ROLE_DENIED' });
    const masked = actor.role === 'coordinator';
    const rows = await this.db.run(actor, (tx) =>
      tx.student.findMany({
        where: { AND: [{ archived_at: null }, masked ? { programme_id: { in: actor.programmeIds ?? [] } } : {}, filter.programme_id ? { programme_id: filter.programme_id } : {}, filter.batch ? { batch: filter.batch } : {}] },
        include: { programme: true, placement_state: true },
        orderBy: [{ programme_id: 'asc' }, { placement_id: 'asc' }],
        take: 20_000,
      }),
    );
    const headers = ['Placement ID', 'Name', 'Programme', 'Batch', 'CGPA', 'Backlogs', 'Registration', 'Eligibility', 'Placement status', 'Category', 'E-mail', 'Mobile'];
    const data = rows.map((s) => [
      s.placement_id, s.name, s.programme.code, s.batch, Number(s.cgpa), s.backlogs, s.registration_status, s.eligibility_status,
      s.placement_state?.placement_status ?? 'Unplaced', s.placement_state?.current_category === 'A_PLUS' ? 'A+' : (s.placement_state?.current_category ?? ''),
      masked ? (maskEmail(s.email) ?? '') : s.email,
      masked ? (maskMobile(this.crypto.decrypt(s.mobile_enc, MOBILE_AAD)) ?? '') : this.crypto.decrypt(s.mobile_enc, MOBILE_AAD),
    ]);
    return this.build(actor, masked ? 'students-masked' : 'students', 'Students', headers, data, { ...filter, masked }, format);
  }

  /** Offers: Officer/Admin full. A coordinator sees category bands instead of exact CTC / stipend. */
  async offers(actor: Actor, format: ExportFormat) {
    if (!['officer', 'admin', 'coordinator'].includes(actor.role)) throw new ForbiddenException({ message: 'Your role cannot export offers.', code: 'ROLE_DENIED' });
    const masked = actor.role === 'coordinator';
    const rows = await this.db.run(actor, (tx) =>
      tx.$queryRaw<{ placement_id: string; student_name: string; programme_code: string; batch: number; company: string; type: string; category: string | null; acceptance_status: string; ppo_status: string; joining_status: string; noc_status: string; offer_date: Date; ctc_enc: string | null; stipend_enc: string | null }[]>`
        SELECT placement_id, student_name, programme_code, batch, company, type::text AS type, category::text AS category, acceptance_status::text AS acceptance_status,
               ppo_status::text AS ppo_status, joining_status::text AS joining_status, noc_status::text AS noc_status, offer_date, ctc_enc, stipend_enc
        FROM offer_current_v ORDER BY offer_date DESC LIMIT 20000`,
    );
    // CTC (LPA) and stipend (rupees) are separate columns on purpose: they are different measures and are never combined.
    const headers = ['Placement ID', 'Student', 'Programme', 'Batch', 'Company', 'Type', 'Category', 'FTE CTC (LPA)', 'Internship stipend', 'Acceptance', 'PPO', 'Joining', 'NOC', 'Offer date'];
    const data = rows.map((o) => [
      o.placement_id, o.student_name, o.programme_code, o.batch, o.company, o.type, o.category ?? '',
      masked ? '(masked)' : (this.crypto.decryptNumber(o.ctc_enc, CTC_AAD) ?? ''),
      masked ? '(masked)' : (this.crypto.decryptNumber(o.stipend_enc, STIPEND_AAD) ?? ''),
      o.acceptance_status, o.ppo_status, o.joining_status, o.noc_status, o.offer_date.toISOString().slice(0, 10),
    ]);
    return this.build(actor, masked ? 'offers-masked' : 'offers', 'Offers', headers, data, { masked }, format);
  }

  /** Aggregates only (what the Super Admin may export): no names, no IDs. */
  async summary(actor: Actor, format: ExportFormat) {
    const o = await this.dash.overview(actor);
    const data: (string | number)[][] = [
      ['Registered students', o.students.registered], ['Eligible students', o.students.eligible], ['Ineligible students', o.students.ineligible],
      ['Placed students (distinct)', o.placement.placed_students], ['Unplaced students', o.placement.unplaced_students], ['Accepted offers (rows)', o.placement.offers_accepted],
      ['Internship only', o.placement.internship_only], ['FTE only', o.placement.fte_only], ['Internship + PPO/FTE', o.placement.internship_ppo_fte],
      ['FTE CTC highest (LPA)', o.fte_ctc_lpa.highest ?? ''], ['FTE CTC average (LPA)', o.fte_ctc_lpa.average ?? ''], ['FTE CTC median (LPA)', o.fte_ctc_lpa.median ?? ''],
      ['Internship stipend highest (INR)', o.internship_stipend.highest ?? ''], ['Internship stipend average (INR)', o.internship_stipend.average ?? ''], ['Internship stipend median (INR)', o.internship_stipend.median ?? ''],
    ];
    return this.build(actor, 'summary', 'Aggregate summary', ['Measure', 'Value'], data, {}, format);
  }

  async log(actor: Actor) {
    return this.prisma.export_log.findMany({ where: actor.role === 'officer' ? { actor_id: actor.id } : {}, orderBy: { at: 'desc' }, take: 100 });
  }
}
