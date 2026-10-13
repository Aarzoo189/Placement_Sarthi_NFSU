import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import type { PolicyDecision } from "../../lib/types";

const styles = {
  ALLOW: { icon: CheckCircle2, text: "text-[var(--status-allow-text)]", bg: "bg-[var(--status-allow-bg)]", label: "Allowed" },
  REVIEW: { icon: AlertTriangle, text: "text-[var(--status-review-text)]", bg: "bg-[var(--status-review-bg)]", label: "Needs review" },
  BLOCK: { icon: XCircle, text: "text-[var(--status-block-text)]", bg: "bg-[var(--status-block-bg)]", label: "Blocked" },
} as const;

/** Inline explanation of a policy-engine decision (ALLOW / BLOCK / REVIEW), with every rule that fired. */
export function PolicyExplain({ decision }: { decision: PolicyDecision }) {
  const s = styles[decision.outcome];
  const Icon = s.icon;
  return (
    <div className={`flex gap-2.5 rounded-[var(--radius-sm)] px-3 py-2.5 ${s.bg}`}>
      <Icon size={16} strokeWidth={2.25} className={`${s.text} shrink-0 mt-0.5`} aria-hidden />
      <div className="min-w-0">
        <p className={`text-[13px] font-medium ${s.text}`}>
          {s.label}: {decision.reason}
          {decision.ruleId && <span className="ml-1.5 font-mono text-[11px] opacity-80">({decision.ruleId})</span>}
        </p>
        {decision.detail && <p className="mt-0.5 text-[12.5px] text-[var(--text-secondary)]">{decision.detail}</p>}
        {decision.rules && decision.rules.length > 1 && (
          <ul className="mt-1.5 space-y-0.5 text-[12.5px] text-[var(--text-secondary)]">
            {decision.rules.map((r, i) => (
              <li key={i}>
                <span className="font-mono text-[11px] text-[var(--text-tertiary)]">{r.code}</span> {r.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
