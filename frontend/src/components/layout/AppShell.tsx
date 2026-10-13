import { LogOut, Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { msSinceActivity } from "../../lib/api";
import { initials } from "../../lib/format";
import { navByRole } from "../../lib/nav";
import { useSession } from "../../lib/session";
import { roleMeta } from "../../lib/types";
import { Button } from "../ui/Button";
import { Mark } from "../ui/Mark";
import { Banner } from "../ui/States";
import { ThemeToggle } from "../ui/ThemeToggle";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { role, user, signOut, refresh, idleMinutes } = useSession();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  // The server enforces the idle timeout (sessions live in Redis). This mirrors it so the user gets a warning and a chance
  // to stay signed in: only a request to the server extends the session.
  useEffect(() => {
    const idleMs = idleMinutes * 60_000;
    const t = setInterval(() => {
      const left = idleMs - msSinceActivity();
      if (left <= 0) {
        void signOut(`You were signed out after ${idleMinutes} minutes of inactivity.`).then(() => navigate("/"));
      } else setSecondsLeft(left <= 60_000 ? Math.ceil(left / 1000) : null);
    }, 1000);
    return () => clearInterval(t);
  }, [idleMinutes, signOut, navigate]);

  if (!role || !user) return null;

  const items = navByRole[role];
  const meta = roleMeta(role);

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  const navLinks = (compact: boolean) =>
    items.map((item) => (
      <NavLink
        key={item.path}
        to={item.path}
        end={item.end}
        onClick={() => setMobileOpen(false)}
        className={({ isActive }) =>
          `flex items-center gap-3 ${compact ? "h-11 text-sm" : "h-10 text-[13.5px]"} px-3 rounded-[var(--radius-sm)] font-medium transition-colors border-l-2 ${
            isActive ? "bg-[var(--nav-active-bg)] border-[var(--nav-active-border)] text-white" : "border-transparent text-[var(--nav-text-muted)] hover:bg-white/5 hover:text-white"
          }`
        }
      >
        <item.icon size={compact ? 17 : 16} strokeWidth={2} aria-hidden />
        {item.label}
      </NavLink>
    ));

  return (
    <div className="min-h-dvh flex bg-[var(--surface-bg)]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[80] focus:bg-[var(--surface-2)] focus:px-3 focus:py-2 focus:rounded-[var(--radius-sm)]">
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside className="hidden md:flex md:w-64 md:flex-col shrink-0 bg-[var(--nav-bg)] text-[var(--nav-text)] sticky top-0 h-dvh">
        <div className="flex items-center gap-2.5 h-16 px-5 border-b border-white/10 shrink-0">
          <Mark size={30} />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold leading-tight truncate">NFSU Placement</p>
            <p className="text-[11px] text-[var(--nav-text-muted)] leading-tight truncate">{meta.shortLabel}</p>
          </div>
        </div>
        <nav aria-label="Main" className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
          {navLinks(false)}
        </nav>
        <div className="px-3 pb-4 pt-2 border-t border-white/10 shrink-0">
          <button
            onClick={handleSignOut}
            className="flex items-center gap-3 h-10 px-3 w-full rounded-[var(--radius-sm)] text-[13.5px] font-medium text-[var(--nav-text-muted)] hover:bg-white/5 hover:text-white transition-colors"
          >
            <LogOut size={16} strokeWidth={2} aria-hidden />
            Sign out
          </button>
        </div>
      </aside>

      {/* Mobile nav overlay */}
      {mobileOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} aria-hidden />
          <div className="relative w-72 max-w-[82vw] h-full bg-[var(--nav-bg)] text-[var(--nav-text)] flex flex-col">
            <div className="flex items-center justify-between h-16 px-5 border-b border-white/10">
              <div className="flex items-center gap-2.5">
                <Mark size={28} />
                <span className="text-[13px] font-semibold">NFSU Placement</span>
              </div>
              <button onClick={() => setMobileOpen(false)} aria-label="Close navigation" className="h-9 w-9 inline-flex items-center justify-center rounded-[var(--radius-sm)] hover:bg-white/10">
                <X size={18} aria-hidden />
              </button>
            </div>
            <nav aria-label="Main" className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
              {navLinks(true)}
            </nav>
            <div className="px-3 pb-4 pt-2 border-t border-white/10">
              <button onClick={handleSignOut} className="flex items-center gap-3 h-11 px-3 w-full rounded-[var(--radius-sm)] text-sm font-medium text-[var(--nav-text-muted)]">
                <LogOut size={17} strokeWidth={2} aria-hidden />
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main column */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-16 shrink-0 flex items-center justify-between gap-4 px-4 md:px-8 border-b border-[var(--surface-border)] bg-[var(--surface-bg)]">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
              className="md:hidden h-9 w-9 inline-flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-secondary)] hover:bg-[var(--surface-1)]"
            >
              <Menu size={19} aria-hidden />
            </button>
            <h1 className="text-[15px] font-semibold text-[var(--text-primary)] truncate">{meta.label}</h1>
          </div>
          <div className="flex items-center gap-4">
            <ThemeToggle />
            <div className="hidden sm:flex items-center gap-2.5 pl-4 border-l border-[var(--surface-border)]">
              <div className="text-right min-w-0">
                <p className="text-[13px] font-medium text-[var(--text-primary)] leading-tight truncate max-w-48">{user.name.replace(/\s*\(.*?\)\s*/g, "")}</p>
                <p className="text-[11px] text-[var(--text-tertiary)] leading-tight truncate max-w-48">{user.email}</p>
              </div>
              <div className="h-8 w-8 rounded-full bg-[var(--brand-primary)] text-[var(--text-on-brand)] flex items-center justify-center text-[11px] font-semibold" aria-hidden>
                {initials(user.name)}
              </div>
            </div>
          </div>
        </header>
        {secondsLeft !== null && (
          <div className="px-4 md:px-8 pt-4">
            <Banner
              tone="warn"
              action={
                <Button size="sm" variant="secondary" onClick={() => void refresh()}>
                  Stay signed in
                </Button>
              }
            >
              You will be signed out in {secondsLeft}s because of inactivity.
            </Banner>
          </div>
        )}
        <main id="main" tabIndex={-1} className="flex-1 min-w-0 px-4 md:px-8 py-6 md:py-8 outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}
