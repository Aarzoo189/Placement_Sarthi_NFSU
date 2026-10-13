import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import type { PolicyOutcome } from "../../lib/types";

const config: Record<PolicyOutcome, { label: string; icon: typeof CheckCircle2; cls: string }> = {
  ALLOW: { label: "Allow", icon: CheckCircle2, cls: "text-[var(--status-allow-text)] bg-[var(--status-allow-bg)]" },
  REVIEW: { label: "Review", icon: AlertTriangle, cls: "text-[var(--status-review-text)] bg-[var(--status-review-bg)]" },
  BLOCK: { label: "Blocked", icon: XCircle, cls: "text-[var(--status-block-text)] bg-[var(--status-block-bg)]" },
};

export function StatusBadge({ outcome, size = "md" }: { outcome: PolicyOutcome; size?: "sm" | "md" }) {
  const c = config[outcome];
  const Icon = c.icon;
  const padding = size === "sm" ? "h-5 px-1.5 text-[11px]" : "h-6 px-2 text-xs";
  const iconSize = size === "sm" ? 12 : 13;
  return (
    <span className={`inline-flex items-center gap-1 ${padding} rounded-[var(--radius-xs)] font-medium tracking-wide ${c.cls}`}>
      <Icon size={iconSize} strokeWidth={2.25} aria-hidden />
      {c.label}
    </span>
  );
}

const appStatusConfig: Record<string, { label: string; cls: string }> = {
  eligible: { label: "Eligible", cls: "text-[var(--status-allow-text)] bg-[var(--status-allow-bg)]" },
  applied: { label: "Applied", cls: "text-[var(--text-secondary)] bg-[var(--surface-1)]" },
  pending_review: { label: "Awaiting officer review", cls: "text-[var(--status-review-text)] bg-[var(--status-review-bg)]" },
  shortlisted: { label: "Shortlisted", cls: "text-[var(--brand-primary)] bg-[var(--surface-1)]" },
  selected: { label: "Selected", cls: "text-[var(--status-allow-text)] bg-[var(--status-allow-bg)]" },
  interview: { label: "Interview", cls: "text-[var(--status-review-text)] bg-[var(--status-review-bg)]" },
  offer: { label: "Offer", cls: "text-[var(--status-allow-text)] bg-[var(--status-allow-bg)]" },
  rejected: { label: "Not selected", cls: "text-[var(--status-block-text)] bg-[var(--status-block-bg)]" },
  withdrawn: { label: "Withdrawn", cls: "text-[var(--text-tertiary)] bg-[var(--surface-1)]" },
};

export function AppStatusBadge({ status }: { status: string }) {
  const c = appStatusConfig[status] ?? appStatusConfig.applied!;
  return <span className={`inline-flex items-center h-6 px-2 rounded-[var(--radius-xs)] text-xs font-medium whitespace-nowrap ${c.cls}`}>{c.label}</span>;
}
