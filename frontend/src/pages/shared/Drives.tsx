import { Plus } from "lucide-react";
import { useState } from "react";
import { Badge, CategoryBadge, StatusPill } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { SelectField, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Page, PageHeader } from "../../components/ui/PageHeader";
import { PolicyExplain } from "../../components/ui/PolicyExplain";
import { AppStatusBadge, StatusBadge } from "../../components/ui/StatusBadge";
import { Banner, EmptyState, ErrorBanner, Spinner } from "../../components/ui/States";
import { Table, Td, THead, Tr } from "../../components/ui/Table";
import { Tabs } from "../../components/ui/Tabs";
import { useToast } from "../../components/ui/Toast";
import { packageText } from "../../components/student/DriveItem";
import { errorMessage, post } from "../../lib/api";
import { OFFER_TYPE } from "../../lib/format";
import type { Drive, StudentRow } from "../../lib/models";
import { toPolicyDecision, type ServerDecision } from "../../lib/types";
import { useAction, useApi } from "../../lib/use-api";

interface Company { id: string; name: string; verified_domain: string; _count: { drives: number } }
interface Eligibility { counts: Record<"ALLOW" | "BLOCK" | "REVIEW", number>; items: { student_id: string; placement_id: string; name: string; programme_code: string; result: "ALLOW" | "BLOCK" | "REVIEW"; summary: string; fired_rules: ServerDecision["fired_rules"] }[] }
interface Applicant { application_id: string; stage: string; applied_at: string; student: StudentRow }
interface AttRow { student_id: string; name: string; placement_id: string; event: string; present: boolean; exception_id: string | null }

/** Drives list. Officer: create companies and drives, open/close, invite the HR contact. Coordinator: workspace only. */
export function DrivesPage({ role }: { role: "coordinator" | "placement_officer" }) {
  const toast = useToast();
  const officer = role === "placement_officer";
  const drives = useApi<Drive[]>("/drives");
  const companies = useApi<Company[]>(officer ? "/companies" : null);
  const [ws, setWs] = useState<Drive | null>(null);
  const [newCo, setNewCo] = useState(false);
  const [newDrive, setNewDrive] = useState(false);
  const [invite, setInvite] = useState<Drive | null>(null);

  async function change(d: Drive, what: "open" | "close") {
    if (!window.confirm(what === "open" ? `Open "${d.title}"? The rule engine will pre-compute the eligible list for every registered student, and the drive's terms become fixed.` : `Close "${d.title}"? HR accounts for this company expire if it has no other live drive.`)) return;
    try {
      const r = await post<{ precomputed?: Record<string, number>; hr_accounts_expired?: number }>(`/drives/${d.id}/${what}`);
      toast.success(what === "open" ? `Drive opened. Eligible list computed: ${r.precomputed?.ALLOW ?? 0} allowed, ${r.precomputed?.BLOCK ?? 0} blocked, ${r.precomputed?.REVIEW ?? 0} for review.` : "Drive closed.");
      await drives.reload();
    } catch (e) { toast.error(errorMessage(e)); }
  }

  const list = (drives.data ?? []).filter((d) => officer || d.status !== "draft");
  return (
    <Page>
      <PageHeader
        title={officer ? "Drives & companies" : "Drives & attendance"}
        subtitle={officer ? "Create the company and the drive, invite the HR contact, then open the drive. Category is computed from the CTC, never typed." : "See who is eligible for each drive and why, shortlist, and mark attendance for the PPT, test and interviews."}
        actions={officer && <><Button size="sm" variant="secondary" onClick={() => setNewCo(true)}><Plus size={14} aria-hidden /> Company</Button><Button size="sm" onClick={() => setNewDrive(true)} disabled={!companies.data?.length}><Plus size={14} aria-hidden /> Drive</Button></>}
      />
      <ErrorBanner error={drives.error} />
      <Card>
        {drives.loading && !drives.data ? <Spinner /> : list.length === 0 ? <EmptyState title="No drives yet">{officer ? "Create a company, then a drive." : "Drives appear here once the Placement Cell opens them."}</EmptyState> : (
          <Table caption="Drives">
            <THead cols={["Company", "Drive", "Type", "Package", "Category", "Status", ""]} />
            <tbody>
              {list.map((d) => (
                <Tr key={d.id}>
                  <Td className="font-medium text-[var(--text-primary)]">{d.company}</Td>
                  <Td>{d.title}</Td>
                  <Td>{OFFER_TYPE[d.offer_type]}</Td>
                  <Td className="tabular whitespace-nowrap">{packageText(d)}</Td>
                  <Td><CategoryBadge category={d.category} /></Td>
                  <Td><StatusPill value={d.status} /></Td>
                  <Td className="text-right whitespace-nowrap">
                    {d.status !== "draft" && <Button size="sm" variant="ghost" onClick={() => setWs(d)}>Workspace</Button>}
                    {officer && d.status === "draft" && <Button size="sm" onClick={() => void change(d, "open")}>Open</Button>}
                    {officer && d.status !== "closed" && <Button size="sm" variant="ghost" onClick={() => setInvite(d)}>Invite HR</Button>}
                    {officer && d.status === "open" && <Button size="sm" variant="danger" onClick={() => void change(d, "close")}>Close</Button>}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {ws && <Workspace drive={ws} role={role} onClose={() => setWs(null)} />}
      {officer && <NewCompany open={newCo} onClose={() => setNewCo(false)} onDone={() => { setNewCo(false); toast.success("Company created."); void companies.reload(); }} />}
      {officer && <NewDrive open={newDrive} companies={companies.data ?? []} onClose={() => setNewDrive(false)} onDone={() => { setNewDrive(false); toast.success("Drive created as a draft. Open it when it is ready."); void drives.reload(); }} />}
      {invite && <InviteHr drive={invite} onClose={() => setInvite(null)} onDone={(m) => { setInvite(null); toast.success(m); }} />}
    </Page>
  );
}

function NewCompany({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const act = useAction();
  async function save() { let ok = false; await act.run(async () => { await post("/companies", { name, verified_domain: domain }); ok = true; }); if (ok) { setName(""); setDomain(""); onDone(); } }
  return (
    <Modal open={open} onClose={onClose} title="New company" description="HR invites go only to addresses on the company's verified domain." size="sm" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={act.busy || name.length < 2 || !domain} onClick={() => void save()}>Create</Button></>}>
      <div className="space-y-4"><TextField label="Company name" value={name} onChange={(e) => setName(e.target.value)} /><TextField label="Verified e-mail domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="acme.com" /><ErrorBanner error={act.error} /></div>
    </Modal>
  );
}

function NewDrive({ open, companies, onClose, onDone }: { open: boolean; companies: Company[]; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ company_id: "", title: "", offer_type: "F", ctc: "", stipend: "", period: "monthly", cgpa: "", backlogs: "", programmes: "", deadline: "" });
  const act = useAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  async function save() {
    let ok = false;
    await act.run(async () => {
      await post("/drives", {
        company_id: f.company_id || companies[0]!.id, title: f.title, offer_type: f.offer_type,
        ctc_lpa: f.offer_type === "I" ? null : Number(f.ctc), stipend_amount: f.offer_type === "F" || !f.stipend ? null : Number(f.stipend), stipend_period: f.offer_type === "F" || !f.stipend ? null : f.period,
        criteria: { ...(f.cgpa && { min_cgpa: Number(f.cgpa) }), ...(f.backlogs !== "" && { max_backlogs: Number(f.backlogs) }), ...(f.programmes && { programmes: f.programmes.split(",").map((s) => s.trim()).filter(Boolean) }) },
        acceptance_deadline: f.deadline ? new Date(f.deadline).toISOString() : null,
      });
      ok = true;
    });
    if (ok) onDone();
  }
  return (
    <Modal open={open} onClose={onClose} title="New drive" description="Terms are fixed once the drive opens. FTE CTC (LPA) and internship stipend (₹) are entered separately." size="lg" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={act.busy || f.title.length < 3} onClick={() => void save()}>Create draft</Button></>}>
      <div className="grid sm:grid-cols-2 gap-4">
        <SelectField label="Company" value={f.company_id || companies[0]?.id || ""} onChange={set("company_id")}>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</SelectField>
        <TextField label="Role / title" value={f.title} onChange={set("title")} />
        <SelectField label="Offer type" value={f.offer_type} onChange={set("offer_type")}><option value="F">Full-time (F)</option><option value="I">Internship only (I)</option><option value="IF">Internship + PPO/FTE (I+F)</option></SelectField>
        {f.offer_type !== "I" && <TextField label="CTC (LPA)" value={f.ctc} onChange={set("ctc")} inputMode="decimal" />}
        {f.offer_type !== "F" && <TextField label="Stipend (₹)" value={f.stipend} onChange={set("stipend")} inputMode="numeric" />}
        {f.offer_type !== "F" && <SelectField label="Stipend period" value={f.period} onChange={set("period")}><option value="monthly">Per month</option><option value="total">Total</option></SelectField>}
        <TextField label="Minimum CGPA" value={f.cgpa} onChange={set("cgpa")} inputMode="decimal" />
        <TextField label="Maximum backlogs" value={f.backlogs} onChange={set("backlogs")} inputMode="numeric" />
        <TextField label="Programmes (codes, comma-separated)" value={f.programmes} onChange={set("programmes")} hint="Blank = all programmes" />
        <TextField label="Company's offer-acceptance deadline" type="datetime-local" value={f.deadline} onChange={set("deadline")} hint="Offers expire at the earlier of this and 24 h after issue" />
      </div>
      <div className="mt-4"><ErrorBanner error={act.error} /></div>
    </Modal>
  );
}

function InviteHr({ drive, onClose, onDone }: { drive: Drive; onClose: () => void; onDone: (m: string) => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const act = useAction();
  async function save() { let ok = false; await act.run(async () => { await post(`/drives/${drive.id}/invite-hr`, { email, name, valid_days: 45 }); ok = true; }); if (ok) onDone(`Invitation sent to ${email}.`); }
  return (
    <Modal open onClose={onClose} title={`Invite HR — ${drive.company}`} description="Invite-only account, valid 45 days; it expires when the company has no live drive." size="sm" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={act.busy || !email || name.length < 2} onClick={() => void save()}>Send invitation</Button></>}>
      <div className="space-y-4"><TextField label="HR contact name" value={name} onChange={(e) => setName(e.target.value)} /><TextField label="Corporate e-mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} hint="Must be on the company's verified domain" /><ErrorBanner error={act.error} /></div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------------------------ workspace

function Workspace({ drive, role, onClose }: { drive: Drive; role: "coordinator" | "placement_officer"; onClose: () => void }) {
  const [tab, setTab] = useState<"eligibility" | "applicants" | "attendance">("eligibility");
  return (
    <Modal open onClose={onClose} title={`${drive.company} — ${drive.title}`} description={`${OFFER_TYPE[drive.offer_type]} · ${packageText(drive)}`} size="lg">
      <Tabs label="Drive" value={tab} onChange={setTab} tabs={[{ id: "eligibility", label: "Eligibility" }, { id: "applicants", label: "Applicants" }, { id: "attendance", label: "Attendance" }]} />
      <div className="pt-4">{tab === "eligibility" ? <EligibilityTab id={drive.id} /> : tab === "applicants" ? <ApplicantsTab id={drive.id} /> : <AttendanceTab drive={drive} />}</div>
      <span className="sr-only">{role}</span>
    </Modal>
  );
}

function EligibilityTab({ id }: { id: string }) {
  const e = useApi<Eligibility>(`/drives/${id}/eligibility`);
  const [open, setOpen] = useState<string | null>(null);
  if (e.loading && !e.data) return <Spinner label="Running the policy engine" />;
  if (!e.data) return <ErrorBanner error={e.error} />;
  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap"><Badge tone="allow">Allowed {e.data.counts.ALLOW}</Badge><Badge tone="block">Blocked {e.data.counts.BLOCK}</Badge><Badge tone="review">Review {e.data.counts.REVIEW}</Badge></div>
      <Table caption="Eligibility">
        <THead cols={["Student", "Programme", "Verdict", ""]} />
        <tbody>
          {e.data.items.map((i) => (
            <Tr key={i.student_id}>
              <Td>{i.name} <span className="text-[12px] text-[var(--text-tertiary)] tabular">{i.placement_id}</span>{open === i.student_id && <div className="mt-2"><PolicyExplain decision={toPolicyDecision({ result: i.result, summary: i.summary, fired_rules: i.fired_rules })} /></div>}</Td>
              <Td>{i.programme_code}</Td>
              <Td><StatusBadge outcome={i.result} size="sm" /></Td>
              <Td className="text-right">{i.result !== "ALLOW" && <Button size="sm" variant="ghost" onClick={() => setOpen(open === i.student_id ? null : i.student_id)}>Why?</Button>}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function ApplicantsTab({ id }: { id: string }) {
  const toast = useToast();
  const a = useApi<Applicant[]>(`/drives/${id}/applicants`);
  async function stage(studentId: string, s: string) {
    try {
      const r = await post<{ updated: number; failed: { reason: string }[] }>(`/drives/${id}/stage`, { student_ids: [studentId], stage: s });
      if (r.failed.length) toast.error(r.failed[0]!.reason); else toast.success(`Moved to ${s}.`);
      await a.reload();
    } catch (e) { toast.error(errorMessage(e)); }
  }
  if (a.loading && !a.data) return <Spinner />;
  if (!a.data?.length) return <EmptyState title="No applicants yet" />;
  return (
    <Table caption="Applicants">
      <THead cols={["Student", "CGPA", "Stage", ""]} />
      <tbody>
        {a.data.map((x) => (
          <Tr key={x.application_id}>
            <Td>{x.student.name} <span className="text-[12px] text-[var(--text-tertiary)] tabular">{x.student.placement_id} · {x.student.programme_code}</span></Td>
            <Td className="tabular">{x.student.cgpa ?? "—"}</Td>
            <Td><AppStatusBadge status={x.stage} /></Td>
            <Td className="text-right whitespace-nowrap">
              {x.stage === "applied" && <Button size="sm" onClick={() => void stage(x.student.id, "shortlisted")}>Shortlist</Button>}
              {["applied", "shortlisted"].includes(x.stage) && <Button size="sm" variant="danger" onClick={() => void stage(x.student.id, "rejected")}>Reject</Button>}
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

function AttendanceTab({ drive }: { drive: Drive }) {
  const toast = useToast();
  const apps = useApi<Applicant[]>(`/drives/${drive.id}/applicants`);
  const [event, setEvent] = useState<"PPT" | "TEST" | "INTERVIEW">("PPT");
  const [absent, setAbsent] = useState<Set<string>>(new Set());
  const act = useAction();
  const existing = useApi<AttRow[]>(`/attendance/drive/${drive.id}`);

  async function save() {
    const rows = (apps.data ?? []).map((a) => ({ student_id: a.student.id, present: !absent.has(a.student.id) }));
    let res: { rows: number; unexcused_absences: number } | undefined;
    await act.run(async () => { res = await post<{ rows: number; unexcused_absences: number }>("/attendance", { drive_id: drive.id, event, records: rows }); });
    if (res) { toast.success(`Attendance saved for ${res.rows} students. ${res.unexcused_absences} unexcused absence${res.unexcused_absences === 1 ? "" : "s"} flagged for officer review.`); await existing.reload(); }
  }
  if (apps.loading && !apps.data) return <Spinner />;
  if (!apps.data?.length) return <EmptyState title="No applicants to mark" />;
  return (
    <div className="space-y-3">
      <div className="flex items-end gap-3 flex-wrap">
        <div className="w-44"><SelectField label="Event" value={event} onChange={(e) => setEvent(e.target.value as typeof event)}><option value="PPT">Pre-placement talk</option><option value="TEST">Test</option><option value="INTERVIEW">Interview</option></SelectField></div>
        <Button size="sm" onClick={() => void save()} disabled={act.busy}>{act.busy ? "Saving…" : "Save attendance"}</Button>
      </div>
      <Banner tone="info">Tick the students who were ABSENT. Marking again later adds a new row (history is kept; the latest wins). An unexcused absence blocks the student from the next drives until the Placement Officer approves an exception.</Banner>
      <ErrorBanner error={act.error} />
      <Table caption="Attendance">
        <THead cols={["Absent", "Student", "Last saved"]} />
        <tbody>
          {apps.data.map((a) => {
            const last = existing.data?.filter((r) => r.student_id === a.student.id).map((r) => `${r.event}: ${r.present ? "present" : "absent"}`).join(", ");
            return (
              <Tr key={a.student.id}>
                <Td><input type="checkbox" aria-label={`${a.student.name} absent`} className="h-4 w-4 accent-[var(--status-block-text)]" checked={absent.has(a.student.id)} onChange={(e) => { const n = new Set(absent); if (e.target.checked) n.add(a.student.id); else n.delete(a.student.id); setAbsent(n); }} /></Td>
                <Td>{a.student.name} <span className="text-[12px] text-[var(--text-tertiary)] tabular">{a.student.placement_id}</span></Td>
                <Td className="text-[12px] text-[var(--text-secondary)]">{last || "—"}</Td>
              </Tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}

