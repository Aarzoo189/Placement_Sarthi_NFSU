import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { registerHooks } from "../../lib/api";
import { useSession } from "../../lib/session";
import { Modal } from "../ui/Modal";
import { SecondFactor } from "./SecondFactor";

/**
 * Sensitive actions (accepting an offer, exporting, approving an exception, bulk import, ...) need a FRESH second factor.
 * When the server answers 401 STEP_UP_REQUIRED the API client calls this provider, which asks the user and then lets the
 * client retry the original request. The user never loses what they were doing.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  const { mfa, apply } = useSession();
  const [open, setOpen] = useState(false);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  const finish = useCallback((ok: boolean) => {
    setOpen(false);
    pending.current?.(ok);
    pending.current = null;
  }, []);

  useEffect(() => {
    registerHooks({
      stepUp: () =>
        new Promise<boolean>((resolve) => {
          pending.current?.(false);
          pending.current = resolve;
          setOpen(true);
        }),
    });
  }, []);

  return (
    <>
      {children}
      <Modal open={open} onClose={() => finish(false)} title="Confirm it is you" description="This action needs a fresh second-factor check." size="sm">
        {mfa ? (
          <SecondFactor
            methods={mfa.methods}
            primary={mfa.primary}
            submitLabel="Confirm"
            onVerified={(p) => {
              apply(p);
              finish(true);
            }}
          />
        ) : (
          <p className="text-sm text-[var(--text-secondary)]">Your session needs to be refreshed. Sign in again.</p>
        )}
      </Modal>
    </>
  );
}
