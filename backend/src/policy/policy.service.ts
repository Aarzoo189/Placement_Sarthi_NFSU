import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../common/audit.service';
import { Actor } from '../common/types';
import { DEFAULT_POLICY, PolicyParams } from './engine';

/** Rule codes in the versioned policy_rule table. Thresholds live here, not in code, because the guidelines can be amended. */
export const policyParamsSchema = z
  .object({
    thresholds: z.object({ aPlusMin: z.number().positive().max(1000), aMin: z.number().positive(), bMin: z.number().positive() }).strict(),
    switchB: z.object({ multiplier: z.number().min(1).max(5) }).strict(),
    absenteeism: z.object({ lastDrives: z.number().int().min(1).max(10) }).strict(),
    acceptance: z.object({ hours: z.number().int().min(1).max(168) }).strict(),
  })
  .strict()
  .refine((p) => p.thresholds.aPlusMin > p.thresholds.aMin && p.thresholds.aMin > p.thresholds.bMin, { message: 'Thresholds must satisfy A+ > A > B', path: ['thresholds'] });

export const proposeSchema = z
  .object({
    params: z
      .object({
        thresholds: z.object({ aPlusMin: z.number(), aMin: z.number(), bMin: z.number() }).partial().strict().optional(),
        switchB: z.object({ multiplier: z.number() }).partial().strict().optional(),
        absenteeism: z.object({ lastDrives: z.number() }).partial().strict().optional(),
        acceptance: z.object({ hours: z.number() }).partial().strict().optional(),
      })
      .strict(),
    note: z.string().trim().min(5, 'Say why the rules are changing').max(500),
  })
  .strict();

const toRules = (p: PolicyParams) => [
  { code: 'CATEGORY_THRESHOLDS', params_json: { a_plus_min: p.thresholds.aPlusMin, a_min: p.thresholds.aMin, b_min: p.thresholds.bMin } },
  { code: 'SWITCH_B_MULTIPLIER', params_json: { multiplier: p.switchB.multiplier } },
  { code: 'ABSENTEEISM_WINDOW', params_json: { last_drives: p.absenteeism.lastDrives } },
  { code: 'ACCEPTANCE_WINDOW', params_json: { hours: p.acceptance.hours } },
];

export function rulesToParams(rules: { code: string; params_json: unknown }[]): PolicyParams {
  const get = (code: string) => (rules.find((r) => r.code === code)?.params_json ?? {}) as Record<string, number>;
  const t = get('CATEGORY_THRESHOLDS');
  return {
    thresholds: { aPlusMin: t.a_plus_min ?? DEFAULT_POLICY.thresholds.aPlusMin, aMin: t.a_min ?? DEFAULT_POLICY.thresholds.aMin, bMin: t.b_min ?? DEFAULT_POLICY.thresholds.bMin },
    switchB: { multiplier: get('SWITCH_B_MULTIPLIER').multiplier ?? DEFAULT_POLICY.switchB.multiplier },
    absenteeism: { lastDrives: get('ABSENTEEISM_WINDOW').last_drives ?? DEFAULT_POLICY.absenteeism.lastDrives },
    acceptance: { hours: get('ACCEPTANCE_WINDOW').hours ?? DEFAULT_POLICY.acceptance.hours },
  };
}

/**
 * Versioned policy: every decision stores the policy version that produced it, so a past decision can still be explained
 * after the rules change. Changing the rules takes two people: Officer/Admin propose, a Super Admin who did NOT propose it publishes.
 */
@Injectable()
export class PolicyService implements OnModuleInit {
  private readonly log = new Logger('Policy');
  private cache?: { at: number; version: number; params: PolicyParams };
  onPublished?: () => void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit() {
    if ((await this.prisma.policy_version.count()) === 0) {
      await this.prisma.policy_version.create({
        data: { version: 1, status: 'published', note: 'Initial 2026-27 placement guidelines', published_at: new Date(), effective_from: new Date(), rules: { create: toRules(DEFAULT_POLICY).map((r) => ({ ...r })) } },
      });
      this.log.log('Bootstrapped policy v1 from the 2026-27 guidelines');
    }
  }

  async current(): Promise<{ version: number; params: PolicyParams }> {
    if (this.cache && Date.now() - this.cache.at < 15_000) return this.cache;
    const v = await this.prisma.policy_version.findFirst({ where: { status: 'published' }, orderBy: { version: 'desc' }, include: { rules: true } });
    if (!v) return { version: 0, params: DEFAULT_POLICY };
    this.cache = { at: Date.now(), version: v.version, params: rulesToParams(v.rules) };
    return this.cache;
  }

  async versions() {
    const rows = await this.prisma.policy_version.findMany({ orderBy: { version: 'desc' }, include: { rules: true } });
    return rows.map((r) => ({
      version: r.version,
      status: r.status,
      note: r.note,
      created_by: r.created_by,
      proposed_by: r.proposed_by,
      published_by: r.published_by,
      created_at: r.created_at,
      published_at: r.published_at,
      params: rulesToParams(r.rules),
    }));
  }

  /** Officer / Admin: propose a change. It stays inactive until a different person (Super Admin) publishes it. */
  async propose(actor: Actor, input: z.infer<typeof proposeSchema>) {
    const open = await this.prisma.policy_version.count({ where: { status: 'proposed' } });
    if (open >= 3) throw new ConflictException({ message: 'Too many proposals are waiting for approval. Ask the Super Admin to publish or reject them first.', code: 'TOO_MANY_PROPOSALS' });
    const cur = await this.current();
    const merged = {
      thresholds: { ...cur.params.thresholds, ...input.params.thresholds },
      switchB: { ...cur.params.switchB, ...input.params.switchB },
      absenteeism: { ...cur.params.absenteeism, ...input.params.absenteeism },
      acceptance: { ...cur.params.acceptance, ...input.params.acceptance },
    };
    const parsed = policyParamsSchema.safeParse(merged);
    if (!parsed.success) throw new BadRequestException({ message: 'Invalid policy', errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });

    const max = await this.prisma.policy_version.aggregate({ _max: { version: true } });
    const version = (max._max.version ?? 0) + 1;
    await this.prisma.policy_version.create({
      data: { version, status: 'proposed', note: input.note, created_by: actor.id, proposed_by: actor.id, rules: { create: toRules(parsed.data).map((r) => ({ ...r })) } },
    });
    await this.audit.log({ actor, action: 'POLICY_PROPOSED', entity: 'policy_version', entity_id: String(version), before: cur.params, after: parsed.data, meta: { note: input.note } });
    return { version };
  }

  async publish(actor: Actor, version: number) {
    const v = await this.prisma.policy_version.findUnique({ where: { version }, include: { rules: true } });
    if (!v) throw new NotFoundException('Policy version not found');
    if (v.status !== 'proposed') throw new ConflictException({ message: `Only a proposed version can be published (this one is ${v.status}).`, code: 'BAD_STATE' });
    // Four-eyes rule: the person who drafted a change cannot approve it.
    if (v.proposed_by === actor.id || v.created_by === actor.id) throw new ForbiddenException({ message: 'A second person must approve and publish a policy change; you proposed this one.', code: 'FOUR_EYES' });

    const before = await this.current();
    await this.prisma.$transaction([
      this.prisma.policy_version.updateMany({ where: { status: 'published' }, data: { status: 'superseded' } }),
      this.prisma.policy_version.update({ where: { version }, data: { status: 'published', published_by: actor.id, published_at: new Date(), effective_from: new Date() } }),
    ]);
    this.cache = undefined;
    await this.audit.log({ actor, action: 'POLICY_PUBLISHED', entity: 'policy_version', entity_id: String(version), before: before.params, after: rulesToParams(v.rules) });
    this.onPublished?.();
    return { version };
  }

  async reject(actor: Actor, version: number, reason: string) {
    const v = await this.prisma.policy_version.findUnique({ where: { version } });
    if (!v || v.status !== 'proposed') throw new NotFoundException('No such proposal');
    await this.prisma.policy_version.update({ where: { version }, data: { status: 'rejected', note: `${v.note ?? ''} | rejected: ${reason}`.slice(0, 600) } });
    await this.audit.log({ actor, action: 'POLICY_REJECTED', entity: 'policy_version', entity_id: String(version), meta: { reason } });
  }
}
