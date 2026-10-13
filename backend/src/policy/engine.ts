/**
 * Placement policy rule engine (architecture doc, section 5).
 *
 * Pure functions only: no database, no clock, no I/O. Everything the rules need comes in through `EngineInput`
 * (including `now` and the thresholds read from the versioned policy_rule table), so each rule can be unit-tested
 * in isolation and every decision can be explained later with the policy version that produced it.
 *
 * Rules (evaluation order, first BLOCK wins, a REVIEW without a BLOCK gives REVIEW):
 *   R1 registration   R2 eligibility   R3 company criteria   R4 absenteeism
 *   R5 offer-type     R6 category switching   R7 pending offer   R8 data conflicts
 */

export type Category = 'A+' | 'A' | 'B' | 'C';
export type OfferType = 'I' | 'F' | 'IF';
export type Result = 'ALLOW' | 'BLOCK' | 'REVIEW';
export type RuleCode = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8';
export type PlacementStatus = 'Unplaced' | 'Internship only' | 'FTE only' | 'Internship + PPO/FTE';

export const CATEGORIES: Category[] = ['A+', 'A', 'B', 'C'];
export const RULE_CODES: RuleCode[] = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8'];

export const RULE_TITLES: Record<RuleCode, string> = {
  R1: 'Registration',
  R2: 'Eligibility',
  R3: 'Company criteria',
  R4: 'Absenteeism',
  R5: 'Offer-type rule',
  R6: 'Category switching',
  R7: 'Pending offer',
  R8: 'Data conflict',
};

export interface PolicyParams {
  /** CTC bands in LPA: A+ >= aPlusMin, A >= aMin, B >= bMin, otherwise C. */
  thresholds: { aPlusMin: number; aMin: number; bMin: number };
  /** Category B holders may only apply to drives paying at least `multiplier` x their current CTC. */
  switchB: { multiplier: number };
  absenteeism: { lastDrives: number };
  acceptance: { hours: number };
}

export const DEFAULT_POLICY: PolicyParams = {
  thresholds: { aPlusMin: 16, aMin: 10, bMin: 6 },
  switchB: { multiplier: 1.5 },
  absenteeism: { lastDrives: 3 },
  acceptance: { hours: 24 },
};

export interface EngineOffer {
  id: string;
  type: OfferType;
  ctcLpa: number | null;
  acceptance: 'pending' | 'accepted' | 'declined' | 'expired';
  deadline: Date;
  driveId: string | null;
  /** company name for off-campus offers, company id for on-campus (duplicate detection). */
  companyKey: string;
  offCampus: boolean;
  noc: 'not_required' | 'pending' | 'received';
}

export interface EngineStudent {
  registration: 'not_registered' | 'registered' | 'deregistered';
  eligibility: 'pending' | 'eligible' | 'ineligible';
  programmeCode: string;
  batch: number;
  cgpa: number;
  backlogs: number;
}

export interface EngineRecentDrive {
  driveId: string;
  label: string;
  /** true when the student missed a required event at this drive and the absence has no approved exception. */
  absentUnexcused: boolean;
}

export interface EngineException {
  id: string;
  ruleCode: RuleCode | string;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface EngineDrive {
  id: string;
  offerType: OfferType;
  ctcLpa: number | null;
  criteria: { min_cgpa?: number; max_backlogs?: number; programmes?: string[]; batches?: number[] };
}

export interface EngineInput {
  student: EngineStudent;
  offers: EngineOffer[];
  /** Most recent drives the student was expected at, NEWEST FIRST. */
  recentDrives: EngineRecentDrive[];
  exceptions: EngineException[];
  drive: EngineDrive;
  now: Date;
  params: PolicyParams;
}

export interface FiredRule {
  code: RuleCode;
  title: string;
  outcome: 'BLOCK' | 'REVIEW' | 'OVERRIDDEN';
  message: string;
  exception_id?: string;
}

export interface Decision {
  result: Result;
  fired_rules: FiredRule[];
  /** Human-readable one-liner, e.g. "BLOCK - R6: holds B offer at Rs 8 LPA; ...". */
  summary: string;
  exception_id?: string;
  drive_category: Category | null;
}

// ------------------------------------------------------------------ helpers ----

/** Exact decimal comparison: LPA values are compared in hundredths so 1.5 x 8 = 12 is never 11.999999. */
const h = (lpa: number) => Math.round(lpa * 100);
const MULT_SCALE = 100;

export const fmtLpa = (n: number) => `₹${Number(n.toFixed(2))} LPA`;

export function categoryFor(ctcLpa: number, t: PolicyParams['thresholds']): Category {
  const v = h(ctcLpa);
  if (v >= h(t.aPlusMin)) return 'A+';
  if (v >= h(t.aMin)) return 'A';
  if (v >= h(t.bMin)) return 'B';
  return 'C';
}

const rank = (c: Category) => CATEGORIES.indexOf(c); // lower = better

/** Acceptance deadline = the earlier of (offer issued + N hours) and the company's stated deadline. */
export function computeDeadline(issuedAt: Date, companyDeadline: Date | null | undefined, hours: number): Date {
  const base = new Date(issuedAt.getTime() + hours * 3_600_000);
  if (companyDeadline && companyDeadline.getTime() < base.getTime()) return companyDeadline;
  return base;
}

const hasFte = (t: OfferType) => t === 'F' || t === 'IF';
const accepted = (o: EngineOffer) => o.acceptance === 'accepted';

/** Highest accepted FTE CTC (F or I+F offers). */
export function highestAcceptedFte(offers: EngineOffer[]): { ctcLpa: number; offer: EngineOffer } | null {
  let best: { ctcLpa: number; offer: EngineOffer } | null = null;
  for (const o of offers) {
    if (!accepted(o) || !hasFte(o.type) || o.ctcLpa == null) continue;
    if (!best || h(o.ctcLpa) > h(best.ctcLpa)) best = { ctcLpa: o.ctcLpa, offer: o };
  }
  return best;
}

/** Offer-type rule: what a student holding an accepted offer of type X may still apply to. */
export const TYPE_MAY_APPLY: Record<OfferType, OfferType[]> = {
  I: ['F', 'IF'], // internship-only holder: not another I
  F: ['I'], // FTE-only holder: not another F
  IF: [], // internship + PPO/FTE holder: nothing at another organisation
};

const TYPE_NAME: Record<OfferType, string> = { I: 'internship-only (I)', F: 'FTE-only (F)', IF: 'internship + PPO/FTE (I+F)' };

// -------------------------------------------------------------------- rules ----

type RuleFn = (i: EngineInput) => { outcome: 'BLOCK' | 'REVIEW'; message: string }[];

const r1: RuleFn = ({ student }) =>
  student.registration === 'registered'
    ? []
    : [{ outcome: 'BLOCK', message: student.registration === 'deregistered' ? 'student is deregistered' : 'student has not registered for placements' }];

const r2: RuleFn = ({ student }) => {
  if (student.eligibility === 'ineligible') return [{ outcome: 'BLOCK', message: 'student is marked ineligible' }];
  if (student.eligibility === 'pending') return [{ outcome: 'REVIEW', message: 'eligibility verification is pending' }];
  return [];
};

const r3: RuleFn = ({ student, drive }) => {
  const c = drive.criteria ?? {};
  const failures: string[] = [];
  if (c.min_cgpa != null && h(student.cgpa) < h(c.min_cgpa)) failures.push(`CGPA ${student.cgpa} is below the required ${c.min_cgpa}`);
  if (c.max_backlogs != null && student.backlogs > c.max_backlogs) failures.push(`${student.backlogs} backlogs exceeds the allowed ${c.max_backlogs}`);
  if (c.programmes?.length && !c.programmes.includes(student.programmeCode)) failures.push(`programme ${student.programmeCode} is not in [${c.programmes.join(', ')}]`);
  if (c.batches?.length && !c.batches.includes(student.batch)) failures.push(`batch ${student.batch} is not in [${c.batches.join(', ')}]`);
  return failures.length ? [{ outcome: 'BLOCK', message: `criteria not met: ${failures.join('; ')}` }] : [];
};

const r4: RuleFn = ({ recentDrives, params }) => {
  const window = recentDrives.slice(0, params.absenteeism.lastDrives);
  const missed = window.find((d) => d.absentUnexcused);
  return missed ? [{ outcome: 'BLOCK', message: `unexcused absence at "${missed.label}" within the last ${params.absenteeism.lastDrives} drives` }] : [];
};

/**
 * Interpretation (flagged as an open point for the Placement Cell, see docs): the offer-type table says an FTE-only (F)
 * holder is "blocked from another F", while the category table lets an A / B / C holder move to a higher-category FTE
 * drive (P2, P4). Both hold only if, once a CTC is on record, the FTE -> FTE move is governed by the category switching
 * rule (R6) and R5 steps aside. With no CTC on record R5 applies as written (and R8 flags the missing CTC).
 */
const governedBySwitching = (held: EngineOffer, drive: EngineDrive) => held.type === 'F' && held.ctcLpa != null && hasFte(drive.offerType) && drive.ctcLpa != null;

const r5: RuleFn = ({ offers, drive }) => {
  const out: ReturnType<RuleFn> = [];
  for (const o of offers.filter(accepted)) {
    if (TYPE_MAY_APPLY[o.type].includes(drive.offerType)) continue;
    if (governedBySwitching(o, drive)) continue; // decided by R6
    out.push({ outcome: 'BLOCK', message: `holds ${TYPE_NAME[o.type]} offer; may not apply to ${TYPE_NAME[drive.offerType]} drives` });
  }
  return out;
};

const r6: RuleFn = ({ offers, drive, params }) => {
  const cur = highestAcceptedFte(offers);
  if (!cur) return [];
  const heldCat = categoryFor(cur.ctcLpa, params.thresholds);
  const held = `holds ${heldCat} offer at ${fmtLpa(cur.ctcLpa)}`;

  if (heldCat === 'A+') {
    return [{ outcome: 'BLOCK', message: `${held}; A+ offers take the student out of the placement process for all further drives` }];
  }
  // Internship-only drives carry a stipend, not a CTC: the offer-type rule (R5) governs those.
  if (drive.ctcLpa == null || !hasFte(drive.offerType)) return [];

  const newCat = categoryFor(drive.ctcLpa, params.thresholds);
  const newTxt = `new drive ${fmtLpa(drive.ctcLpa)} (${newCat})`;

  if (heldCat === 'A') {
    return newCat === 'A+' ? [] : [{ outcome: 'BLOCK', message: `${held}; may only apply to A+ drives, ${newTxt}` }];
  }
  if (heldCat === 'B') {
    const m = Math.round(params.switchB.multiplier * MULT_SCALE);
    const threshold = (h(cur.ctcLpa) * m) / MULT_SCALE; // hundredths of LPA
    if (h(drive.ctcLpa) >= threshold) return [];
    const need = threshold / 100;
    return [{ outcome: 'BLOCK', message: `${held}; ${newTxt} is below ${params.switchB.multiplier} × ${Number(cur.ctcLpa.toFixed(2))} = ${fmtLpa(need)}` }];
  }
  // C: only higher-category drives (A+, A, B).
  return newCat === 'C' ? [{ outcome: 'BLOCK', message: `${held}; may only apply to higher-category drives (A+, A, B), ${newTxt}` }] : [];
};

const r7: RuleFn = ({ offers, now }) => {
  const open = offers.find((o) => o.acceptance === 'pending' && o.deadline.getTime() > now.getTime());
  return open ? [{ outcome: 'REVIEW', message: 'has a pending offer still inside its acceptance window; accept or decline it first' }] : [];
};

const r8: RuleFn = ({ offers }) => {
  const out: ReturnType<RuleFn> = [];
  const live = offers.filter((o) => o.acceptance === 'pending' || o.acceptance === 'accepted');
  if (live.some((o) => o.offCampus && o.noc === 'pending')) out.push({ outcome: 'REVIEW', message: 'off-campus offer without a NOC on record' });
  if (live.some((o) => accepted(o) && hasFte(o.type) && o.ctcLpa == null)) out.push({ outcome: 'REVIEW', message: 'accepted FTE offer has no CTC recorded' });
  const seen = new Set<string>();
  for (const o of live) {
    const k = o.driveId ? `drive:${o.driveId}` : `co:${o.companyKey.toLowerCase()}:${o.type}`;
    if (seen.has(k)) {
      out.push({ outcome: 'REVIEW', message: 'duplicate offer from the same drive/company on record' });
      break;
    }
    seen.add(k);
  }
  return out;
};

const RULES: [RuleCode, RuleFn][] = [
  ['R1', r1],
  ['R2', r2],
  ['R3', r3],
  ['R4', r4],
  ['R5', r5],
  ['R6', r6],
  ['R7', r7],
  ['R8', r8],
];

/** Can student S apply to drive D? */
export function evaluate(input: EngineInput): Decision {
  const { now } = input;
  const live = input.exceptions.filter((e) => !e.revokedAt && e.expiresAt.getTime() > now.getTime());
  const fired: FiredRule[] = [];

  for (const [code, fn] of RULES) {
    for (const hit of fn(input)) {
      const ex = live.find((e) => e.ruleCode === code);
      fired.push(
        ex
          ? { code, title: RULE_TITLES[code], outcome: 'OVERRIDDEN', message: `${hit.outcome} overridden by exception #${ex.id.slice(0, 8)}: ${hit.message}`, exception_id: ex.id }
          : { code, title: RULE_TITLES[code], outcome: hit.outcome, message: hit.message },
      );
    }
  }

  const drive_category = input.drive.ctcLpa != null && hasFte(input.drive.offerType) ? categoryFor(input.drive.ctcLpa, input.params.thresholds) : null;
  const firstBlock = fired.find((f) => f.outcome === 'BLOCK');
  const firstReview = fired.find((f) => f.outcome === 'REVIEW');
  const override = fired.find((f) => f.outcome === 'OVERRIDDEN');

  if (firstBlock) return { result: 'BLOCK', fired_rules: fired, summary: `BLOCK - ${firstBlock.code}: ${firstBlock.message}`, drive_category };
  if (firstReview) return { result: 'REVIEW', fired_rules: fired, summary: `REVIEW - ${firstReview.code}: ${firstReview.message}`, drive_category };
  if (override) return { result: 'ALLOW', fired_rules: fired, summary: `ALLOW (exception #${override.exception_id!.slice(0, 8)})`, exception_id: override.exception_id, drive_category };
  return { result: 'ALLOW', fired_rules: fired, summary: 'ALLOW', drive_category };
}

// ------------------------------------------------- placement state (derived) ----

export interface SwitchingProfile {
  rule: string;
  blocked_all: boolean;
  allowed_categories: Category[];
  allowed_offer_types: OfferType[];
  /** Category B only: minimum CTC (LPA) a new FTE drive must pay. */
  min_ctc_lpa: number | null;
  note: string;
}

export interface PlacementState {
  placement_status: PlacementStatus;
  current_category: Category | null;
  highest_ctc_lpa: number | null;
  accepted_offer_count: number;
  pending_offer_count: number;
  switching: SwitchingProfile;
}

/**
 * Placement status and switching eligibility are computed here and nowhere else. Nobody types them and no API
 * has a write path to them: they are recomputed from accepted offers after every offer/policy event.
 */
export function computePlacementState(offers: EngineOffer[], params: PolicyParams, now: Date = new Date()): PlacementState {
  const acc = offers.filter(accepted);
  const hasI = acc.some((o) => o.type === 'I');
  const hasF = acc.some((o) => o.type === 'F');
  const hasIF = acc.some((o) => o.type === 'IF');

  let placement_status: PlacementStatus = 'Unplaced';
  if (hasIF || (hasI && hasF)) placement_status = 'Internship + PPO/FTE';
  else if (hasI) placement_status = 'Internship only';
  else if (hasF) placement_status = 'FTE only';

  const cur = highestAcceptedFte(offers);
  const current_category = cur ? categoryFor(cur.ctcLpa, params.thresholds) : null;

  // Offer types still open to the student. An F holder with a CTC on record may still move to a higher-category
  // FTE drive (R6 decides which), so F/I+F stay in the list for them; the category list below narrows it.
  let types: OfferType[] = ['I', 'F', 'IF'];
  for (const o of acc) {
    const may: OfferType[] = o.type === 'F' && o.ctcLpa != null ? ['I', 'F', 'IF'] : TYPE_MAY_APPLY[o.type];
    types = types.filter((t) => may.includes(t));
  }

  let switching: SwitchingProfile;
  if (!cur) {
    switching = {
      rule: types.length === 3 ? 'none' : 'R5',
      blocked_all: types.length === 0,
      allowed_categories: [...CATEGORIES],
      allowed_offer_types: types,
      min_ctc_lpa: null,
      note: types.length === 3 ? 'No accepted FTE offer: no category restriction.' : 'Restricted by the offer-type rule only.',
    };
  } else if (current_category === 'A+') {
    switching = { rule: 'R6 (A+)', blocked_all: true, allowed_categories: [], allowed_offer_types: [], min_ctc_lpa: null, note: 'A+ offer accepted: out of the placement process.' };
  } else if (current_category === 'A') {
    switching = { rule: 'R6 (A)', blocked_all: types.length === 0, allowed_categories: ['A+'], allowed_offer_types: types, min_ctc_lpa: null, note: 'May apply only to A+ drives.' };
  } else if (current_category === 'B') {
    const minH = (h(cur.ctcLpa) * Math.round(params.switchB.multiplier * MULT_SCALE)) / MULT_SCALE; // hundredths of LPA
    const min = minH / 100;
    // A+ and A drives pay above any possible minimum; B is reachable only while the minimum is still inside the B band.
    const allowed = CATEGORIES.filter((c) => c === 'A+' || c === 'A' || (c === 'B' && minH < h(params.thresholds.aMin)));
    switching = {
      rule: 'R6 (B)',
      blocked_all: types.length === 0,
      allowed_categories: allowed,
      allowed_offer_types: types,
      min_ctc_lpa: Number(min.toFixed(2)),
      note: `New FTE CTC must be at least ${params.switchB.multiplier} × ${Number(cur.ctcLpa.toFixed(2))} = ${fmtLpa(min)}.`,
    };
  } else {
    switching = { rule: 'R6 (C)', blocked_all: types.length === 0, allowed_categories: ['A+', 'A', 'B'], allowed_offer_types: types, min_ctc_lpa: null, note: 'May apply to higher-category drives (A+, A, B).' };
  }

  return {
    placement_status,
    current_category,
    highest_ctc_lpa: cur?.ctcLpa ?? null,
    accepted_offer_count: acc.length,
    pending_offer_count: offers.filter((o) => o.acceptance === 'pending' && o.deadline.getTime() > now.getTime()).length,
    switching,
  };
}
