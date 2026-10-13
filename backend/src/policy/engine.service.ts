import { Injectable, Logger } from '@nestjs/common';
import { Category as DbCategory, Prisma } from '@prisma/client';
import { DbService, SYSTEM_ACTOR, Tx } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { Category, computePlacementState, Decision, EngineInput, EngineOffer, evaluate, OfferType, PolicyParams } from './engine';
import { PolicyService } from './policy.service';

export const catToDb = (c: Category | null | undefined): DbCategory | null => (c == null ? null : c === 'A+' ? 'A_PLUS' : (c as DbCategory));
export const catFromDb = (c: DbCategory | null | undefined): Category | null => (c == null ? null : c === 'A_PLUS' ? 'A+' : (c as Category));

export const CTC_AAD = 'offer.ctc_enc';
export const STIPEND_AAD = 'offer.stipend_enc';
export const HIGHEST_CTC_AAD = 'student_placement_state.highest_ctc_enc';

/**
 * The rule engine's database side. This is the ONLY code that writes student_placement_state, and the only place that
 * turns offers + attendance + exceptions into an ALLOW / BLOCK / REVIEW decision.
 */
@Injectable()
export class EngineService {
  private readonly log = new Logger('Engine');

  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
    private readonly policy: PolicyService,
  ) {
    this.policy.onPublished = () => void this.recomputeAll().catch((e) => this.log.error(`recomputeAll failed: ${e.message}`));
  }

  /** Offers as the engine sees them (CTC decrypted in memory only). */
  async loadOffers(tx: Tx, studentIds: string[]): Promise<Map<string, EngineOffer[]>> {
    const rows = await tx.offer.findMany({ where: { student_id: { in: studentIds } }, include: { drive: { select: { company_id: true } } } });
    const out = new Map<string, EngineOffer[]>();
    for (const o of rows) {
      const list = out.get(o.student_id) ?? [];
      list.push({
        id: o.id,
        type: o.type as OfferType,
        ctcLpa: this.crypto.decryptNumber(o.ctc_enc, CTC_AAD),
        acceptance: o.acceptance_status,
        deadline: o.deadline,
        driveId: o.drive_id,
        companyKey: o.drive?.company_id ?? o.off_campus_company ?? o.id,
        offCampus: o.drive_id === null,
        noc: o.noc_status,
      });
      out.set(o.student_id, list);
    }
    return out;
  }

  /** Evaluate many students against one drive (drive open pre-compute, coordinator shortlist). Persists every decision. */
  async evaluateMany(
    tx: Tx,
    studentIds: string[],
    driveId: string,
    trigger: 'apply' | 'shortlist' | 'drive_open' | 'review',
    opts: { persist?: boolean; now?: Date; excludeOfferIds?: string[] } = {},
  ): Promise<{ student_id: string; decision: Decision; decision_id?: string; policy_version: number }[]> {
    if (!studentIds.length) return [];
    const now = opts.now ?? new Date();
    const { version, params } = await this.policy.current();

    const drive = await tx.drive.findUniqueOrThrow({ where: { id: driveId } });
    const students = await tx.student.findMany({ where: { id: { in: studentIds } }, include: { programme: { select: { code: true } } } });
    const offers = await this.loadOffers(tx, studentIds);
    const att = await tx.$queryRaw<{ student_id: string; drive_id: string; present: boolean; exception_id: string | null; at: Date }[]>`
      SELECT student_id, drive_id, present, exception_id, at FROM attendance_current_v WHERE student_id = ANY(${studentIds}::uuid[])`;
    const exceptions = await tx.exception.findMany({ where: { student_id: { in: studentIds } } });
    const driveTitles = new Map<string, string>();
    (await tx.drive.findMany({ where: { id: { in: [...new Set(att.map((a) => a.drive_id))] } }, select: { id: true, title: true } })).forEach((d) => driveTitles.set(d.id, d.title));

    const results: { student_id: string; decision: Decision; decision_id?: string; policy_version: number }[] = [];
    for (const s of students) {
      const recent = new Map<string, { driveId: string; label: string; absentUnexcused: boolean; at: Date }>();
      for (const a of att.filter((x) => x.student_id === s.id)) {
        const cur = recent.get(a.drive_id) ?? { driveId: a.drive_id, label: driveTitles.get(a.drive_id) ?? 'a drive', absentUnexcused: false, at: a.at };
        if (!a.present && !a.exception_id) cur.absentUnexcused = true;
        if (a.at > cur.at) cur.at = a.at;
        recent.set(a.drive_id, cur);
      }
      const input: EngineInput = {
        student: { registration: s.registration_status, eligibility: s.eligibility_status, programmeCode: s.programme.code, batch: s.batch, cgpa: Number(s.cgpa), backlogs: s.backlogs },
        offers: (offers.get(s.id) ?? []).filter((o) => !opts.excludeOfferIds?.includes(o.id)),
        recentDrives: [...recent.values()].sort((a, b) => b.at.getTime() - a.at.getTime()).map(({ driveId: d, label, absentUnexcused }) => ({ driveId: d, label, absentUnexcused })),
        exceptions: exceptions.filter((e) => e.student_id === s.id).map((e) => ({ id: e.id, ruleCode: e.rule_code, expiresAt: e.expires_at, revokedAt: e.revoked_at })),
        drive: { id: drive.id, offerType: drive.offer_type as OfferType, ctcLpa: drive.ctc_lpa == null ? null : Number(drive.ctc_lpa), criteria: (drive.criteria_json ?? {}) as EngineInput['drive']['criteria'] },
        now,
        params,
      };
      const decision = evaluate(input);
      let decision_id: string | undefined;
      if (opts.persist !== false) {
        const rec = await tx.engine_decision.create({
          data: { student_id: s.id, drive_id: driveId, result: decision.result, fired_rules_json: decision.fired_rules as unknown as Prisma.InputJsonValue, policy_version: version, exception_id: decision.exception_id ?? null, trigger },
        });
        decision_id = rec.id;
      }
      results.push({ student_id: s.id, decision, decision_id, policy_version: version });
    }
    return results;
  }

  async evaluateOne(tx: Tx, studentId: string, driveId: string, trigger: 'apply' | 'shortlist' | 'drive_open' | 'review', opts: { persist?: boolean; excludeOfferIds?: string[] } = {}) {
    const [r] = await this.evaluateMany(tx, [studentId], driveId, trigger, opts);
    return r;
  }

  /**
   * Recompute and store placement status + switching eligibility for one student. Runs as `system` (the only role the
   * database lets write student_placement_state), after every offer / exception / policy event.
   */
  async recomputeState(studentId: string): Promise<void> {
    const { version, params } = await this.policy.current();
    await this.db.run(SYSTEM_ACTOR, async (tx) => this.recomputeStateTx(tx, studentId, version, params));
  }

  async recomputeStateTx(tx: Tx, studentId: string, version: number, params: PolicyParams) {
    const offers = (await this.loadOffers(tx, [studentId])).get(studentId) ?? [];
    const st = computePlacementState(offers, params, new Date());
    const data = {
      placement_status: st.placement_status,
      current_category: catToDb(st.current_category),
      highest_ctc_enc: this.crypto.encryptNumber(st.highest_ctc_lpa, HIGHEST_CTC_AAD),
      accepted_offer_count: st.accepted_offer_count,
      switching_json: { ...st.switching, pending_offer_count: st.pending_offer_count } as unknown as Prisma.InputJsonValue,
      policy_version: version,
    };
    await tx.student_placement_state.upsert({ where: { student_id: studentId }, create: { student_id: studentId, ...data }, update: data });
  }

  async recomputeAll(): Promise<number> {
    const { version, params } = await this.policy.current();
    const ids = await this.db.run(SYSTEM_ACTOR, (tx) => tx.student.findMany({ select: { id: true } }));
    let n = 0;
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      await this.db.run(SYSTEM_ACTOR, async (tx) => {
        for (const s of chunk) await this.recomputeStateTx(tx, s.id, version, params);
      });
      n += chunk.length;
    }
    this.log.log(`Recomputed placement state for ${n} students (policy v${version})`);
    return n;
  }
}
