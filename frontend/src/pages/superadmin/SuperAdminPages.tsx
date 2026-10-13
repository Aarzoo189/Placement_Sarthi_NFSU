import { useState } from "react";
import { Badge, StatusPill } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { SelectField, TextAreaField, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Page, PageHeader } from "../../components/ui/PageHeader";
import { Banner, EmptyState, ErrorBanner, Spinner } from "../../components/ui/States";
import { Table, Td, THead, Tr } from "../../components/ui/Table";
import { useToast } from "../../components/ui/Toast";
import { errorMessage, post, put } from "../../lib/api";
import { fmtDate, fmtFullDateTime } from "../../lib/format";
import { useSession } from "../../lib/session";
import { useAction, useApi } from "../../lib/use-api";

interface UserRow { id: string; email: string; name: string; role: string; status: string; mfa_enrolled: boolean; last_login: string | null; programmes?: string[]; company?: string | null }

/**
 * Accounts the Super Admin may manage. The server decides which roles that is (it will refuse anything else), and a Super Admin's
 * MFA can only be reset by the OTHER Super Admin, never by themselves.
 */
export function AccountsPage() {
  const { user } = useSession();
  const toast = useToast();
  const list = useApi<UserRow[]>("/users");
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<{ u: UserRow; what: "mfa" | "status" } | null>(null);

  async function resend(u: UserRow) {
    try { await post(`/users/${u.id}/resend-activation`); toast.success(`Activation link re-sent to ${u.email}.`); } catch (e) { toast.error(errorMessage(e)); }
  }

  return (
    <Page>
      <PageHeader title="Accounts" subtitle="Create and disable platform accounts and reset MFA. Every action here needs your second factor and is written to the audit log." actions={<Button size="sm" onClick={() => setOpen(true)}>New account</Button>} />
      <ErrorBanner error={list.error} />
      <Card>
        {list.loading && !list.data ? <Spinner /> : !list.data?.length ? <EmptyState title="No accounts in your remit" /> : (
          <Table caption="Accounts">
            <THead cols={["Name", "E-mail", "Role", "Status", "MFA", "Last sign-in", ""]} />
            <tbody>
              {list.data.map((u) => (
                <Tr key={u.id}>
                  <Td className="font-medium text-[var(--text-primary)]">{u.name}{u.id === user?.id && <Badge tone="brand">You</Badge>}</Td>
                  <Td className="break-all">{u.email}</Td>
                  <Td className="capitalize">{u.role}</Td>
                  <Td><StatusPill value={u.status} /></Td>
                  <Td>{u.mfa_enrolled ? <Badge tone="allow">Enrolled</Badge> : <Badge tone="review">Not yet</Badge>}</Td>
                  <Td className="tabular text-[var(--text-tertiary)] whitespace-nowrap">{u.last_login ? fmtFullDateTime(u.last_login) : "never"}</Td>
                  <Td className="text-right whitespace-nowrap">
                    {u.status === "invited" && <Button size="sm" variant="ghost" onClick={() => void resend(u)}>Resend link</Button>}
                    {u.id !== user?.id && <Button size="sm" variant="ghost" onClick={() => setTarget({ u, what: "mfa" })}>Reset MFA</Button>}
                    {u.id !== user?.id && <Button size="sm" variant={u.status === "disabled" ? "secondary" : "danger"} onClick={() => setTarget({ u, what: "status" })}>{u.status === "disabled" ? "Enable" : "Disable"}</Button>}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <NewAccount open={open} onClose={() => setOpen(false)} onDone={() => { setOpen(false); toast.success("Account created. An activation link was e-mailed."); void list.reload(); }} />
      {target && <ReasonDialog target={target} onClose={() => setTarget(null)} onDone={() => { setTarget(null); toast.success("Done."); void list.reload(); }} />}
    </Page>
  );
}

function NewAccount({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ name: "", email: "", role: "admin" });
  const act = useAction();
  async function save() { let ok = false; await act.run(async () => { await post("/users", f); ok = true; }); if (ok) { setF({ name: "", email: "", role: "admin" }); onDone(); } }
  return (
    <Modal open={open} onClose={onClose} title="New account" description="The person receives a one-time activation link (24 h) and must register MFA before seeing anything." size="sm" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={act.busy || f.name.length < 2 || !f.email} onClick={() => void save()}>Create</Button></>}>
      <div className="space-y-4">
        <TextField label="Full name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <TextField label="E-mail" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <SelectField label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="superadmin">Super Admin (max. 2, named people)</option><option value="admin">Administrator</option></SelectField>
        <ErrorBanner error={act.error} />
      </div>
    </Modal>
  );
}

function ReasonDialog({ target, onClose, onDone }: { target: { u: UserRow; what: "mfa" | "status" }; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const act = useAction();
  const disabling = target.u.status !== "disabled";
  async function save() {
    let ok = false;
    await act.run(async () => {
      if (target.what === "mfa") await post(`/users/${target.u.id}/mfa-reset`, { reason });
      else await post(`/users/${target.u.id}/status`, { status: disabling ? "disabled" : "active", reason });
      ok = true;
    });
    if (ok) onDone();
  }
  return (
    <Modal open onClose={onClose} title={target.what === "mfa" ? `Reset MFA for ${target.u.name}` : `${disabling ? "Disable" : "Enable"} ${target.u.name}`} description={target.what === "mfa" ? "Record how the person was identified. Their sessions end and they must register a new factor. They are e-mailed." : disabling ? "All their sessions end immediately." : undefined} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={target.what === "status" && disabling ? "danger" : "primary"} disabled={act.busy || reason.trim().length < (target.what === "mfa" ? 15 : 5)} onClick={() => void save()}>Confirm</Button></>}>
      <div className="space-y-4"><TextAreaField label={target.what === "mfa" ? "Identity verification (min. 15 characters)" : "Reason"} value={reason} onChange={(e) => setReason(e.target.value)} /><ErrorBanner error={act.error} /></div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------------------------ system

interface SystemSettings { retention_years: number; session_alert_email: string; maintenance_banner: string }
interface Backups { directory: string; retention_days: number; files: { name: string; bytes: number; modified: string; past_retention: boolean }[] }
interface Status { encryption: { algorithm: string; key_version: string; key_fingerprint: string; source: string }; mfa_policy: { allow_totp_for_privileged: boolean; superadmin_networks: string[] }; last_restore_drill: { at: string; result: string; backup_file: string; notes: string } | null; audit_entries: number }

export function SystemPage() {
  const toast = useToast();
  const settings = useApi<SystemSettings>("/system/settings");
  const status = useApi<Status>("/system/status");
  const backups = useApi<Backups>("/system/backups");
  const [years, setYears] = useState<string | null>(null);
  const [drill, setDrill] = useState({ backup_file: "", result: "success", notes: "" });
  const act = useAction();

  async function saveSettings() {
    let ok = false;
    await act.run(async () => { await put("/system/settings", { retention_years: Number(years ?? settings.data?.retention_years) }); ok = true; });
    if (ok) { toast.success("Settings saved."); await settings.reload(); setYears(null); }
  }
  async function saveDrill() {
    let ok = false;
    await act.run(async () => { await post("/system/restore-drills", drill); ok = true; });
    if (ok) { toast.success("Restore drill recorded."); setDrill({ backup_file: "", result: "success", notes: "" }); await status.reload(); }
  }
  const s = status.data;

  return (
    <Page>
      <PageHeader title="System & keys" subtitle="Platform settings, encryption keys, backups and the monthly restore-drill record. Every change needs your second factor." />
      <ErrorBanner error={act.error ?? settings.error ?? status.error} />
      <div className="grid lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader title="Encryption keys" subtitle="Key material is never shown here, only a fingerprint." />
          {!s ? <Spinner /> : (
            <dl className="p-5 grid grid-cols-2 gap-4 text-sm">
              <div><dt className="text-[12px] text-[var(--text-tertiary)]">Algorithm</dt><dd>{s.encryption.algorithm}</dd></div>
              <div><dt className="text-[12px] text-[var(--text-tertiary)]">Key version</dt><dd className="tabular">{s.encryption.key_version}</dd></div>
              <div><dt className="text-[12px] text-[var(--text-tertiary)]">Fingerprint</dt><dd className="font-mono tabular">{s.encryption.key_fingerprint}</dd></div>
              <div><dt className="text-[12px] text-[var(--text-tertiary)]">Source</dt><dd>{s.encryption.source}</dd></div>
              <div className="col-span-2"><dt className="text-[12px] text-[var(--text-tertiary)]">Super Admin may sign in only from</dt><dd className="font-mono text-[12px]">{s.mfa_policy.superadmin_networks.join(", ")}</dd></div>
            </dl>
          )}
        </Card>
        <Card>
          <CardHeader title="Retention" subtitle="Students are archived once their batch is older than this." />
          <div className="p-5 flex items-end gap-3">
            <div className="w-40"><TextField label="Years after batch" value={years ?? String(settings.data?.retention_years ?? "")} onChange={(e) => setYears(e.target.value)} inputMode="numeric" /></div>
            <Button size="sm" disabled={act.busy || years === null} onClick={() => void saveSettings()}>Save</Button>
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Backups" subtitle={`Nightly encrypted backups, kept ${backups.data?.retention_days ?? 30} days (scripts/backup.sh). Folder: ${backups.data?.directory ?? ""}`} />
        {!backups.data?.files.length ? <EmptyState title="No backup files found">Run scripts/backup.sh (see the README) and they appear here.</EmptyState> : (
          <Table caption="Backups"><THead cols={["File", "Size", "Created", ""]} /><tbody>
            {backups.data.files.map((f) => <Tr key={f.name}><Td className="font-mono text-[12px]">{f.name}</Td><Td className="tabular">{(f.bytes / 1024 / 1024).toFixed(1)} MB</Td><Td className="tabular">{fmtDate(f.modified)}</Td><Td>{f.past_retention && <Badge tone="review">past retention</Badge>}</Td></Tr>)}
          </tbody></Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Monthly restore drill" subtitle="Restore a backup into a separate environment and write down what happened." />
        {s?.last_restore_drill ? <div className="px-5 pt-4"><Banner tone={s.last_restore_drill.result === "success" ? "success" : "error"}>Last drill {fmtFullDateTime(s.last_restore_drill.at)}: {s.last_restore_drill.result} — {s.last_restore_drill.backup_file}. {s.last_restore_drill.notes}</Banner></div> : <div className="px-5 pt-4"><Banner tone="warn">No restore drill has been recorded yet.</Banner></div>}
        <div className="p-5 grid sm:grid-cols-2 gap-4">
          <TextField label="Backup file restored" value={drill.backup_file} onChange={(e) => setDrill({ ...drill, backup_file: e.target.value })} />
          <SelectField label="Result" value={drill.result} onChange={(e) => setDrill({ ...drill, result: e.target.value })}><option value="success">Success</option><option value="failed">Failed</option></SelectField>
          <div className="sm:col-span-2"><TextAreaField label="Written record (min. 10 characters)" value={drill.notes} onChange={(e) => setDrill({ ...drill, notes: e.target.value })} /></div>
          <div className="sm:col-span-2"><Button size="sm" disabled={act.busy || drill.backup_file.length < 3 || drill.notes.trim().length < 10} onClick={() => void saveDrill()}>Record drill</Button></div>
        </div>
      </Card>
    </Page>
  );
}
