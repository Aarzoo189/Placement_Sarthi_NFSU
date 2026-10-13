import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, registerHooks, setCsrf } from "./api";
import { SERVER_ROLE, type Role, type ServerRole } from "./types";

export type Stage = "loading" | "anonymous" | "mfa_pending" | "enrol_pending" | "full";

export interface AuthPayload {
  stage: "mfa_pending" | "enrol_pending" | "full";
  csrf: string;
  user: { id: string; email: string; name: string; role: ServerRole; programme_ids: string[]; company_id: string | null };
  step_up_fresh: boolean;
  session: { idle_minutes: number; expires_at: number };
  mfa?: { methods: string[]; primary: string };
  enrol?: { allowed: string[]; min_passkeys: number; passkeys: number; totp: boolean; activated: boolean };
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  programmeIds: string[];
  companyId: string | null;
}

interface SessionValue {
  stage: Stage;
  user: SessionUser | null;
  role: Role | null;
  mfa: AuthPayload["mfa"] | null;
  enrol: AuthPayload["enrol"] | null;
  idleMinutes: number;
  expiresAt: number | null;
  /** Message to show on the sign-in screen (inactivity, revoked session, unsupported role). */
  notice: string | null;
  clearNotice: () => void;
  /** Apply a response from /auth/login, /auth/mfa/verify, /auth/enrol/*, /auth/activate or /auth/me. */
  apply: (p: AuthPayload) => void;
  refresh: () => Promise<void>;
  signOut: (notice?: string) => Promise<void>;
}

const Ctx = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState<Stage>("loading");
  const [payload, setPayload] = useState<AuthPayload | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const booted = useRef(false);

  const reset = useCallback((n?: string) => {
    setCsrf(null);
    setPayload(null);
    setStage("anonymous");
    if (n) setNotice(n);
  }, []);

  const apply = useCallback(
    (p: AuthPayload) => {
      // The Placement Administrator role is not part of this portal: refuse it here rather than show a half-working UI.
      if (!SERVER_ROLE[p.user.role]) {
        void api("POST", "/auth/logout", {}, { quiet: true }).catch(() => undefined);
        reset("This account has the Placement Administrator role, which is not available in this portal. Contact the Placement Cell.");
        return;
      }
      setCsrf(p.csrf);
      setPayload(p);
      setStage(p.stage);
    },
    [reset],
  );

  const refresh = useCallback(async () => {
    try {
      apply(await api<AuthPayload>("GET", "/auth/me", undefined, { quiet: true }));
    } catch {
      reset();
    }
  }, [apply, reset]);

  const signOut = useCallback(
    async (n?: string) => {
      try {
        await api("POST", "/auth/logout", {}, { quiet: true });
      } catch {
        /* the cookie is cleared server-side when it can be; the UI state is reset either way */
      }
      reset(n);
    },
    [reset],
  );

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    registerHooks({
      sessionLost: () => reset("Your session has ended. Please sign in again."),
      stage: () => void refresh(),
    });
    void refresh();
  }, [refresh, reset]);

  const value = useMemo<SessionValue>(() => {
    const role = payload ? (SERVER_ROLE[payload.user.role] ?? null) : null;
    return {
      stage,
      user: payload && role ? { id: payload.user.id, email: payload.user.email, name: payload.user.name, role, programmeIds: payload.user.programme_ids, companyId: payload.user.company_id } : null,
      role,
      mfa: payload?.mfa ?? null,
      enrol: payload?.enrol ?? null,
      idleMinutes: payload?.session.idle_minutes ?? 15,
      expiresAt: payload?.session.expires_at ?? null,
      notice,
      clearNotice: () => setNotice(null),
      apply,
      refresh,
      signOut,
    };
  }, [stage, payload, notice, apply, refresh, signOut]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSession() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession must be used within SessionProvider");
  return ctx;
}
