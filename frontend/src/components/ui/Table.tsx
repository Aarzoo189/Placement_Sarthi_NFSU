import type { ReactNode } from "react";

/** Data table in the same visual language as the student dashboard (small caps header, hairline rows). */
export function Table({ children, caption }: { children: ReactNode; caption?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export function THead({ cols }: { cols: (string | { label: string; className?: string })[] }) {
  return (
    <thead>
      <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--text-tertiary)] border-b border-[var(--surface-border)]">
        {cols.map((c, i) => {
          const o = typeof c === "string" ? { label: c, className: "" } : { className: "", ...c };
          return (
            <th key={i} scope="col" className={`font-medium px-4 py-2.5 whitespace-nowrap ${o.className}`}>
              {o.label}
            </th>
          );
        })}
      </tr>
    </thead>
  );
}

export const Tr = ({ children, className = "" }: { children: ReactNode; className?: string }) => (
  <tr className={`border-b border-[var(--surface-border)] last:border-0 ${className}`}>{children}</tr>
);

export const Td = ({ children, className = "", colSpan }: { children?: ReactNode; className?: string; colSpan?: number }) => (
  <td colSpan={colSpan} className={`px-4 py-3 align-top ${className}`}>
    {children}
  </td>
);
