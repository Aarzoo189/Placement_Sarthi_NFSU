import type { ReactNode } from "react";

export interface TabDef<T extends string> {
  id: T;
  label: string;
  count?: number;
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: TabDef<T>[]; value: T; onChange: (t: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 border-b border-[var(--surface-border)] overflow-x-auto">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={`h-10 px-3.5 text-[13.5px] font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
            value === t.id ? "border-[var(--brand-gold)] text-[var(--text-primary)]" : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          }`}
        >
          {t.label}
          {t.count !== undefined && t.count > 0 && (
            <span className="ml-1.5 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-[var(--status-review-bg)] text-[var(--status-review-text)] text-[11px] tabular">{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export const TabPanel = ({ children }: { children: ReactNode }) => <div role="tabpanel" className="pt-5">{children}</div>;
