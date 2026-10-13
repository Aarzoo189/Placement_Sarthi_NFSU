import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService, Tx } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { Actor } from '../common/types';
import { CTC_AAD, STIPEND_AAD } from '../policy/engine.service';
import { DrivesService } from '../drives/drives.service';
import { OffersService } from '../offers/offers.service';
import { StudentsService } from '../students/students.service';
import { ReviewService } from '../compliance/review.service';

interface OfferRow {
  offer_id: string;
  student_id: string;
  student_name: string;
  placement_id: string;
  programme_code: string;
  batch: number;
  company: string;
  type: 'I' | 'F' | 'IF';
  category: string | null;
  acceptance_status: 'pending' | 'accepted' | 'declined' | 'expired';
  ppo_status: string;
  joining_status: string;
  noc_status: string;
  offer_date: Date;
  deadline: Date;
  off_campus: boolean;
  ctc_enc: string | null;
  stipend_enc: string | null;
}

export interface Stats {
  count: number;
  highest: number | null;
  average: number | null;
  median: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
export function stats(values: number[]): Stats {
  if (!values.length) return { count: 0, highest: null, average: null, median: null };
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return { count: s.length, highest: r2(s[s.length - 1]), average: r2(s.reduce((a, b) => a + b, 0) / s.length), median: r2(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2) };
}

/**
 * Dashboards read only from the derived views (student_status_v, offer_current_v, application_pipeline_v), which run with the
 * caller's rights, so every figure is filtered by the same row-level security as the records themselves and matches them exactly.
 *
 * Reporting rules from the problem statement are built into the queries:
 *   - internship STIPEND and FTE CTC are separate figures and separate charts; they are never averaged together
 *   - "placed students" counts DISTINCT students, "offers" counts offer rows; both are shown side by side
 *   - average / median / highest use ACCEPTED FTE offers only; declined and expired offers are excluded but listed
 */
@Injectable()
export class DashboardsService {
  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
    private readonly drives: DrivesService,
    private readonly offers: OffersService,
    private readonly students: StudentsService,
    private readonly review: ReviewService,
  ) {}

  private offerRows(tx: Tx, programmeId?: string) {
    return programmeId
      ? tx.$queryRaw<OfferRow[]>`SELECT * FROM offer_current_v WHERE programme_id = ${programmeId}::uuid`
      : tx.$queryRaw<OfferRow[]>`SELECT * FROM offer_current_v`;
  }

  private money(o: OfferRow) {
    return { ctc: this.crypto.decryptNumber(o.ctc_enc, CTC_AAD), stipend: this.crypto.decryptNumber(o.stipend_enc, STIPEND_AAD) };
  }

  /** University overview (Officer, Admin); the same figures, aggregate-only, for the Super Admin. Programme view for a coordinator. */
  async overview(actor: Actor, programmeId?: string) {
    return this.db.run(actor, async (tx) => {
      const pf = programmeId ?? null;
      const counts = (
        await tx.$queryRaw<{ registered: bigint; eligible: bigint; ineligible: bigint; pending_eligibility: bigint; total: bigint }[]>`
          SELECT count(*) FILTER (WHERE registration_status = 'registered') AS registered,
                 count(*) FILTER (WHERE eligibility_status = 'eligible') AS eligible,
                 count(*) FILTER (WHERE eligibility_status = 'ineligible') AS ineligible,
                 count(*) FILTER (WHERE eligibility_status = 'pending') AS pending_eligibility,
                 count(*) AS total
          FROM student_status_v WHERE archived_at IS NULL AND (${pf}::uuid IS NULL OR programme_id = ${pf}::uuid)`
      )[0];
      const byStatus = await tx.$queryRaw<{ placement_status: string; n: bigint }[]>`
        SELECT placement_status, count(*) AS n FROM student_status_v
        WHERE archived_at IS NULL AND registration_status = 'registered' AND (${pf}::uuid IS NULL OR programme_id = ${pf}::uuid) GROUP BY placement_status`;
      const sByStatus = Object.fromEntries(byStatus.map((r) => [r.placement_status, Number(r.n)]));

      const offers = await this.offerRows(tx, programmeId);
      const accepted = offers.filter((o) => o.acceptance_status === 'accepted');
      const fte = accepted.filter((o) => o.type !== 'I');
      const interns = accepted.filter((o) => o.type !== 'F');
      const ctc = stats(fte.map((o) => this.money(o).ctc).filter((x): x is number => x != null));
      const stipend = stats(interns.map((o) => this.money(o).stipend).filter((x): x is number => x != null));
      const distinct = (xs: OfferRow[]) => new Set(xs.map((o) => o.student_id)).size;

      // course-wise and batch-wise outcomes
      const group = (key: (o: OfferRow) => string) => {
        const m = new Map<string, { students: Set<string>; offers: number; ctc: number[] }>();
        for (const o of accepted) {
          const k = key(o);
          const g = m.get(k) ?? { students: new Set<string>(), offers: 0, ctc: [] as number[] };
          g.students.add(o.student_id);
          g.offers++;
          const c = o.type !== 'I' ? this.money(o).ctc : null;
          if (c != null) g.ctc.push(c);
          m.set(k, g);
        }
        return m;
      };
      const cohort = await tx.$queryRaw<{ programme_code: string; batch: number; registered: bigint; eligible: bigint }[]>`
        SELECT programme_code, batch, count(*) FILTER (WHERE registration_status = 'registered') AS registered,
               count(*) FILTER (WHERE eligibility_status = 'eligible') AS eligible
        FROM student_status_v WHERE archived_at IS NULL AND (${pf}::uuid IS NULL OR programme_id = ${pf}::uuid) GROUP BY programme_code, batch ORDER BY programme_code, batch`;
      const byProg = group((o) => o.programme_code);
      const byBatch = group((o) => String(o.batch));
      const outcome = (c: { programme_code: string; batch: number; registered: bigint; eligible: bigint }, g?: { students: Set<string>; offers: number; ctc: number[] }) => ({
        registered: Number(c.registered),
        eligible: Number(c.eligible),
        placed_students: g?.students.size ?? 0,
        offers: g?.offers ?? 0,
        avg_ctc: g?.ctc.length ? stats(g.ctc).average : null,
      });
      const course_wise = [...new Set(cohort.map((c) => c.programme_code))].map((p) => {
        const rows = cohort.filter((c) => c.programme_code === p);
        const reg = rows.reduce((a, c) => a + Number(c.registered), 0);
        const el = rows.reduce((a, c) => a + Number(c.eligible), 0);
        const g = byProg.get(p);
        return { programme: p, registered: reg, eligible: el, placed_students: g?.students.size ?? 0, offers: g?.offers ?? 0, avg_ctc: g?.ctc.length ? stats(g.ctc).average : null };
      });
      const batch_wise = [...new Set(cohort.map((c) => c.batch))].map((b) => {
        const rows = cohort.filter((c) => c.batch === b);
        const g = byBatch.get(String(b));
        return { batch: b, ...outcome({ programme_code: '', batch: b, registered: BigInt(rows.reduce((a, c) => a + Number(c.registered), 0)), eligible: BigInt(rows.reduce((a, c) => a + Number(c.eligible), 0)) }, g) };
      });

      const excluded = offers.filter((o) => o.acceptance_status === 'declined' || o.acceptance_status === 'expired');
      return {
        scope: programmeId ? 'programme' : 'university',
        students: { total: Number(counts.total), registered: Number(counts.registered), eligible: Number(counts.eligible), ineligible: Number(counts.ineligible), pending_eligibility: Number(counts.pending_eligibility) },
        placement: {
          // distinct STUDENTS vs OFFER rows, side by side
          placed_students: distinct(accepted),
          unplaced_students: sByStatus['Unplaced'] ?? 0,
          offers_accepted: accepted.length,
          internship_only: sByStatus['Internship only'] ?? 0,
          fte_only: sByStatus['FTE only'] ?? 0,
          internship_ppo_fte: sByStatus['Internship + PPO/FTE'] ?? 0,
          offers_by_type: { I: accepted.filter((o) => o.type === 'I').length, F: accepted.filter((o) => o.type === 'F').length, IF: accepted.filter((o) => o.type === 'IF').length },
          students_by_type: { I: distinct(accepted.filter((o) => o.type === 'I')), F: distinct(accepted.filter((o) => o.type === 'F')), IF: distinct(accepted.filter((o) => o.type === 'IF')) },
          pending_acceptance: offers.filter((o) => o.acceptance_status === 'pending').length,
          awaiting_joining: accepted.filter((o) => o.joining_status === 'pending').length,
          missing_noc: accepted.filter((o) => o.off_campus && o.noc_status === 'pending').length,
        },
        // Two different measures, two separate blocks: never averaged together.
        fte_ctc_lpa: { ...ctc, basis: 'accepted FTE (F and I+F) offers only', by_category: ['A+', 'A', 'B', 'C'].map((c) => ({ category: c, offers: fte.filter((o) => o.category === c).length })) },
        internship_stipend: { ...stipend, basis: 'accepted internship (I and I+F) offers only; rupees, not LPA' },
        course_wise,
        batch_wise,
        excluded_offers: { declined: excluded.filter((o) => o.acceptance_status === 'declined').length, expired: excluded.filter((o) => o.acceptance_status === 'expired').length, items: excluded.slice(0, 25).map((o) => ({ offer_id: o.offer_id, student: o.student_name, placement_id: o.placement_id, company: o.company, type: o.type, status: o.acceptance_status })) },
      };
    });
  }

  async companyReport(actor: Actor) {
    return this.db.run(actor, async (tx) => {
      const offers = await this.offerRows(tx);
      const m = new Map<string, OfferRow[]>();
      for (const o of offers) m.set(o.company, [...(m.get(o.company) ?? []), o]);
      return [...m.entries()]
        .map(([company, rows]) => {
          const acc = rows.filter((o) => o.acceptance_status === 'accepted');
          const fte = acc.filter((o) => o.type !== 'I').map((o) => this.money(o).ctc).filter((x): x is number => x != null);
          const st = acc.filter((o) => o.type !== 'F').map((o) => this.money(o).stipend).filter((x): x is number => x != null);
          return {
            company,
            offers_made: rows.length,
            accepted: acc.length,
            pending: rows.filter((o) => o.acceptance_status === 'pending').length,
            declined: rows.filter((o) => o.acceptance_status === 'declined').length,
            expired: rows.filter((o) => o.acceptance_status === 'expired').length,
            types: { I: rows.filter((o) => o.type === 'I').length, F: rows.filter((o) => o.type === 'F').length, IF: rows.filter((o) => o.type === 'IF').length },
            categories: [...new Set(rows.map((o) => o.category).filter(Boolean))],
            ctc_lpa: stats(fte),
            stipend: stats(st),
          };
        })
        .sort((a, b) => b.offers_made - a.offers_made);
    });
  }

  /** Students still eligible for the next drive under the switching rules, with the rule that applies. */
  async switching(actor: Actor) {
    return this.db.run(actor, async (tx) => {
      const rows = await tx.$queryRaw<{ student_id: string; placement_id: string; name: string; programme_code: string; batch: number; placement_status: string; current_category: string | null; switching_json: Record<string, unknown> | null }[]>`
        SELECT student_id, placement_id, name, programme_code, batch, placement_status, current_category::text AS current_category, switching_json
        FROM student_status_v
        WHERE archived_at IS NULL AND registration_status = 'registered' AND eligibility_status = 'eligible'
        ORDER BY programme_code, placement_id`;
      const items = rows.map((r) => {
        const sw = (r.switching_json ?? {}) as { rule?: string; blocked_all?: boolean; allowed_categories?: string[]; allowed_offer_types?: string[]; min_ctc_lpa?: number | null; note?: string; pending_offer_count?: number };
        return { ...r, switching_json: undefined, rule: sw.rule ?? 'none', still_eligible: !sw.blocked_all && !(sw.pending_offer_count ?? 0), blocked_all: !!sw.blocked_all, allowed_categories: sw.allowed_categories ?? ['A+', 'A', 'B', 'C'], allowed_offer_types: sw.allowed_offer_types ?? ['I', 'F', 'IF'], min_ctc_lpa: sw.min_ctc_lpa ?? null, note: sw.note ?? '', pending_offers: sw.pending_offer_count ?? 0 };
      });
      return { eligible_for_next_drive: items.filter((i) => i.still_eligible).length, out_of_process: items.filter((i) => i.blocked_all).length, items };
    });
  }

  async compliance(actor: Actor) {
    return { counts: await this.review.counts(actor), items: await this.review.list(actor, 'open') };
  }

  /** Student: own status, offers, deadlines, and which drives they can apply to and why. */
  async myPlacement(actor: Actor) {
    const [profile, offers, drives] = await Promise.all([this.students.me(actor), this.offers.list(actor, {}), this.drives.myDrives(actor)]);
    const next = offers.filter((o) => o.acceptance_status === 'pending').sort((a, b) => a.deadline.getTime() - b.deadline.getTime());
    return { profile, offers, drives, pending_deadlines: next.map((o) => ({ offer_id: o.id, company: o.company, deadline: o.deadline })) };
  }

  /** Company HR: the pipeline for ONE of their own drives. */
  async drivePipeline(actor: Actor, driveId: string) {
    const drive = await this.drives.get(actor, driveId); // throws 403 for another company's drive
    const applicants = await this.drives.applicants(actor, driveId);
    const byStage: Record<string, number> = { pending_review: 0, applied: 0, shortlisted: 0, selected: 0, rejected: 0 };
    for (const a of applicants) byStage[a.stage] = (byStage[a.stage] ?? 0) + 1;
    const offers = await this.offers.list(actor, {});
    return { drive, counts: byStage, applicants, offers: offers.filter((o) => o.drive_id === driveId) };
  }

  assertScope(actor: Actor, programmeId?: string) {
    if (actor.role === 'coordinator' && programmeId && !actor.programmeIds?.includes(programmeId)) throw new ForbiddenException({ message: 'Not your programme.', code: 'OUT_OF_SCOPE' });
    if (programmeId && !/^[0-9a-f-]{36}$/i.test(programmeId)) throw new NotFoundException();
  }
}
