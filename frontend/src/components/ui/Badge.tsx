import type { ReactNode } from "react";

const tones = {
  neutral: "bg-[var(--surface-1)] text-[var(--text-secondary)]",
  brand: "bg-[var(--surface-1)] text-[var(--brand-primary)]",
  allow: "bg-[var(--status-allow-bg)] text-[var(--status-allow-text)]",
  review: "bg-[var(--status-review-bg)] text-[var(--status-review-text)]",
  block: "bg-[var(--status-block-bg)] text-[var(--status-block-text)]",
} as const;
export type BadgeTone = keyof typeof tones;

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`inline-flex items-center h-6 px-2 rounded-[var(--radius-xs)] text-xs font-medium whitespace-nowrap ${tones[tone]}`}>{children}</span>;
}

const STATUS_TONE: Record<string, BadgeTone> = {
  accepted: "allow", eligible: "allow", registered: "allow", active: "allow", published: "allow", selected: "allow", joined: "allow", confirmed: "allow", received: "allow", approved: "allow", success: "allow", ALLOW: "allow", resolved: "allow",
  pending: "review", pending_review: "review", proposed: "review", REVIEW: "review", invited: "review", open: "review", shortlisted: "brand", applied: "neutral",
  declined: "block", expired: "block", ineligible: "block", rejected: "block", disabled: "block", deregistered: "block", BLOCK: "block", blocked: "block", failed: "block", not_joined: "block",
};

export function StatusPill({ value, label }: { value: string; label?: string }) {
  return <Badge tone={STATUS_TONE[value] ?? "neutral"}>{label ?? value.replace(/_/g, " ")}</Badge>;
}

const CAT_TONE: Record<string, BadgeTone> = { "A+": "block", A: "review", B: "brand", C: "neutral" };
export const CategoryBadge = ({ category }: { category: string | null | undefined }) =>
  category ? <Badge tone={CAT_TONE[category] ?? "neutral"}>Category {category}</Badge> : <span className="text-[var(--text-tertiary)]">—</span>;
