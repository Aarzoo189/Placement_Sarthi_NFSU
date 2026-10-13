import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">{title}</h2>
        {subtitle && <p className="mt-1 text-[13.5px] text-[var(--text-secondary)] max-w-2xl">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
    </div>
  );
}

export const Page = ({ children }: { children: ReactNode }) => <div className="max-w-6xl mx-auto space-y-6">{children}</div>;
