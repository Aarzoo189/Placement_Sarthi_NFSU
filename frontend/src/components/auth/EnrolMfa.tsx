import { startRegistration } from "@simplewebauthn/browser";
import { Copy, Download, KeyRound, Smartphone } from "lucide-react";
import { useState } from "react";
import { errorMessage, post, setCsrf } from "../../lib/api";
import type { AuthPayload } from "../../lib/session";
import { Button } from "../ui/Button";
import { TextField } from "../ui/Field";
import { Banner } from "../ui/States";

interface EnrolResult extends AuthPayload {
  complete: boolean;
  recovery_codes?: string[];
}
interface TotpStart {
  qr_data_url: string;
  secret: string;
  otpauth_url: string;
}

/**
 * Register a second factor. Before the first sign-in this is mandatory ("must enrol MFA before seeing any data");
 * later it is also used to add another factor from the security page.
 */
export function EnrolMfa({
  allowed,
  minPasskeys,
  passkeys,
  onDone,
  onProgress,
  firstTime,
}: {
  allowed: string[];
  minPasskeys: number;
  passkeys: number;
  /** Called when enrolment is complete (after recovery codes are acknowledged). */
  onDone: (p: AuthPayload) => void;
  /** Called after a factor was added but more are required (e.g. the second hardware key). */
  onProgress?: (p: AuthPayload) => void;
  firstTime: boolean;
}) {
  const [tab, setTab] = useState(allowed.includes("totp") ? "totp" : (allowed[0] ?? "totp"));
  const [totp, setTotp] = useState<TotpStart | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [codes, setCodes] = useState<{ list: string[]; next: AuthPayload } | null>(null);

  function finished(r: EnrolResult) {
    setCsrf(r.csrf); // the session id was rotated; keep the new CSRF token before anything else happens
    if (r.recovery_codes?.length) setCodes({ list: r.recovery_codes, next: r });
    else if (r.complete) onDone(r);
    else {
      setNotice(`Key registered. ${Math.max(minPasskeys - (passkeys + 1), 0)} more required.`);
      onProgress?.(r);
    }
  }

  async function startTotp() {
    setBusy(true);
    setError(null);
    try {
      setTotp(await post<TotpStart>("/auth/enrol/totp/start"));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmTotp() {
    setBusy(true);
    setError(null);
    try {
      finished(await post<EnrolResult>("/auth/enrol/totp/confirm", { code: code.trim() }));
      setCode("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function addPasskey() {
    setBusy(true);
    setError(null);
    try {
      const optionsJSON = await post<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/auth/enrol/passkey/options");
      const response = await startRegistration({ optionsJSON });
      finished(await post<EnrolResult>("/auth/enrol/passkey/verify", { response, label: "Passkey" }));
    } catch (e) {
      if (e instanceof Error && e.name === "NotAllowedError") setError("The passkey prompt was cancelled or timed out.");
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (codes) {
    const text = codes.list.join("\n");
    return (
      <div className="space-y-4">
        <Banner tone="warn">
          <strong>Save these recovery codes now.</strong> Each works once if you lose your authenticator. They are shown only this one time and cannot be retrieved later.
        </Banner>
        <ul className="grid grid-cols-2 gap-2 font-mono text-[13px] tabular rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--surface-1)] p-3">
          {codes.list.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" type="button" onClick={() => void navigator.clipboard?.writeText(text)}>
            <Copy size={14} aria-hidden /> Copy
          </Button>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={() => {
              const url = URL.createObjectURL(new Blob([`NFSU Placement Portal recovery codes\n\n${text}\n`], { type: "text/plain" }));
              const a = document.createElement("a");
              a.href = url;
              a.download = "nfsu-recovery-codes.txt";
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            <Download size={14} aria-hidden /> Download
          </Button>
        </div>
        <Button className="w-full" onClick={() => onDone(codes.next)}>
          I have saved them — continue
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {firstTime && <Banner tone="info">Multi-factor authentication is required for every role. You will not see any data until it is set up.</Banner>}
      {allowed.length > 1 && (
        <div className="flex gap-1.5" role="tablist" aria-label="Method">
          {allowed.map((m) => (
            <button
              key={m}
              role="tab"
              type="button"
              aria-selected={tab === m}
              onClick={() => {
                setTab(m);
                setError(null);
              }}
              className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[var(--radius-sm)] text-[12.5px] font-medium border ${
                tab === m ? "bg-[var(--brand-primary)] text-[var(--text-on-brand)] border-transparent" : "border-[var(--surface-border-strong)] text-[var(--text-secondary)] hover:bg-[var(--surface-1)]"
              }`}
            >
              {m === "passkey" ? <KeyRound size={13} aria-hidden /> : <Smartphone size={13} aria-hidden />}
              {m === "passkey" ? "Passkey / security key" : "Authenticator app"}
            </button>
          ))}
        </div>
      )}
      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner tone="success">{notice}</Banner>}

      {tab === "totp" && (
        <div className="space-y-4">
          {!totp ? (
            <>
              <p className="text-[13px] text-[var(--text-secondary)]">
                Use an authenticator app (Google Authenticator, Microsoft Authenticator, Authy, 1Password…). You will scan a QR code, then enter the 6-digit code it shows.
              </p>
              <Button className="w-full" onClick={startTotp} disabled={busy}>
                {busy ? "Preparing…" : "Set up authenticator app"}
              </Button>
            </>
          ) : (
            <>
              <p className="text-[13px] text-[var(--text-secondary)]">1. Scan this QR code with your authenticator app.</p>
              <img src={totp.qr_data_url} alt="QR code for your authenticator app" width={192} height={192} className="mx-auto rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-white p-1" />
              <details className="text-[12.5px] text-[var(--text-secondary)]">
                <summary className="cursor-pointer">Can't scan? Enter the key manually</summary>
                <p className="mt-2 font-mono break-all tabular text-[var(--text-primary)]">{totp.secret}</p>
              </details>
              <p className="text-[13px] text-[var(--text-secondary)]">2. Enter the 6-digit code to confirm.</p>
              <TextField label="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123456" className="tabular tracking-widest" />
              <Button className="w-full" onClick={confirmTotp} disabled={busy || code.trim().length < 6}>
                {busy ? "Checking…" : "Confirm and continue"}
              </Button>
            </>
          )}
        </div>
      )}

      {tab === "passkey" && (
        <div className="space-y-4">
          <p className="text-[13px] text-[var(--text-secondary)]">
            Passkeys cannot be phished. Use your device (fingerprint, face, PIN) or a hardware security key.
            {minPasskeys > 1 && ` This role requires ${minPasskeys} registered keys; you have ${passkeys}.`}
          </p>
          <Button className="w-full" onClick={addPasskey} disabled={busy}>
            <KeyRound size={15} aria-hidden />
            {busy ? "Waiting for your device…" : "Register a passkey"}
          </Button>
        </div>
      )}
    </div>
  );
}
