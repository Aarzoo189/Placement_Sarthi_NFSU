import type { HTMLAttributes } from "react";

export function Card({
  className = "",
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`bg-[var(--surface-2)] border border-[var(--surface-border)] rounded-[var(--radius-md)] ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 border-b border-[var(--surface-border)]">
      <div>
        <h3 className="text-[13px] font-semibold tracking-wide uppercase text-[var(--text-secondary)]">
          {title}
        </h3>
        {subtitle && (
          <p className="mt-0.5 text-sm text-[var(--text-tertiary)]">
            {subtitle}
          </p>
        )}
      </div>
      {action}
    </div>
  );
}
