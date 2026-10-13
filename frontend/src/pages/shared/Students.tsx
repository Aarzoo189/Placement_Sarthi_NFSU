import { Plus, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { KV, Pager, useDebounced } from "../../components/staff/parts";
import { Badge, CategoryBadge, StatusPill } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { FilterInput, FilterSelect, SelectField, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Page, PageHeader } from "../../components/ui/PageHeader";
import { Banner, EmptyState, ErrorBanner, Spinner } from "../../components/ui/States";
import { Table, Td, THead, Tr } from "../../components/ui/Table";
import { Tabs } from "../../components/ui/Tabs";
import { useToast } from "../../components/ui/Toast";
import { errorMessage, post, upload } from "../../lib/api";
import { fmtShortDate, lpa } from "../../lib/format";
import type { Offer, Page as Paged, Programme, StudentRow } from "../../lib/models";
import { useAction, useApi } from "../../lib/use-api";

type Mode = "coordinator" | "officer" | "superadmin";

interface Preview {
  token: string;
  total: number;
  valid: number;
  rejected: number;
  errors: { row: number; placement_id: string; errors: string[] }[];
}
interface ContactChange {
  id: string;
  field: string;
  new_value: string;
  requested_at: string;
  student: { id: string; placement_id: string; name: string; programme_code: string };
}

/**
 * Students. Coordinator: own programme. Officer: everyone. Super Admin: masked lookup, full view only through a logged
 * break-glass with a written reason. What each role sees is decided by the server: this page renders what it is sent.
 */
export function StudentsPage({ mode }: { mode: Mode }) {
  const toast = useToast();
  const [tab, setTab] = useState<"students" | "changes">("students");
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim());
  const [programme, setProgramme] = useState("");
  const [elig, setElig] = useState("");
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<StudentRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const programmes = useApi<Programme[]>("/programmes");

  const qs = new URLSearchParams({ page: String(page), page_size: "20" });
  if (dq) qs.set("q", dq);
  if (programme) qs.set("programme_id", programme);
  if (elig) qs.set("eligibility", elig);
  if (status) qs.set("placement_status", status);
  const list = useApi<Paged<StudentRow>>(`/students?${qs}`);
  const changes = useApi<ContactChange[]>(mode === "superadmin" ? null : "/students/contact-changes");
  const canEdit = mode !== "superadmin";

  async function decide(id: string, approve: boolean) {
    try {
      await post(`/students/contact-changes/${id}/decide`, { approve });
      toast.success(approve ? "Change approved." : "Change rejected.");
      await changes.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <Page>
      <PageHeader
        title={mode === "superadmin" ? "Student lookup (masked)" : "Students"}
        subtitle={mode === "superadmin" ? "Contact details are masked. A full view needs a written reason and raises an alert." : mode === "coordinator" ? "Students of your programme." : "All students across programmes."}
        actions={
          canEdit && (
            <>
              <Button variant="secondary" size="sm" onClick={() => setImportOpen(true)}><Upload size={14} aria-hidden /> Import CSV</Button>
              <Button size="sm" onClick={() => setAddOpen(true)}><Plus size={14} aria-hidden /> Add student</Button>
            </>
          )
        }
      />

      {canEdit && <Tabs label="Students" value={tab} onChange={setTab} tabs={[{ id: "students", label: "Students" }, { id: "changes", label: "Contact-change requests", count: changes.data?.length }]} />}

      {tab === "students" ? (
        <Card>
          <div className="flex flex-wrap gap-2 p-4 border-b border-[var(--surface-border)]">
            <FilterInput aria-label="Search students" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search name, ID, e-mail" className="w-56" />
            <FilterSelect aria-label="Programme" value={programme} onChange={(e) => { setProgramme(e.target.value); setPage(1); }}>
              <option value="">All programmes</option>
              {programmes.data?.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}
            </FilterSelect>
            <FilterSelect aria-label="Eligibility" value={elig} onChange={(e) => { setElig(e.target.value); setPage(1); }}>
              <option value="">Any eligibility</option>
              <option value="eligible">Eligible</option>
              <option value="pending">Pending</option>
              <option value="ineligible">Ineligible</option>
            </FilterSelect>
            <FilterSelect aria-label="Placement status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">Any status</option>
              <option>Unplaced</option>
              <option>Internship only</option>
              <option>FTE only</option>
              <option>Internship + PPO/FTE</option>
            </FilterSelect>
          </div>
          <ErrorBanner error={list.error} />
          {list.loading && !list.data ? (
            <Spinner />
          ) : list.data && list.data.items.length === 0 ? (
            <EmptyState title="No students match" />
          ) : (
            <>
              <Table caption="Students">
                <THead cols={["Placement ID", "Name", "Programme", "Batch", "Eligibility", "Status", "Category", ""]} />
                <tbody>
                  {list.data?.items.map((s) => (
                    <Tr key={s.id}>
                      <Td className="tabular text-[var(--text-secondary)]">{s.placement_id}</Td>
                      <Td className="font-medium text-[var(--text-primary)]">{s.name}</Td>
                      <Td>{s.programme_code}</Td>
                      <Td className="tabular">{s.batch}</Td>
                      <Td><StatusPill value={s.eligibility_status ?? "pending"} /></Td>
                      <Td>{s.placement_status ?? "—"}</Td>
                      <Td><CategoryBadge category={s.current_category} /></Td>
                      <Td className="text-right"><Button size="sm" variant="ghost" onClick={() => setOpen(s)}>Open</Button></Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
              {list.data && <Pager page={list.data.page} pageSize={list.data.page_size} total={list.data.total} onChange={setPage} />}
            </>
          )}
        </Card>
      ) : (
        <Card>
          <CardHeader title="Contact-change requests" subtitle="Students cannot edit their own contact details; they ask, you approve." />
          {!changes.data?.length ? (
            <EmptyState title="No pending requests" />
          ) : (
            <Table caption="Contact change requests">
              <THead cols={["Student", "Field", "New value", "Requested", ""]} />
              <tbody>
                {changes.data.map((c) => (
                  <Tr key={c.id}>
                    <Td>{c.student.name} <span className="text-[12px] text-[var(--text-tertiary)] tabular">{c.student.placement_id}</span></Td>
                    <Td className="capitalize">{c.field}</Td>
                    <Td className="tabular">{c.new_value}</Td>
                    <Td className="tabular text-[var(--text-tertiary)]">{fmtShortDate(c.requested_at)}</Td>
                    <Td className="text-right whitespace-nowrap">
                      <Button size="sm" onClick={() => void decide(c.id, true)}>Approve</Button>{" "}
                      <Button size="sm" variant="danger" onClick={() => void decide(c.id, false)}>Reject</Button>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      <StudentDetail student={open} mode={mode} onClose={() => setOpen(null)} onChanged={() => void list.reload()} />
      {canEdit && <AddStudent open={addOpen} programmes={programmes.data ?? []} onClose={() => setAddOpen(false)} onDone={() => { setAddOpen(false); void list.reload(); }} />}
      {canEdit && <ImportCsv open={importOpen} onClose={() => setImportOpen(false)} onDone={() => { setImportOpen(false); void list.reload(); }} />}
    </Page>
  );
}

function StudentDetail({ student, mode, onClose, onChanged }: { student: StudentRow | null; mode: Mode; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const [full, setFull] = useState<StudentRow | null>(null);
  const [reason, setReason] = useState("");
  const detail = useApi<StudentRow>(student ? `/students/${student.id}` : null);
  const offers = useApi<Offer[]>(student && mode !== "superadmin" ? `/offers?student_id=${student.id}` : null);
  const act = useAction();
  const s = full ?? detail.data ?? student;

  async function setEligibility(status: string) {
    if (!student) return;
    let ok = false;
    await act.run(async () => {
      await post(`/students/${student.id}/eligibility`, { status });
      ok = true;
    });
    if (ok) {
      toast.success(`Eligibility set to ${status}.`);
      await detail.reload();
      onChanged();
    }
  }

  async function breakGlass() {
    if (!student) return;
    const r = await act.run(() => post<StudentRow>(`/students/${student.id}/break-glass`, { reason }));
    if (r) setFull(r);
  }

  return (
    <Modal open={!!student} onClose={() => { setFull(null); setReason(""); act.clearError(); onClose(); }} title={s?.name ?? ""} description={s ? `${s.placement_id} · ${s.programme_code}` : undefined} size="lg">
      {s && (
        <div className="space-y-5">
          {s.masked && <Banner tone="info">Some details are masked for your role.</Banner>}
          <dl className="grid sm:grid-cols-3 gap-4">
            <KV k="E-mail">{s.email ?? "—"}</KV>
            <KV k="Mobile">{s.mobile ?? "—"}</KV>
            <KV k="Batch">{s.batch}</KV>
            <KV k="CGPA / backlogs">{s.cgpa ?? "—"} / {s.backlogs ?? "—"}</KV>
            <KV k="Registration"><StatusPill value={s.registration_status ?? "pending"} /></KV>
            <KV k="Eligibility"><StatusPill value={s.eligibility_status ?? "pending"} /></KV>
            <KV k="Placement status">{s.placement_status ?? "—"}</KV>
            <KV k="Category"><CategoryBadge category={s.current_category} /></KV>
            <KV k="Accepted offers">{s.accepted_offer_count ?? 0}</KV>
          </dl>

          {mode !== "superadmin" && (
            <div>
              <p className="text-[13px] font-medium text-[var(--text-primary)] mb-2">Verify eligibility</p>
              <div className="flex gap-2 flex-wrap">
                {(["eligible", "pending", "ineligible"] as const).map((e) => (
                  <Button key={e} size="sm" variant={s.eligibility_status === e ? "primary" : "secondary"} disabled={act.busy || s.eligibility_status === e} onClick={() => void setEligibility(e)}>{e}</Button>
                ))}
              </div>
            </div>
          )}

          {mode !== "superadmin" && (
            <div>
              <p className="text-[13px] font-medium text-[var(--text-primary)] mb-2">Offers</p>
              {offers.loading ? <Spinner /> : !offers.data?.length ? <p className="text-[13px] text-[var(--text-tertiary)]">No offers.</p> : (
                <ul className="space-y-1.5 text-[13px]">
                  {offers.data.map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--surface-border)] px-3 py-2">
                      <span>{o.company} <span className="text-[var(--text-tertiary)]">· {o.type}</span></span>
                      <span className="flex items-center gap-2"><span className="tabular">{o.ctc_lpa != null ? lpa(o.ctc_lpa) : ""}</span><StatusPill value={o.acceptance_status} /></span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {mode === "superadmin" && !full && (
            <div className="rounded-[var(--radius-sm)] border border-[var(--status-review-text)]/30 bg-[var(--status-review-bg)] p-4 space-y-3">
              <p className="text-[13px] font-medium text-[var(--status-review-text)]">Break-glass: see the full record</p>
              <p className="text-[12.5px] text-[var(--text-secondary)]">Every use is logged with your reason and alerts the other Super Admin. You will confirm with your second factor.</p>
              <TextField label="Reason (min. 15 characters)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button size="sm" disabled={act.busy || reason.trim().length < 15} onClick={() => void breakGlass()}>Show full record</Button>
            </div>
          )}
          <ErrorBanner error={act.error} />
        </div>
      )}
    </Modal>
  );
}

function AddStudent({ open, programmes, onClose, onDone }: { open: boolean; programmes: Programme[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const act = useAction();
  const [f, setF] = useState({ placement_id: "", name: "", email: "", mobile: "", programme_code: "", batch: "2026", cgpa: "", backlogs: "0" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  async function submit() {
    let ok = false;
    await act.run(async () => {
      await post("/students", { ...f, programme_code: f.programme_code || programmes[0]?.code, batch: Number(f.batch), cgpa: Number(f.cgpa || 0), backlogs: Number(f.backlogs || 0) });
      ok = true;
    });
    if (ok) {
      toast.success("Student added. An activation link was e-mailed to them.");
      onDone();
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Add a student" description="They receive a one-time activation link and must register MFA before seeing any data." footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={act.busy} onClick={() => void submit()}>{act.busy ? "Adding…" : "Add student"}</Button></>}>
      <div className="grid sm:grid-cols-2 gap-4">
        <TextField label="Placement ID" value={f.placement_id} onChange={set("placement_id")} hint="6–20 letters, digits or dashes" />
        <TextField label="Full name" value={f.name} onChange={set("name")} />
        <TextField label="Institutional e-mail" type="email" value={f.email} onChange={set("email")} />
        <TextField label="Mobile (10 digits)" value={f.mobile} onChange={set("mobile")} inputMode="tel" />
        <SelectField label="Programme" value={f.programme_code || programmes[0]?.code || ""} onChange={set("programme_code")}>
          {programmes.map((p) => <option key={p.id} value={p.code}>{p.code}</option>)}
        </SelectField>
        <TextField label="Batch (year)" value={f.batch} onChange={set("batch")} inputMode="numeric" />
        <TextField label="CGPA" value={f.cgpa} onChange={set("cgpa")} inputMode="decimal" />
        <TextField label="Backlogs" value={f.backlogs} onChange={set("backlogs")} inputMode="numeric" />
      </div>
      <div className="mt-4"><ErrorBanner error={act.error} /></div>
    </Modal>
  );
}

function ImportCsv({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const act = useAction();
  const file = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  async function pick(f: File | undefined) {
    if (!f) return;
    const r = await act.run(() => upload<Preview>("/students/import/preview", f));
    if (r) setPreview(r);
  }
  async function commit() {
    if (!preview) return;
    const r = await act.run(() => post<{ created: number; skipped: number }>("/students/import/commit", { token: preview.token }));
    if (r) {
      toast.success(`${r.created} students imported, ${r.skipped} skipped.`);
      setPreview(null);
      onDone();
    }
  }
  return (
    <Modal
      open={open}
      onClose={() => { setPreview(null); onClose(); }}
      title="Import students from CSV"
      description="Step 1: upload and check. Nothing is saved until you commit; only clean rows are imported."
      size="lg"
      footer={preview ? <><Button variant="ghost" onClick={() => setPreview(null)}>Choose another file</Button><Button disabled={act.busy || preview.valid === 0} onClick={() => void commit()}>{act.busy ? "Importing…" : `Import ${preview.valid} clean row${preview.valid === 1 ? "" : "s"}`}</Button></> : undefined}
    >
      {!preview ? (
        <div className="space-y-3">
          <p className="text-[13px] text-[var(--text-secondary)]">Columns: <code className="font-mono text-[12px]">placement_id, name, email, mobile, programme, batch, cgpa, backlogs</code>. Max 1 MB, 2000 rows. You will confirm with your second factor.</p>
          <input ref={file} type="file" accept=".csv,text/csv" className="sr-only" aria-label="CSV file" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
          <Button onClick={() => file.current?.click()} disabled={act.busy}><Upload size={14} aria-hidden /> {act.busy ? "Checking…" : "Choose CSV file"}</Button>
          <ErrorBanner error={act.error} />
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex gap-2 flex-wrap"><Badge tone="allow">{preview.valid} clean</Badge><Badge tone={preview.rejected ? "block" : "neutral"}>{preview.rejected} rejected</Badge><Badge>{preview.total} rows in file</Badge></div>
          {preview.errors.length > 0 && (
            <Table caption="Rejected rows">
              <THead cols={["Row", "Placement ID", "Why it was rejected"]} />
              <tbody>
                {preview.errors.map((e, i) => (
                  <Tr key={i}><Td className="tabular">{e.row}</Td><Td className="tabular">{e.placement_id}</Td><Td className="text-[var(--status-block-text)]">{e.errors.join("; ")}</Td></Tr>
                ))}
              </tbody>
            </Table>
          )}
          <ErrorBanner error={act.error} />
        </div>
      )}
    </Modal>
  );
}
