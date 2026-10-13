import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Accessible modal: focus moves in, Escape closes, focus returns to the opener. */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  dismissable = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  dismissable?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>("input, select, textarea, button:not([data-close])");
    (first ?? panel.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissable) onClose();
      if (e.key === "Tab" && panel.current) {
        const f = [...panel.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex='-1'])")];
        if (!f.length) return;
        const a = f[0]!;
        const z = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          z.focus();
        } else if (!e.shiftKey && document.activeElement === z) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      opener?.focus?.();
    };
  }, [open, onClose, dismissable]);

  if (!open) return null;
  const width = size === "sm" ? "max-w-sm" : size === "lg" ? "max-w-3xl" : "max-w-lg";
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4" role="presentation">
      <div className="absolute inset-0 bg-black/50" onClick={dismissable ? onClose : undefined} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`relative w-full ${width} max-h-[92dvh] flex flex-col bg-[var(--surface-2)] border border-[var(--surface-border)] rounded-t-[var(--radius-lg)] sm:rounded-[var(--radius-lg)] shadow-xl outline-none`}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3 border-b border-[var(--surface-border)]">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">{title}</h2>
            {description && <p className="mt-0.5 text-[13px] text-[var(--text-secondary)]">{description}</p>}
          </div>
          {dismissable && (
            <button data-close onClick={onClose} aria-label="Close" className="h-8 w-8 shrink-0 inline-flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-tertiary)] hover:bg-[var(--surface-1)]">
              <X size={16} aria-hidden />
            </button>
          )}
        </div>
        <div className="px-5 py-4 overflow-y-auto">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-[var(--surface-border)] flex items-center justify-end gap-2 flex-wrap">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
