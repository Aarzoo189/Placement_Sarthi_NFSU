import type { LucideIcon } from "lucide-react";

export function StatTile({
  label,
  value,
  icon: Icon,
  tone = "default",
  hint,
}: {
  label: string;
  value: string | number;
  icon: LucideIcon;
  tone?: "default" | "accent";
  hint?: string;
}) {
  return (
    <div className="flex items-center gap-3.5 px-4 py-3.5 rounded-[var(--radius-md)] border border-[var(--surface-border)] bg-[var(--surface-2)]">
      <div
        className={`h-9 w-9 shrink-0 rounded-[var(--radius-sm)] flex items-center justify-center ${
          tone === "accent" ? "bg-[var(--status-review-bg)] text-[var(--status-review-text)]" : "bg-[var(--surface-1)] text-[var(--brand-primary)]"
        }`}
      >
        <Icon size={17} strokeWidth={2} aria-hidden />
      </div>
      <div className="min-w-0">
        <p className="text-xl font-semibold tabular text-[var(--text-primary)] leading-tight break-words">{value}</p>
        <p className="mt-1 text-[12px] text-[var(--text-secondary)] leading-tight">{label}</p>
        {hint && <p className="mt-1 text-[11px] text-[var(--text-tertiary)] leading-tight">{hint}</p>}
      </div>
    </div>
  );
}
