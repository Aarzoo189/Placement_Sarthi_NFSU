/**
 * Rule-engine tests P1-P10 from the architecture doc (section 11), plus one test per rule and the derived-state helpers.
 * These are pure unit tests: no database, no Redis.
 */
import {
  DEFAULT_POLICY,
  EngineInput,
  EngineOffer,
  EngineDrive,
  OfferType,
  categoryFor,
  computeDeadline,
  computePlacementState,
  evaluate,
} from '../src/policy/engine';

const NOW = new Date('2026-10-13T10:00:00Z');

const offer = (o: Partial<EngineOffer> & { type: OfferType; ctcLpa?: number | null }): EngineOffer => ({
  id: o.id ?? 'o-' + Math.random().toString(36).slice(2, 8),
  type: o.type,
  ctcLpa: o.ctcLpa === undefined ? null : o.ctcLpa,
  acceptance: o.acceptance ?? 'accepted',
  deadline: o.deadline ?? new Date(NOW.getTime() - 3_600_000),
  driveId: o.driveId ?? 'd-' + Math.random().toString(36).slice(2, 8),
  companyKey: o.companyKey ?? 'co-' + Math.random().toString(36).slice(2, 8),
  offCampus: o.offCampus ?? false,
  noc: o.noc ?? 'not_required',
});

const drive = (d: Partial<EngineDrive> & { offerType: OfferType }): EngineDrive => ({
  id: 'drive-new',
  ctcLpa: null,
  criteria: {},
  ...d,
});

const run = (over: Partial<EngineInput> & { drive: EngineDrive }) =>
  evaluate({
    student: { registration: 'registered', eligibility: 'eligible', programmeCode: 'MTECH-CS', batch: 2026, cgpa: 8.2, backlogs: 0 },
    offers: [],
    recentDrives: [],
    exceptions: [],
    now: NOW,
    params: DEFAULT_POLICY,
    ...over,
  });

describe('P1-P10: category and offer-type rules', () => {
  test('P1 holds an A+ offer, applies to any drive -> BLOCK (R6, out of process)', () => {
    for (const type of ['I', 'F', 'IF'] as OfferType[]) {
      const d = run({ offers: [offer({ type: 'F', ctcLpa: 18 })], drive: drive({ offerType: type, ctcLpa: type === 'I' ? null : 30 }) });
      expect(d.result).toBe('BLOCK');
      expect(d.fired_rules.some((r) => r.code === 'R6' && r.outcome === 'BLOCK')).toBe(true);
      expect(d.summary).toMatch(/R6/);
    }
  });

  test('P2 holds A at 12 LPA, applies to A+ at 18 -> ALLOW', () => {
    const d = run({ offers: [offer({ type: 'F', ctcLpa: 12 })], drive: drive({ offerType: 'F', ctcLpa: 18 }) });
    expect(d.result).toBe('ALLOW');
  });

  test('P3 holds A at 12, applies to A at 14 -> BLOCK', () => {
    const d = run({ offers: [offer({ type: 'F', ctcLpa: 12 })], drive: drive({ offerType: 'F', ctcLpa: 14 }) });
    expect(d.result).toBe('BLOCK');
    expect(d.fired_rules[0].code).toBe('R6');
  });

  test('P4 holds B at 8, applies at 11.9 -> BLOCK, at 12 -> ALLOW (1.5x boundary)', () => {
    const held = [offer({ type: 'F', ctcLpa: 8 })];
    const below = run({ offers: held, drive: drive({ offerType: 'F', ctcLpa: 11.9 }) });
    expect(below.result).toBe('BLOCK');
    expect(below.summary).toContain('R6');
    expect(below.summary).toContain('1.5 × 8 = ₹12 LPA'); // the example from the doc
    expect(run({ offers: held, drive: drive({ offerType: 'F', ctcLpa: 12 }) }).result).toBe('ALLOW');
  });

  test('P4 boundary is exact for awkward decimals (no float drift): 1.5 x 7.3 = 10.95', () => {
    const held = [offer({ type: 'F', ctcLpa: 7.3 })];
    expect(run({ offers: held, drive: drive({ offerType: 'F', ctcLpa: 10.95 }) }).result).toBe('ALLOW');
    expect(run({ offers: held, drive: drive({ offerType: 'F', ctcLpa: 10.94 }) }).result).toBe('BLOCK');
  });

  test('category C holder may apply to A+, A, B but not C', () => {
    const held = [offer({ type: 'F', ctcLpa: 4 })];
    expect(run({ offers: held, drive: drive({ offerType: 'F', ctcLpa: 5 }) }).result).toBe('BLOCK');
    expect(run({ offers: held, drive: drive({ offerType: 'F', ctcLpa: 6 }) }).result).toBe('ALLOW');
    expect(run({ offers: held, drive: drive({ offerType: 'F', ctcLpa: 20 }) }).result).toBe('ALLOW');
  });

  test('P5 holds I: another I -> BLOCK, F -> ALLOW', () => {
    const held = [offer({ type: 'I' })];
    expect(run({ offers: held, drive: drive({ offerType: 'I' }) }).result).toBe('BLOCK');
    expect(run({ offers: held, drive: drive({ offerType: 'F', ctcLpa: 9 }) }).result).toBe('ALLOW');
    expect(run({ offers: held, drive: drive({ offerType: 'IF', ctcLpa: 9 }) }).result).toBe('ALLOW');
  });

  test('P6 holds F: another F of the same category -> BLOCK, an internship (I) -> ALLOW', () => {
    const held = [offer({ type: 'F', ctcLpa: 4 })];
    const f = run({ offers: held, drive: drive({ offerType: 'F', ctcLpa: 5 }) });
    expect(f.result).toBe('BLOCK');
    expect(f.fired_rules.some((r) => r.code === 'R6')).toBe(true);
    expect(run({ offers: held, drive: drive({ offerType: 'I' }) }).result).toBe('ALLOW');
  });

  test('P6b FTE-only holder with NO CTC on record: R5 applies as written (another F blocked) and R8 flags the data', () => {
    const held = [offer({ type: 'F', ctcLpa: null })];
    const f = run({ offers: held, drive: drive({ offerType: 'F', ctcLpa: 20 }) });
    expect(f.result).toBe('BLOCK');
    expect(f.fired_rules.map((r) => r.code)).toEqual(expect.arrayContaining(['R5', 'R8']));
    expect(run({ offers: held, drive: drive({ offerType: 'I' }) }).fired_rules.some((r) => r.code === 'R5')).toBe(false);
  });

  test('FTE-only holder moving to a higher-category FTE drive is decided by R6, not R5', () => {
    const held = [offer({ type: 'F', ctcLpa: 4 })];
    const up = run({ offers: held, drive: drive({ offerType: 'F', ctcLpa: 20 }) });
    expect(up.result).toBe('ALLOW');
    expect(up.fired_rules).toHaveLength(0);
  });

  test('P7 holds I+F: anything -> BLOCK', () => {
    const held = [offer({ type: 'IF', ctcLpa: 7 })];
    for (const type of ['I', 'F', 'IF'] as OfferType[]) {
      const d = run({ offers: held, drive: drive({ offerType: type, ctcLpa: type === 'I' ? null : 25 }) });
      expect(d.result).toBe('BLOCK');
    }
  });

  test('P8 absent at the last drive: BLOCK without exception, ALLOW with one', () => {
    const recentDrives = [{ driveId: 'x', label: 'Acme PPT', absentUnexcused: true }];
    const d = drive({ offerType: 'F', ctcLpa: 9 });
    expect(run({ recentDrives, drive: d }).result).toBe('BLOCK');

    const withEx = run({
      recentDrives,
      drive: d,
      exceptions: [{ id: '1234abcd-0000', ruleCode: 'R4', expiresAt: new Date(NOW.getTime() + 86_400_000), revokedAt: null }],
    });
    expect(withEx.result).toBe('ALLOW');
    expect(withEx.summary).toContain('exception #1234abcd');
    expect(withEx.exception_id).toBe('1234abcd-0000');
  });

  test('P8b absences older than the last 3 drives do not count; expired or revoked exceptions do not override', () => {
    const old = [
      { driveId: '1', label: 'a', absentUnexcused: false },
      { driveId: '2', label: 'b', absentUnexcused: false },
      { driveId: '3', label: 'c', absentUnexcused: false },
      { driveId: '4', label: 'd', absentUnexcused: true },
    ];
    const d = drive({ offerType: 'F', ctcLpa: 9 });
    expect(run({ recentDrives: old, drive: d }).result).toBe('ALLOW');

    const recent = [{ driveId: '1', label: 'a', absentUnexcused: true }];
    const expired = { id: 'e1', ruleCode: 'R4', expiresAt: new Date(NOW.getTime() - 1), revokedAt: null };
    const revoked = { id: 'e2', ruleCode: 'R4', expiresAt: new Date(NOW.getTime() + 1e6), revokedAt: new Date(NOW) };
    expect(run({ recentDrives: recent, drive: d, exceptions: [expired, revoked] }).result).toBe('BLOCK');
  });

  test('P9 offer issued 10:00, company deadline 48 h -> expires next day 10:00; earlier company deadline wins', () => {
    const issued = new Date('2026-10-13T10:00:00Z');
    expect(computeDeadline(issued, new Date('2026-10-15T10:00:00Z'), 24).toISOString()).toBe('2026-10-14T10:00:00.000Z');
    expect(computeDeadline(issued, new Date('2026-10-13T16:00:00Z'), 24).toISOString()).toBe('2026-10-13T16:00:00.000Z');
    expect(computeDeadline(issued, null, 24).toISOString()).toBe('2026-10-14T10:00:00.000Z');
  });

  test('P10 CTC exactly 16 / 10 / 6 LPA -> A+ / A / B (and just below)', () => {
    const t = DEFAULT_POLICY.thresholds;
    expect(categoryFor(16, t)).toBe('A+');
    expect(categoryFor(15.99, t)).toBe('A');
    expect(categoryFor(10, t)).toBe('A');
    expect(categoryFor(9.99, t)).toBe('B');
    expect(categoryFor(6, t)).toBe('B');
    expect(categoryFor(5.99, t)).toBe('C');
  });

  test('thresholds come from the policy, not from code', () => {
    const custom = { ...DEFAULT_POLICY, thresholds: { aPlusMin: 20, aMin: 12, bMin: 7 } };
    expect(categoryFor(16, custom.thresholds)).toBe('A');
    const d = run({ params: custom, offers: [offer({ type: 'F', ctcLpa: 18 })], drive: drive({ offerType: 'F', ctcLpa: 25 }) });
    expect(d.result).toBe('ALLOW'); // 18 LPA is category A under the custom policy, so an A+ drive is open
  });
});

describe('R1-R3, R7, R8', () => {
  const d = drive({ offerType: 'F', ctcLpa: 9 });

  test('R1 not registered / deregistered -> BLOCK', () => {
    const s = { registration: 'deregistered' as const, eligibility: 'eligible' as const, programmeCode: 'MTECH-CS', batch: 2026, cgpa: 8, backlogs: 0 };
    expect(run({ student: s, drive: d }).fired_rules[0].code).toBe('R1');
    expect(run({ student: { ...s, registration: 'not_registered' }, drive: d }).result).toBe('BLOCK');
  });

  test('R2 ineligible -> BLOCK; pending verification -> REVIEW', () => {
    const base = { registration: 'registered' as const, programmeCode: 'MTECH-CS', batch: 2026, cgpa: 8, backlogs: 0 };
    expect(run({ student: { ...base, eligibility: 'ineligible' }, drive: d }).result).toBe('BLOCK');
    expect(run({ student: { ...base, eligibility: 'pending' }, drive: d }).result).toBe('REVIEW');
  });

  test('R2 pending + R1 block: BLOCK wins over REVIEW', () => {
    const s = { registration: 'not_registered' as const, eligibility: 'pending' as const, programmeCode: 'MTECH-CS', batch: 2026, cgpa: 8, backlogs: 0 };
    expect(run({ student: s, drive: d }).result).toBe('BLOCK');
  });

  test('R3 company criteria: cgpa, backlogs, programme, batch', () => {
    const crit = drive({ offerType: 'F', ctcLpa: 9, criteria: { min_cgpa: 8.5, max_backlogs: 0, programmes: ['MSC-DFIS'], batches: [2027] } });
    const res = run({ drive: crit });
    expect(res.result).toBe('BLOCK');
    const msg = res.fired_rules.find((r) => r.code === 'R3')!.message;
    expect(msg).toContain('CGPA');
    expect(msg).toContain('programme');
    expect(msg).toContain('batch');
    expect(run({ drive: drive({ offerType: 'F', ctcLpa: 9, criteria: { min_cgpa: 8.2 } }) }).result).toBe('ALLOW'); // boundary: equal passes
  });

  test('R7 pending offer inside window -> REVIEW; past its deadline it is no longer a reason', () => {
    const inWindow = offer({ type: 'F', ctcLpa: 5, acceptance: 'pending', deadline: new Date(NOW.getTime() + 3_600_000) });
    const lapsed = offer({ type: 'F', ctcLpa: 5, acceptance: 'pending', deadline: new Date(NOW.getTime() - 1) });
    expect(run({ offers: [inWindow], drive: d }).result).toBe('REVIEW');
    expect(run({ offers: [lapsed], drive: d }).result).toBe('ALLOW');
  });

  test('R8 data conflicts: off-campus offer without NOC, missing CTC, duplicate offer -> REVIEW', () => {
    const noNoc = offer({ type: 'I', offCampus: true, noc: 'pending', companyKey: 'zeta' });
    expect(run({ offers: [noNoc], drive: drive({ offerType: 'F', ctcLpa: 9 }) }).result).toBe('REVIEW');

    const missingCtc = offer({ type: 'F', ctcLpa: null });
    expect(run({ offers: [missingCtc], drive: drive({ offerType: 'I' }) }).fired_rules.some((r) => r.code === 'R8')).toBe(true);

    const a = offer({ type: 'I', driveId: 'same' });
    const b = offer({ type: 'I', driveId: 'same' });
    expect(run({ offers: [a, b], drive: drive({ offerType: 'F', ctcLpa: 9 }) }).fired_rules.some((r) => r.code === 'R8')).toBe(true);
  });

  test('every decision lists the rules that fired, with reasons', () => {
    const res = run({
      student: { registration: 'registered', eligibility: 'ineligible', programmeCode: 'MTECH-CS', batch: 2026, cgpa: 5, backlogs: 3 },
      drive: drive({ offerType: 'F', ctcLpa: 9, criteria: { min_cgpa: 7 } }),
    });
    expect(res.fired_rules.map((r) => r.code)).toEqual(['R2', 'R3']);
    expect(res.fired_rules.every((r) => r.message.length > 0)).toBe(true);
  });
});

describe('placement state (derived, never typed)', () => {
  const st = (offers: EngineOffer[]) => computePlacementState(offers, DEFAULT_POLICY, NOW);

  test('Unplaced / Internship only / FTE only / Internship + PPO/FTE', () => {
    expect(st([]).placement_status).toBe('Unplaced');
    expect(st([offer({ type: 'I' })]).placement_status).toBe('Internship only');
    expect(st([offer({ type: 'F', ctcLpa: 7 })]).placement_status).toBe('FTE only');
    expect(st([offer({ type: 'IF', ctcLpa: 7 })]).placement_status).toBe('Internship + PPO/FTE');
    expect(st([offer({ type: 'I' }), offer({ type: 'F', ctcLpa: 7 })]).placement_status).toBe('Internship + PPO/FTE');
  });

  test('declined, expired and pending offers do not change status', () => {
    const s = st([
      offer({ type: 'F', ctcLpa: 30, acceptance: 'declined' }),
      offer({ type: 'F', ctcLpa: 30, acceptance: 'expired' }),
      offer({ type: 'F', ctcLpa: 30, acceptance: 'pending', deadline: new Date(NOW.getTime() + 1e6) }),
    ]);
    expect(s.placement_status).toBe('Unplaced');
    expect(s.pending_offer_count).toBe(1);
    expect(s.highest_ctc_lpa).toBeNull();
  });

  test('switching profile follows the highest accepted FTE CTC', () => {
    const b = st([offer({ type: 'F', ctcLpa: 8 })]);
    expect(b.current_category).toBe('B');
    expect(b.switching.min_ctc_lpa).toBe(12);
    expect(b.switching.allowed_categories).toEqual(['A+', 'A']);
    expect(b.switching.allowed_offer_types).toEqual(['I', 'F', 'IF']); // F/I+F only above the category minimum

    expect(st([offer({ type: 'F', ctcLpa: 17 })]).switching.blocked_all).toBe(true);
    expect(st([offer({ type: 'F', ctcLpa: 11 })]).switching.allowed_categories).toEqual(['A+']);
    expect(st([offer({ type: 'F', ctcLpa: 3 })]).switching.allowed_categories).toEqual(['A+', 'A', 'B']);
    expect(st([offer({ type: 'IF', ctcLpa: 7 })]).switching.blocked_all).toBe(true);
  });

  test('highest accepted FTE CTC wins when several offers exist', () => {
    const s = st([offer({ type: 'I' }), offer({ type: 'F', ctcLpa: 7 }), offer({ type: 'IF', ctcLpa: 11 })]);
    expect(s.highest_ctc_lpa).toBe(11);
    expect(s.current_category).toBe('A');
  });
});
