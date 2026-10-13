import { startAuthentication } from "@simplewebauthn/browser";
import { KeyRound, Mail, ShieldCheck, Smartphone } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ApiError, errorMessage, post } from "../../lib/api";
import type { AuthPayload } from "../../lib/session";
import { Button } from "../ui/Button";
import { Checkbox, TextField } from "../ui/Field";
import { Banner } from "../ui/States";

const LABEL: Record<string, { label: string; icon: typeof Mail; help: string }> = {
  passkey: { label: "Passkey or security key", icon: KeyRound, help: "Use your fingerprint, face, device PIN or hardware key." },
  totp: { label: "Authenticator app", icon: Smartphone, help: "Enter the 6-digit code from your authenticator app." },
  email: { label: "E-mail code", icon: Mail, help: "We will e-mail you a 6-digit code that works once for 5 minutes." },
  recovery: { label: "Recovery code", icon: ShieldCheck, help: "Use one of the single-use recovery codes you saved when you set up MFA." },
};

/**
 * The second-factor prompt, used for sign-in and for step-up (re-confirming before a sensitive action).
 * Which methods appear is decided by the server for this role; the browser only renders them.
 */
export function SecondFactor({
  methods,
  primary,
  onVerified,
  allowRemember = false,
  submitLabel = "Verify",
}: {
  methods: string[];
  primary?: string;
  onVerified: (p: AuthPayload) => void;
  allowRemember?: boolean;
  submitLabel?: string;
}) {
  const ordered = [...methods].sort((a, b) => (a === primary ? -1 : b === primary ? 1 : 0));
  const [method, setMethod] = useState(ordered[0] ?? "totp");
  const [code, setCode] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const meta = LABEL[method] ?? LABEL.totp!;

  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.code === "LOCKED") setError(e.message);
    else setError(errorMessage(e));
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await post<AuthPayload>("/auth/mfa/verify", { method, code: code.trim(), ...(allowRemember ? { remember_device: remember } : {}) });
      onVerified(p);
    } catch (err) {
      fail(err);
      setCode("");
    } finally {
      setBusy(false);
    }
  }

  async function usePasskey() {
    setBusy(true);
    setError(null);
    try {
      const optionsJSON = await post<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/auth/mfa/passkey/options");
      const response = await startAuthentication({ optionsJSON });
      onVerified(await post<AuthPayload>("/auth/mfa/passkey/verify", { response }));
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") setError("The passkey prompt was cancelled or timed out.");
      else fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function sendEmail() {
    setBusy(true);
    setError(null);
    try {
      await post("/auth/mfa/email/send");
      setSent(true);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  if (!ordered.length) return <Banner tone="error">No second factor is available for this account. Ask an administrator to reset your MFA.</Banner>;

  return (
    <div className="space-y-4">
      {ordered.length > 1 && (
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Verification method">
          {ordered.map((m) => {
            const L = LABEL[m] ?? LABEL.totp!;
            return (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={method === m}
                onClick={() => {
                  setMethod(m);
                  setError(null);
                  setCode("");
                }}
                className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[var(--radius-sm)] text-[12.5px] font-medium border ${
                  method === m ? "bg-[var(--brand-primary)] text-[var(--text-on-brand)] border-transparent" : "border-[var(--surface-border-strong)] text-[var(--text-secondary)] hover:bg-[var(--surface-1)]"
                }`}
              >
                <L.icon size={13} aria-hidden />
                {L.label}
              </button>
            );
          })}
        </div>
      )}

      <p className="text-[13px] text-[var(--text-secondary)]">{meta.help}</p>
      {error && <Banner tone="error">{error}</Banner>}

      {method === "passkey" ? (
        <Button type="button" className="w-full" onClick={usePasskey} disabled={busy}>
          <KeyRound size={15} aria-hidden />
          {busy ? "Waiting for your device…" : "Use passkey"}
        </Button>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {method === "email" && !sent && (
            <Button type="button" variant="secondary" className="w-full" onClick={sendEmail} disabled={busy}>
              <Mail size={15} aria-hidden />
              Send me a code
            </Button>
          )}
          {(method !== "email" || sent) && (
            <>
              {method === "email" && sent && <Banner tone="success">Code sent. Check your inbox (it can take a moment).</Banner>}
              <TextField
                label={method === "recovery" ? "Recovery code" : "6-digit code"}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode={method === "recovery" ? "text" : "numeric"}
                autoComplete="one-time-code"
                autoFocus
                placeholder={method === "recovery" ? "xxxxx-xxxxx" : "123456"}
                maxLength={method === "recovery" ? 11 : 7}
                className="tabular tracking-widest"
              />
              {allowRemember && <Checkbox label="Remember this device for 30 days" checked={remember} onChange={(e) => setRemember(e.target.checked)} />}
              <Button type="submit" className="w-full" disabled={busy || code.trim().length < 6}>
                {busy ? "Checking…" : submitLabel}
              </Button>
              {method === "email" && (
                <button type="button" onClick={sendEmail} disabled={busy} className="text-[12.5px] text-[var(--brand-primary)] hover:underline">
                  Send a new code
                </button>
              )}
            </>
          )}
        </form>
      )}
    </div>
  );
}
