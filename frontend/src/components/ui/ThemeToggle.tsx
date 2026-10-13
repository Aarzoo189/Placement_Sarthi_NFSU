import { Moon, Sun } from "lucide-react";
import { useTheme } from "../../lib/theme";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-pressed={isDark}
      className="relative inline-flex h-8 w-14 shrink-0 items-center rounded-full border border-[var(--surface-border-strong)] bg-[var(--surface-1)] transition-colors"
    >
      <span
        className={`absolute left-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--surface-2)] shadow-sm transition-transform duration-200 ${
          isDark ? "translate-x-6" : "translate-x-0"
        }`}
      >
        {isDark ? <Moon size={13} strokeWidth={2.25} className="text-[var(--brand-gold)]" /> : <Sun size={13} strokeWidth={2.25} className="text-[var(--brand-primary)]" />}
      </span>
    </button>
  );
}
