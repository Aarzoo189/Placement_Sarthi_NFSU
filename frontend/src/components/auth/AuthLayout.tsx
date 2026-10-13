import { ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Mark } from "../ui/Mark";
import { ThemeToggle } from "../ui/ThemeToggle";

/** The two-panel sign-in frame (institutional panel + form panel). Used by sign-in, MFA, enrolment and account activation. */
export function AuthLayout({ children, title, subtitle }: { children: ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="min-h-dvh grid md:grid-cols-[1fr_1fr] bg-[var(--surface-bg)]">
      <div className="hidden md:flex flex-col justify-between bg-[var(--nav-bg)] text-[var(--nav-text)] px-12 py-10 relative overflow-hidden">
        <div className="dot-grid pointer-events-none absolute inset-0 opacity-[0.07]" aria-hidden />
        <div className="relative flex items-center gap-3">
          <Mark size={38} />
          <div>
            <p className="text-[15px] font-semibold tracking-tight">National Forensic Sciences University</p>
            <p className="text-[12px] text-[var(--nav-text-muted)]">Placement Management Portal</p>
          </div>
        </div>
        <div className="relative max-w-sm">
          <p className="text-2xl font-serif leading-snug text-[var(--color-cream-100)]">Where forensic science, security research, and industry placement meet.</p>
          <p className="mt-4 text-[13px] text-[var(--nav-text-muted)] leading-relaxed">
            One portal for students, coordinators, placement officers and recruiting partners across every campus.
          </p>
        </div>
        <div className="relative flex items-center gap-2 text-[12px] text-[var(--nav-text-muted)]">
          <ShieldCheck size={14} aria-hidden />
          Password and a second factor for every role. All activity is policy-governed and logged.
        </div>
      </div>

      <div className="flex flex-col px-6 py-8 md:px-16 md:py-10">
        <div className="flex items-center justify-between md:justify-end">
          <div className="md:hidden flex items-center gap-2">
            <Mark size={28} />
            <span className="text-sm font-semibold text-[var(--text-primary)]">NFSU Placement</span>
          </div>
          <ThemeToggle />
        </div>
        <div className="flex-1 flex flex-col justify-center max-w-sm w-full mx-auto py-8">
          <h1 className="text-xl font-semibold text-[var(--text-primary)]">{title}</h1>
          {subtitle && <p className="mt-1.5 text-sm text-[var(--text-secondary)]">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  );
}
