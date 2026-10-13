import { CheckCircle2, X, XCircle } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

interface ToastItem {
  id: number;
  tone: "success" | "error";
  text: string;
}
interface ToastApi {
  success: (t: string) => void;
  error: (t: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);
let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (tone: ToastItem["tone"], text: string) => {
      const id = ++seq;
      setItems((l) => [...l.slice(-3), { id, tone, text }]);
      setTimeout(() => dismiss(id), tone === "error" ? 8000 : 4500);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(() => ({ success: (t) => push("success", t), error: (t) => push("error", t) }), [push]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="fixed bottom-4 right-4 left-4 sm:left-auto z-[70] flex flex-col gap-2 sm:w-96" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className={`flex items-start gap-2.5 rounded-[var(--radius-md)] px-3.5 py-3 text-[13px] shadow-lg border ${
              t.tone === "success"
                ? "bg-[var(--status-allow-bg)] text-[var(--status-allow-text)] border-[var(--status-allow-text)]/20"
                : "bg-[var(--status-block-bg)] text-[var(--status-block-text)] border-[var(--status-block-text)]/20"
            }`}
          >
            {t.tone === "success" ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden /> : <XCircle size={16} className="mt-0.5 shrink-0" aria-hidden />}
            <p className="flex-1 min-w-0">{t.text}</p>
            <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">
              <X size={14} aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useToast must be used within ToastProvider");
  return c;
}
