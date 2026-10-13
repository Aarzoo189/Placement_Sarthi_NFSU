import { forwardRef, type ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const base =
  "inline-flex items-center justify-center gap-2 font-medium transition-colors duration-150 rounded-[var(--radius-sm)] disabled:opacity-50 disabled:pointer-events-none active:translate-y-px whitespace-nowrap";

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px]",
  md: "h-10 px-4 text-sm",
};

const variants: Record<Variant, string> = {
  primary:
    "bg-[var(--brand-primary)] text-[var(--text-on-brand)] hover:bg-[var(--brand-primary-hover)] shadow-sm",
  secondary:
    "bg-transparent text-[var(--text-primary)] border border-[var(--surface-border-strong)] hover:bg-[var(--surface-1)]",
  ghost:
    "bg-transparent text-[var(--text-secondary)] hover:bg-[var(--surface-1)] hover:text-[var(--text-primary)]",
  danger:
    "bg-transparent text-[var(--status-block-text)] border border-[var(--status-block-text)]/30 hover:bg-[var(--status-block-bg)]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className = "", variant = "primary", size = "md", children, ...rest },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";
