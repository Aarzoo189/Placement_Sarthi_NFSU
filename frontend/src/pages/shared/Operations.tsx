import { Plus } from "lucide-react";
import { useState } from "react";
import { StudentPicker } from "../../components/staff/parts";
import { Badge, CategoryBadge, StatusPill } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { FilterSelect, SelectField, TextAreaField, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Page, PageHeader } from "../../components/ui/PageHeader";
import { PolicyExplain } from "../../components/ui/PolicyExplain";
import { StatTile } from "../../components/ui/StatTile";
import { EmptyState, ErrorBanner, Spinner } from "../../components/ui/States";
import { Table, Td, THead, Tr } from "../../components/ui/Table";
import { Tabs } from "../../components/ui/Tabs";
import { useToast } from "../../components/ui/Toast";
import { del, patch, post } from "../../lib/api";
import { fmtDateTime, fmtShortDate, inr, lpa, relative } from "../../lib/format";
import { RULE_NAMES, type ExceptionRow, type Offer, type ReviewItem, type StudentRow } from "../../lib/models";
import { toPolicyDecision } from "../../lib/types";
import { useAction, useApi } from "../../lib/use-api";
import { GitCompareArrows, ShieldAlert, Users } from "lucide-react";

type StaffRole = "coordinator" | "placement_officer";

// ------------------------------------------------------------------------------------------------------------- offers

interface OfferEvent { id: string; field: string; old_value: string | null; new_value: string | null; at: string }

export function OffersPage({ role }: { role: StaffRole }) {
  const toast = useToast();
  const [status, setStatus] = useState("");
  const list = useApi<Offer[]>(`/offers${status ? `?status=${status}` : ""}`);
  const [sel, setSel] = useState<Offer | null>(null);
  const [mode, setMode] = useState<"life" | "ctc" | "history" | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const rows = list.data ?? [];

  return (
    <Page>
      <PageHeader
        title="Offers"
        subtitle="Offers are never overwritten: every change is a new event, so history is kept. Placement status is derived from accepted offers by the rule engine, nobody types it."
        actions={<><FilterSelect aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option><option value="pending">Pending</option><option value="accepted">Accepted</option><option value="declined">Declined</option><option value="expired">Expired</option></FilterSelect><Button size="sm" onClick={() => setAddOpen(true)}><Plus size={14} aria-hidden /> Record offer</Button></>}
      />
      <ErrorBanner error={list.error} />
      <Card>
        {list.loading && !list.data ? <Spinner /> : rows.length === 0 ? <EmptyState title="No offers" /> : (
          <Table caption="Offers">
            <THead cols={["Student", "Company", "Type", "Category", "Package", "Status", "Joining / PPO / NOC", ""]} />
            <tbody>
              {rows.map((o) => (
                <Tr key={o.id}>
                  <Td><span className="font-medium text-[var(--text-primary)]">{o.student.name}</span><br /><span className="text-[12px] text-[var(--text-tertiary)] tabular">{o.student.placement_id}</span></Td>
                  <Td>{o.company}{o.off_campus && <Badge tone="brand">Off-campus</Badge>}</Td>
                  <Td>{o.type}</Td>
                  <Td><CategoryBadge category={o.category} /></Td>
                  <Td className="tabular whitespace-nowrap">{o.ctc_lpa != null ? lpa(o.ctc_lpa) : ""}{o.ctc_lpa != null && o.stipend_amount != null ? <br /> : ""}{o.stipend_amount != null ? `${inr(o.stipend_amount)} stipend` : ""}</Td>
                  <Td><StatusPill value={o.acceptance_status} /></Td>
                  <Td className="text-[12px] text-[var(--text-secondary)]">{o.joining_status.replace(/_/g, " ")} · {o.ppo_status.replace(/_/g, " ")} · NOC {o.noc_status.replace(/_/g, " ")}</Td>
                  <Td className="text-right whitespace-nowrap">
                    <Button size="sm" variant="ghost" onClick={() => { setSel(o); setMode("history"); }}>History</Button>
                    {o.acceptance_status === "accepted" && <Button size="sm" variant="ghost" onClick={() => { setSel(o); setMode("life"); }}>Update</Button>}
                    {role === "placement_officer" && o.type !== "I" && <Button size="sm" variant="ghost" onClick={() => { setSel(o); setMode("ctc"); }}>Correct CTC</Button>}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {sel && mode === "history" && <History offer={sel} onClose={() => setMode(null)} />}
      {sel && mode === "life" && <Lifecycle offer={sel} onClose={() => setMode(null)} onDone={() => { setMode(null); toast.success("Updated. The change is recorded as a new event."); void list.reload(); }} />}
      {sel && mode === "ctc" && <CorrectCtc offer={sel} onClose={() => setMode(null)} onDone={() => { setMode(null); toast.success("CTC corrected and logged. Category and status were recomputed."); void list.reload(); }} />}
      <RecordOffer open={addOpen} onClose={() => setAddOpen(false)} onDone={() => { setAddOpen(false); toast.success("Offer recorded."); void list.reload(); }} />
    </Page>
  );
}

function History({ offer, onClose }: { offer: Offer; onClose: () => void }) {
  const ev = useApi<OfferEvent[]>(`/offers/${offer.id}/events`);
  return (
    <Modal open onClose={onClose} title="Offer history" description={`${offer.student.name} — ${offer.company}`}>
      {ev.loading ? <Spinner /> : (
        <ol className="space-y-2 text-[13px]">
          {ev.data?.map((e) => (
            <li key={e.id} className="flex gap-3"><span className="text-[var(--text-tertiary)] tabular shrink-0 w-28">{fmtDateTime(e.at)}</span><span><strong>{e.field.replace(/_/g, " ")}</strong>: {e.old_value ?? "—"} → {e.new_value ?? "—"}</span></li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

function Lifecycle({ offer, onClose, onDone }: { offer: Offer; onClose: () => void; onDone: () => void }) {
  const [field, setField] = useState<"joining_status" | "ppo_status" | "noc_status">("joining_status");
  const options = { joining_status: ["pending", "joined", "not_joined"], ppo_status: ["not_applicable", "pending", "confirmed", "declined"], noc_status: ["not_required", "pending", "received"] };
  const [value, setValue] = useState(options.joining_status[0]!);
  const act = useAction();
  async function save() {
    let ok = false;
    await act.run(async () => { await patch(`/offers/${offer.id}/lifecycle`, { field, value }); ok = true; });
    if (ok) onDone();
  }
  return (
    <Modal open onClose={onClose} title="Update joining / PPO / NOC" description={`${offer.student.name} — ${offer.company}`} size="sm" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={act.busy} onClick={() => void save()}>Save</Button></>}>
      <div className="space-y-4">
        <SelectField label="What changed" value={field} onChange={(e) => { const f = e.target.value as typeof field; setField(f); setValue(options[f][0]!); }}>
          <option value="joining_status">Joining status</option><option value="ppo_status">PPO status</option><option value="noc_status">NOC status (off-campus)</option>
        </SelectField>
        <SelectField label="New value" value={value} onChange={(e) => setValue(e.target.value)}>{options[field].map((o) => <option key={o} value={o}>{o.replace(/_/g, " ")}</option>)}</SelectField>
        <ErrorBanner error={act.error} />
      </div>
    </Modal>
  );
}

function CorrectCtc({ offer, onClose, onDone }: { offer: Offer; onClose: () => void; onDone: () => void }) {
  const [ctc, setCtc] = useState(String(offer.ctc_lpa ?? ""));
  const [reason, setReason] = useState("");
  const act = useAction();
  async function save() {
    let ok = false;
    await act.run(async () => { await post(`/offers/${offer.id}/correct-ctc`, { ctc_lpa: Number(ctc), reason }); ok = true; });
    if (ok) onDone();
  }
  return (
    <Modal open onClose={onClose} title="Correct CTC" description="Logged with before/after values and your reason. The category is re-derived from the new CTC. Needs your second factor." size="sm" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={act.busy || !Number(ctc) || reason.trim().length < 10} onClick={() => void save()}>Correct CTC</Button></>}>
      <div className="space-y-4">
        <TextField label="CTC (LPA)" value={ctc} onChange={(e) => setCtc(e.target.value)} inputMode="decimal" />
        <TextAreaField label="Reason (min. 10 characters)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <ErrorBanner error={act.error} />
      </div>
    </Modal>
  );
}

function RecordOffer({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [student, setStudent] = useState<StudentRow | null>(null);
  const [f, setF] = useState({ type: "F", company: "", ctc: "", stipend: "", noc: "pending", accepted: true });
  const act = useAction();
  async function save() {
    let ok = false;
    await act.run(async () => {
      await post("/offers", { student_id: student!.id, type: f.type, off_campus_company: f.company, ctc_lpa: f.type === "I" ? null : Number(f.ctc), stipend_amount: f.type === "F" || !f.stipend ? null : Number(f.stipend), noc_status: f.noc, already_accepted: f.accepted });
      ok = true;
    });
    if (ok) { setStudent(null); onDone(); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Record an off-campus offer" description="The student already holds this offer. It counts towards their status once accepted. Needs your second factor." footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={act.busy || !student || !f.company} onClick={() => void save()}>Record offer</Button></>}>
      <div className="space-y-4">
        <StudentPicker value={student} onChange={setStudent} />
        <TextField label="Company" value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} />
        <SelectField label="Offer type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="F">Full-time (F)</option><option value="I">Internship only (I)</option><option value="IF">Internship + PPO/FTE (I+F)</option></SelectField>
        {f.type !== "I" && <TextField label="CTC (LPA)" value={f.ctc} onChange={(e) => setF({ ...f, ctc: e.target.value })} inputMode="decimal" />}
        {f.type !== "F" && <TextField label="Monthly stipend (₹) — a separate measure, never combined with CTC" value={f.stipend} onChange={(e) => setF({ ...f, stipend: e.target.value })} inputMode="numeric" />}
        <SelectField label="NOC" value={f.noc} onChange={(e) => setF({ ...f, noc: e.target.value })}><option value="pending">Pending</option><option value="received">Received</option><option value="not_required">Not required</option></SelectField>
        <ErrorBanner error={act.error} />
      </div>
    </Modal>
  );
}

// --------------------------------------------------------------------------------------------------------- switching

interface SwitchRow { student_id: string; placement_id: string; name: string; programme_code: string; placement_status: string; current_category: string | null; rule: string; still_eligible: boolean; blocked_all: boolean; allowed_categories: string[]; allowed_offer_types: string[]; min_ctc_lpa: number | null; note: string; pending_offers: number }

export function SwitchingPage() {
  const d = useApi<{ eligible_for_next_drive: number; out_of_process: number; items: SwitchRow[] }>("/dashboards/switching");
  const [only, setOnly] = useState(true);
  const items = (d.data?.items ?? []).filter((i) => !only || i.still_eligible);
  return (
    <Page>
      <PageHeader title="Switching eligibility" subtitle="Who can still apply to the next drive under the category rules, and which rule applies to them." actions={<label className="flex items-center gap-2 text-[13px]"><input type="checkbox" className="accent-[var(--brand-primary)]" checked={only} onChange={(e) => setOnly(e.target.checked)} /> Only those still eligible</label>} />
      <ErrorBanner error={d.error} />
      <div className="grid grid-cols-2 gap-3 max-w-lg">
        <StatTile label="Eligible for the next drive" value={d.data?.eligible_for_next_drive ?? "—"} icon={Users} />
        <StatTile label="Out of the process (A+)" value={d.data?.out_of_process ?? "—"} icon={GitCompareArrows} tone="accent" />
      </div>
      <Card>
        {d.loading && !d.data ? <Spinner /> : items.length === 0 ? <EmptyState title="Nobody to show" /> : (
          <Table caption="Switching eligibility">
            <THead cols={["Student", "Programme", "Status", "Category", "Rule", "May apply to", "Note"]} />
            <tbody>
              {items.map((i) => (
                <Tr key={i.student_id}>
                  <Td><span className="font-medium text-[var(--text-primary)]">{i.name}</span><br /><span className="text-[12px] text-[var(--text-tertiary)] tabular">{i.placement_id}</span></Td>
                  <Td>{i.programme_code}</Td>
                  <Td>{i.placement_status}</Td>
                  <Td><CategoryBadge category={i.current_category} /></Td>
                  <Td className="whitespace-nowrap">{i.rule}</Td>
                  <Td className="text-[12.5px]">{i.blocked_all ? <Badge tone="block">No further drives</Badge> : <>Categories: {i.allowed_categories.join(", ") || "—"}<br />Types: {i.allowed_offer_types.join(", ") || "—"}{i.min_ctc_lpa != null && <><br />Min CTC {lpa(i.min_ctc_lpa)}</>}</>}</Td>
                  <Td className="text-[12.5px] text-[var(--text-secondary)] max-w-xs">{i.note}{i.pending_offers > 0 && <><br /><Badge tone="review">{i.pending_offers} pending offer</Badge></>}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}

// ----------------------------------------------------------------------------------------------------------- review

export function ReviewPage({ role }: { role: StaffRole }) {
  const toast = useToast();
  const [tab, setTab] = useState<"open" | "closed">("open");
  const list = useApi<ReviewItem[]>(`/review?status=${tab}`);
  const [sel, setSel] = useState<ReviewItem | null>(null);
  const kinds: Record<string, string> = { engine_review: "Policy review", absenteeism: "Absenteeism", violation: "Suspected violation", expired_offer: "Expired offer", missing_noc: "Missing NOC" };
  return (
    <Page>
      <PageHeader title="Review queue" subtitle={role === "placement_officer" ? "REVIEW decisions, absenteeism flags, suspected violations and expired offers. Approve an exception or confirm the block, with a written reason." : "What is waiting for the Placement Officer in your programme. Read-only for coordinators."} />
      <Tabs label="Queue" value={tab} onChange={setTab} tabs={[{ id: "open", label: "Open", count: tab === "open" ? list.data?.length : undefined }, { id: "closed", label: "Closed" }]} />
      <ErrorBanner error={list.error} />
      <Card>
        {list.loading && !list.data ? <Spinner /> : !list.data?.length ? <EmptyState title={tab === "open" ? "Nothing waiting" : "No closed cases"} /> : (
          <ul className="divide-y divide-[var(--surface-border)]">
            {list.data.map((c) => (
              <li key={c.id} className="px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap"><Badge tone={c.kind === "violation" ? "block" : "review"}>{kinds[c.kind]}</Badge>{c.student && <span className="text-sm font-medium text-[var(--text-primary)]">{c.student.name} <span className="text-[12px] text-[var(--text-tertiary)] tabular">{c.student.placement_id} · {c.student.programme_code}</span></span>}</div>
                  <p className="mt-1 text-[13px] text-[var(--text-secondary)]">{c.summary}</p>
                  {c.resolution_reason && <p className="mt-1 text-[12px] text-[var(--text-tertiary)]">{c.status}: {c.resolution_reason}</p>}
                </div>
                <div className="flex items-center gap-3 shrink-0"><span className="text-[12px] text-[var(--text-tertiary)]">{relative(c.opened_at)}</span>{role === "placement_officer" && c.status === "open" && !c.id.startsWith("noc:") && <Button size="sm" onClick={() => setSel(c)}>Decide</Button>}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {sel && <Resolve item={sel} onClose={() => setSel(null)} onDone={() => { setSel(null); toast.success("Decision recorded."); void list.reload(); }} />}
    </Page>
  );
}

function Resolve({ item, onClose, onDone }: { item: ReviewItem; onClose: () => void; onDone: () => void }) {
  const canApprove = item.kind === "engine_review" || item.kind === "absenteeism";
  const [action, setAction] = useState(canApprove ? "approve" : "resolve");
  const [reason, setReason] = useState("");
  const act = useAction();
  async function save() {
    let ok = false;
    await act.run(async () => { await post(`/review/${item.id}/resolve`, { action, reason }); ok = true; });
    if (ok) onDone();
  }
  return (
    <Modal open onClose={onClose} title="Decide this case" description={item.summary} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={act.busy || reason.trim().length < 10} onClick={() => void save()}>Record decision</Button></>}>
      <div className="space-y-4">
        {item.fired_rules && item.fired_rules.length > 0 && <PolicyExplain decision={toPolicyDecision({ result: "REVIEW", summary: item.summary, fired_rules: item.fired_rules })} />}
        <SelectField label="Decision" value={action} onChange={(e) => setAction(e.target.value)}>
          {canApprove && <option value="approve">Approve — record an exception (30 days)</option>}
          <option value="confirm_block">Confirm the block</option>
          <option value="resolve">Resolve / acknowledge</option>
        </SelectField>
        <TextAreaField label="Written reason (min. 10 characters)" value={reason} onChange={(e) => setReason(e.target.value)} />
        <ErrorBanner error={act.error} />
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------------------------- exceptions

interface ExReq { id: string; rule_code: string; reason: string; requested_at: string; student: { id: string; name: string; placement_id: string; programme_code: string } | null }

export function ExceptionsPage({ role }: { role: StaffRole }) {
  const toast = useToast();
  const [tab, setTab] = useState<"active" | "requests">(role === "coordinator" ? "requests" : "active");
  const ex = useApi<ExceptionRow[]>("/exceptions");
  const reqs = useApi<ExReq[]>("/exceptions/requests");
  const [open, setOpen] = useState(false);
  const officer = role === "placement_officer";

  async function decide(id: string, approve: boolean) {
    try { await post(`/exceptions/requests/${id}/decide`, { approve }); toast.success(approve ? "Approved: exception recorded." : "Rejected."); await Promise.all([reqs.reload(), ex.reload()]); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }
  async function revoke(id: string) {
    const reason = window.prompt("Reason for revoking this exception (min. 5 characters):");
    if (!reason || reason.trim().length < 5) return;
    try { await del(`/exceptions/${id}`, { reason }); toast.success("Exception revoked."); await ex.reload(); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  return (
    <Page>
      <PageHeader title="Exceptions" subtitle={officer ? "Policy overrides. Only a Placement Officer records one, always with a reason and an expiry; the engine then shows ALLOW (exception #id)." : "Ask the Placement Officer to approve an exception for one of your students."} actions={<Button size="sm" onClick={() => setOpen(true)}><ShieldAlert size={14} aria-hidden /> {officer ? "Record exception" : "Request exception"}</Button>} />
      <Tabs label="Exceptions" value={tab} onChange={setTab} tabs={[{ id: "active", label: "Exceptions" }, { id: "requests", label: "Requests", count: reqs.data?.length }]} />
      <Card>
        {tab === "active" ? (
          ex.loading && !ex.data ? <Spinner /> : !ex.data?.length ? <EmptyState title="No exceptions recorded" /> : (
            <Table caption="Exceptions"><THead cols={["Student", "Rule", "Reason", "Expires", "State", ""]} /><tbody>
              {ex.data.map((e) => (
                <Tr key={e.id}><Td>{e.student.name}<br /><span className="text-[12px] text-[var(--text-tertiary)] tabular">{e.student.placement_id}</span></Td><Td className="whitespace-nowrap">{RULE_NAMES[e.rule_code] ?? e.rule_code}</Td><Td className="max-w-xs text-[var(--text-secondary)]">{e.reason}</Td><Td className="tabular whitespace-nowrap">{fmtShortDate(e.expires_at)}</Td><Td>{e.revoked_at ? <Badge tone="block">Revoked</Badge> : e.active ? <Badge tone="allow">Active</Badge> : <Badge>Expired</Badge>}</Td><Td className="text-right">{officer && e.active && <Button size="sm" variant="danger" onClick={() => void revoke(e.id)}>Revoke</Button>}</Td></Tr>
              ))}
            </tbody></Table>
          )
        ) : reqs.loading && !reqs.data ? <Spinner /> : !reqs.data?.length ? <EmptyState title="No pending requests" /> : (
          <Table caption="Exception requests"><THead cols={["Student", "Rule", "Reason", "Requested", ""]} /><tbody>
            {reqs.data.map((r) => (
              <Tr key={r.id}><Td>{r.student?.name}<br /><span className="text-[12px] text-[var(--text-tertiary)] tabular">{r.student?.placement_id}</span></Td><Td>{RULE_NAMES[r.rule_code] ?? r.rule_code}</Td><Td className="max-w-xs text-[var(--text-secondary)]">{r.reason}</Td><Td className="tabular text-[var(--text-tertiary)]">{relative(r.requested_at)}</Td><Td className="text-right whitespace-nowrap">{officer ? <><Button size="sm" onClick={() => void decide(r.id, true)}>Approve</Button> <Button size="sm" variant="danger" onClick={() => void decide(r.id, false)}>Reject</Button></> : <Badge tone="review">Waiting</Badge>}</Td></Tr>
            ))}
          </tbody></Table>
        )}
      </Card>
      <ExceptionForm open={open} officer={officer} onClose={() => setOpen(false)} onDone={() => { setOpen(false); toast.success(officer ? "Exception recorded." : "Request sent to the Placement Officer."); void ex.reload(); void reqs.reload(); }} />
    </Page>
  );
}

function ExceptionForm({ open, officer, onClose, onDone }: { open: boolean; officer: boolean; onClose: () => void; onDone: () => void }) {
  const [student, setStudent] = useState<StudentRow | null>(null);
  const [rule, setRule] = useState("R4");
  const [reason, setReason] = useState("");
  const [days, setDays] = useState("30");
  const act = useAction();
  async function save() {
    let ok = false;
    await act.run(async () => {
      if (officer) await post("/exceptions", { student_id: student!.id, rule_code: rule, reason, expires_at: new Date(Date.now() + Number(days) * 86_400_000).toISOString() });
      else await post("/exceptions/requests", { student_id: student!.id, rule_code: rule, reason });
      ok = true;
    });
    if (ok) { setStudent(null); setReason(""); onDone(); }
  }
  return (
    <Modal open={open} onClose={onClose} title={officer ? "Record an exception" : "Request an exception"} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={act.busy || !student || reason.trim().length < 10} onClick={() => void save()}>{officer ? "Record" : "Send request"}</Button></>}>
      <div className="space-y-4">
        <StudentPicker value={student} onChange={setStudent} />
        <SelectField label="Rule to override" value={rule} onChange={(e) => setRule(e.target.value)}>{Object.entries(RULE_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</SelectField>
        {officer && <SelectField label="Valid for" value={days} onChange={(e) => setDays(e.target.value)}><option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option><option value="180">180 days</option></SelectField>}
        <TextAreaField label="Written reason (min. 10 characters)" value={reason} onChange={(e) => setReason(e.target.value)} hint="e.g. which emergency, and how it was verified" />
        <ErrorBanner error={act.error} />
      </div>
    </Modal>
  );
}
