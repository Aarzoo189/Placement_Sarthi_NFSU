import { AlertTriangle, CheckCircle2, Info, Inbox, Loader2 } from "lucide-react";
import type { ReactNode } from "react";

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 text-[13px] text-[var(--text-secondary)] py-6 justify-center">
      <Loader2 size={16} className="animate-spin" aria-hidden />
      {label}…
    </div>
  );
}

export function EmptyState({ title, children, icon: Icon = Inbox }: { title: string; children?: ReactNode; icon?: typeof Inbox }) {
  return (
    <div className="flex flex-col items-center text-center px-6 py-10">
      <Icon size={22} className="text-[var(--text-tertiary)]" aria-hidden />
      <p className="mt-2.5 text-sm font-medium text-[var(--text-primary)]">{title}</p>
      {children && <p className="mt-1 text-[13px] text-[var(--text-secondary)] max-w-sm">{children}</p>}
    </div>
  );
}

type Tone = "error" | "info" | "success" | "warn";
const tones: Record<Tone, { icon: typeof Info; box: string }> = {
  error: { icon: AlertTriangle, box: "bg-[var(--status-block-bg)] text-[var(--status-block-text)]" },
  warn: { icon: AlertTriangle, box: "bg-[var(--status-review-bg)] text-[var(--status-review-text)]" },
  info: { icon: Info, box: "bg-[var(--surface-1)] text-[var(--text-secondary)] border border-[var(--surface-border)]" },
  success: { icon: CheckCircle2, box: "bg-[var(--status-allow-bg)] text-[var(--status-allow-text)]" },
};

export function Banner({ tone = "info", children, action }: { tone?: Tone; children: ReactNode; action?: ReactNode }) {
  const t = tones[tone];
  const Icon = t.icon;
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`flex items-start gap-2.5 rounded-[var(--radius-sm)] px-3.5 py-2.5 text-[13px] ${t.box}`}>
      <Icon size={16} className="shrink-0 mt-0.5" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

export const ErrorBanner = ({ error }: { error: string | null }) => (error ? <Banner tone="error">{error}</Banner> : null);
