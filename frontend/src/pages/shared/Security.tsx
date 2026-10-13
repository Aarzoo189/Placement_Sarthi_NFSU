import { zodResolver } from "@hookform/resolvers/zod";
import { KeyRound, LogOut, Smartphone } from "lucide-react";
import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { EnrolMfa } from "../../components/auth/EnrolMfa";
import { StatusPill } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { SelectField, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Page, PageHeader } from "../../components/ui/PageHeader";
import { Banner, ErrorBanner, Spinner } from "../../components/ui/States";
import { useToast } from "../../components/ui/Toast";
import { ApiError, errorMessage, post, upload } from "../../lib/api";
import { fmtDate } from "../../lib/format";
import type { StudentRow } from "../../lib/models";
import { useSession, type AuthPayload } from "../../lib/session";
import { roleMeta } from "../../lib/types";
import { useAction, useApi } from "../../lib/use-api";

interface Factors {
  factors: { id: string; type: string; label: string | null; created_at: string }[];
  recovery_codes_left: number;
}

const pwSchema = z
  .object({ current_password: z.string().min(1, "Enter your current password."), new_password: z.string().min(12, "Use at least 12 characters.").max(128), confirm: z.string() })
  .refine((v) => v.new_password === v.confirm, { path: ["confirm"], message: "The two passwords do not match." });

/** Profile & security: factors, recovery codes, password, sessions, and (students) contact details and resume. */
export function Security() {
  const { user, role, apply, signOut, enrol } = useSession();
  const toast = useToast();
  const factors = useApi<Factors>("/auth/factors");
  const [addOpen, setAddOpen] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const act = useAction();
  if (!user || !role) return null;

  const allowed = (enrol?.allowed?.length ? enrol.allowed : role === "coordinator" || role === "placement_officer" ? ["passkey", "totp"] : role === "super_admin" ? ["passkey", "totp"] : ["totp"]).filter((a) => a === "totp" || a === "passkey");

  async function regenerate() {
    const r = await act.run(() => post<{ recovery_codes: string[] }>("/auth/recovery-codes/regenerate"));
    if (r) {
      setCodes(r.recovery_codes);
      await factors.reload();
    }
  }

  async function logoutAll() {
    await act.run(async () => {
      await post("/auth/logout-all");
    });
    await signOut("You were signed out of all devices.");
  }

  return (
    <Page>
      <PageHeader title="Profile & security" subtitle="Your account, second factors, password and sessions." />

      <Card>
        <CardHeader title="Account" />
        <dl className="grid sm:grid-cols-3 gap-4 p-5 text-sm">
          <div><dt className="text-[12px] text-[var(--text-tertiary)]">Name</dt><dd className="mt-0.5 text-[var(--text-primary)]">{user.name}</dd></div>
          <div><dt className="text-[12px] text-[var(--text-tertiary)]">E-mail</dt><dd className="mt-0.5 text-[var(--text-primary)] break-all">{user.email}</dd></div>
          <div><dt className="text-[12px] text-[var(--text-tertiary)]">Role</dt><dd className="mt-0.5 text-[var(--text-primary)]">{roleMeta(role).label}</dd></div>
        </dl>
      </Card>

      {role === "student" && <StudentProfile />}

      <Card>
        <CardHeader
          title="Second factors"
          subtitle="Every role signs in with a password and a second factor."
          action={<Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}>Add a factor</Button>}
        />
        {factors.loading && !factors.data ? (
          <Spinner />
        ) : (
          <ul className="divide-y divide-[var(--surface-border)]">
            {(factors.data?.factors ?? []).map((f) => (
              <li key={f.id} className="px-5 py-3.5 flex items-center gap-3">
                {f.type === "passkey" ? <KeyRound size={16} className="text-[var(--text-tertiary)]" aria-hidden /> : <Smartphone size={16} className="text-[var(--text-tertiary)]" aria-hidden />}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-[var(--text-primary)]">{f.label ?? (f.type === "passkey" ? "Passkey" : "Authenticator app")}</p>
                  <p className="text-[12px] text-[var(--text-tertiary)]">Added {fmtDate(f.created_at)}</p>
                </div>
                <StatusPill value="active" />
              </li>
            ))}
          </ul>
        )}
        <div className="px-5 py-4 border-t border-[var(--surface-border)] flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">Recovery codes</p>
            <p className="text-[12.5px] text-[var(--text-secondary)]">{factors.data ? `${factors.data.recovery_codes_left} unused` : ""}. Use one if you lose your device. New codes replace all old ones.</p>
          </div>
          <Button size="sm" variant="secondary" onClick={() => void regenerate()} disabled={act.busy}>Generate new codes</Button>
        </div>
        <div className="px-5 pb-4"><ErrorBanner error={act.error} /></div>
      </Card>

      <ChangePassword onDone={(p) => { apply(p); toast.success("Password changed. Your other sessions were signed out."); }} />

      <Card>
        <CardHeader title="Sessions" subtitle="Sessions are held on the server, so signing out here really ends them." />
        <div className="p-5 flex items-center justify-between gap-3 flex-wrap">
          <p className="text-[13px] text-[var(--text-secondary)]">If you used a shared computer or suspect someone else has your password, end every session now.</p>
          <Button variant="danger" size="sm" onClick={() => void logoutAll()}><LogOut size={14} aria-hidden /> Sign out of all devices</Button>
        </div>
      </Card>

      <Modal open={addOpen} onClose={() => { setAddOpen(false); void factors.reload(); }} title="Add a second factor" description="You will be asked to confirm with your current factor first." size="md">
        <EnrolMfa
          allowed={allowed}
          minPasskeys={enrol?.min_passkeys ?? 0}
          passkeys={enrol?.passkeys ?? 0}
          firstTime={false}
          onDone={(p) => { apply(p); setAddOpen(false); toast.success("Second factor added."); void factors.reload(); }}
          onProgress={() => void factors.reload()}
        />
      </Modal>

      <Modal open={!!codes} onClose={() => setCodes(null)} title="Your new recovery codes" size="sm" footer={<Button onClick={() => setCodes(null)}>I have saved them</Button>}>
        <Banner tone="warn">Shown only once. Store them somewhere safe.</Banner>
        <ul className="mt-3 grid grid-cols-2 gap-2 font-mono text-[13px] tabular rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--surface-1)] p-3">
          {codes?.map((c) => <li key={c}>{c}</li>)}
        </ul>
      </Modal>
    </Page>
  );
}

function ChangePassword({ onDone }: { onDone: (p: AuthPayload) => void }) {
  const { register, handleSubmit, reset, formState } = useForm<z.infer<typeof pwSchema>>({ resolver: zodResolver(pwSchema), mode: "onTouched" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(v: z.infer<typeof pwSchema>) {
    setBusy(true);
    setError(null);
    try {
      onDone(await post<AuthPayload>("/auth/password/change", { current_password: v.current_password, new_password: v.new_password }));
      reset();
    } catch (e) {
      if (e instanceof ApiError && Array.isArray(e.body.reasons)) setError(`${e.message}: ${(e.body.reasons as string[]).join(" ")}`);
      else if (!(e instanceof ApiError && e.code === "STEP_UP_CANCELLED")) setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Change password" subtitle="At least 12 characters; common or breached passwords are refused. All other sessions end when you change it." />
      <form onSubmit={handleSubmit(submit)} noValidate className="p-5 grid sm:grid-cols-3 gap-4 items-start">
        <TextField label="Current password" type="password" autoComplete="current-password" error={formState.errors.current_password?.message} {...register("current_password")} />
        <TextField label="New password" type="password" autoComplete="new-password" error={formState.errors.new_password?.message} {...register("new_password")} />
        <TextField label="Confirm new password" type="password" autoComplete="new-password" error={formState.errors.confirm?.message} {...register("confirm")} />
        <div className="sm:col-span-3 space-y-3">
          <ErrorBanner error={error} />
          <Button type="submit" size="sm" disabled={busy}>{busy ? "Saving…" : "Change password"}</Button>
        </div>
      </form>
    </Card>
  );
}

/** Student-only: contact details (change = request, approved by the coordinator) and resume. */
function StudentProfile() {
  const me = useApi<StudentRow>("/students/me");
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<"mobile" | "email">("mobile");
  const [value, setValue] = useState("");
  const act = useAction();
  const file = useRef<HTMLInputElement>(null);

  async function request() {
    let ok = false;
    await act.run(async () => {
      await post("/students/me/contact-change", { field, value });
      ok = true;
    });
    if (ok) {
      toast.success("Request sent. Your coordinator will review it.");
      setOpen(false);
      setValue("");
    }
  }

  async function uploadResume(f: File | undefined) {
    if (!f) return;
    try {
      await upload("/students/me/resume", f);
      toast.success("Resume uploaded.");
      await me.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  const s = me.data;
  return (
    <Card>
      <CardHeader title="My details" subtitle="You cannot edit contact details yourself: changes are requested and approved by your coordinator." action={<Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Request a change</Button>} />
      {!s ? <Spinner /> : (
        <dl className="grid sm:grid-cols-3 gap-4 p-5 text-sm">
          <div><dt className="text-[12px] text-[var(--text-tertiary)]">Placement ID</dt><dd className="mt-0.5 text-[var(--text-primary)] tabular">{s.placement_id}</dd></div>
          <div><dt className="text-[12px] text-[var(--text-tertiary)]">Programme</dt><dd className="mt-0.5 text-[var(--text-primary)]">{s.programme_name ?? s.programme_code} · batch {s.batch}</dd></div>
          <div><dt className="text-[12px] text-[var(--text-tertiary)]">CGPA / backlogs</dt><dd className="mt-0.5 text-[var(--text-primary)] tabular">{s.cgpa} / {s.backlogs}</dd></div>
          <div><dt className="text-[12px] text-[var(--text-tertiary)]">Mobile</dt><dd className="mt-0.5 text-[var(--text-primary)] tabular">{s.mobile}</dd></div>
          <div><dt className="text-[12px] text-[var(--text-tertiary)]">Registration</dt><dd className="mt-0.5"><StatusPill value={s.registration_status ?? "pending"} /></dd></div>
          <div><dt className="text-[12px] text-[var(--text-tertiary)]">Eligibility</dt><dd className="mt-0.5"><StatusPill value={s.eligibility_status ?? "pending"} /></dd></div>
          <div className="sm:col-span-3 flex items-center gap-3 flex-wrap pt-2 border-t border-[var(--surface-border)]">
            <p className="text-[13px] text-[var(--text-secondary)]">Resume (PDF, up to 2 MB, visible to recruiters of drives you apply to): <strong>{s.has_resume ? "on file" : "none yet"}</strong></p>
            <input ref={file} type="file" accept="application/pdf" className="sr-only" aria-label="Upload resume PDF" onChange={(e) => { void uploadResume(e.target.files?.[0]); e.target.value = ""; }} />
            <Button size="sm" variant="secondary" onClick={() => file.current?.click()}>{s.has_resume ? "Replace resume" : "Upload resume"}</Button>
          </div>
        </dl>
      )}
      <Modal
        open={open}
        onClose={() => { setOpen(false); act.clearError(); }}
        title="Request a contact change"
        description="Your coordinator reviews it. You will confirm with your second factor first."
        size="sm"
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={act.busy || value.trim().length < 5} onClick={() => void request()}>{act.busy ? "Sending…" : "Send request"}</Button></>}
      >
        <div className="space-y-4">
          <SelectField label="What to change" value={field} onChange={(e) => setField(e.target.value as "mobile" | "email")}>
            <option value="mobile">Mobile number</option>
            <option value="email">E-mail address</option>
          </SelectField>
          <TextField label={field === "mobile" ? "New mobile number (10 digits)" : "New e-mail address"} value={value} onChange={(e) => setValue(e.target.value)} inputMode={field === "mobile" ? "tel" : "email"} />
          <ErrorBanner error={act.error} />
        </div>
      </Modal>
    </Card>
  );
}
