import { Download, FileSpreadsheet, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Pager } from "../../components/staff/parts";
import { Badge, StatusPill } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { FilterInput, FilterSelect, TextAreaField, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Page, PageHeader } from "../../components/ui/PageHeader";
import { Banner, EmptyState, ErrorBanner, Spinner } from "../../components/ui/States";
import { Table, Td, THead, Tr } from "../../components/ui/Table";
import { useToast } from "../../components/ui/Toast";
import { download, errorMessage, get, post, saveBlob } from "../../lib/api";
import { fmtDate, fmtFullDateTime } from "../../lib/format";
import type { AuditRow, Page as Paged, PolicyParams, PolicyVersion } from "../../lib/models";
import { useAction, useApi } from "../../lib/use-api";

const describe = (p: PolicyParams) => `A+ ≥ ₹${p.thresholds.aPlusMin} LPA · A ≥ ₹${p.thresholds.aMin} · B ≥ ₹${p.thresholds.bMin} · B→next ≥ ${p.switchB.multiplier}× · absence window ${p.absenteeism.lastDrives} drives · acceptance ${p.acceptance.hours} h`;

// ------------------------------------------------------------------------------------------------------------ policy

/**
 * Policy rules live in a versioned table, not in code. Changing them takes two people: the Placement Officer proposes, a Super
 * Admin who did NOT propose it approves and publishes. Every engine decision records the version that produced it.
 */
export function PolicyPage({ mode }: { mode: "officer" | "superadmin" }) {
  const toast = useToast();
  const versions = useApi<PolicyVersion[]>("/policy/versions");
  const [open, setOpen] = useState(false);
  const cur = versions.data?.find((v) => v.status === "published");

  async function act(version: number, what: "publish" | "reject") {
    try {
      if (what === "publish") await post(`/policy/${version}/publish`);
      else {
        const reason = window.prompt("Reason for rejecting this proposal (min. 5 characters):");
        if (!reason || reason.trim().length < 5) return;
        await post(`/policy/${version}/reject`, { reason });
      }
      toast.success(what === "publish" ? `Version ${version} is now in force. Placement state is being recomputed.` : "Proposal rejected.");
      await versions.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <Page>
      <PageHeader
        title={mode === "superadmin" ? "Policy approval" : "Policy rules"}
        subtitle={mode === "superadmin" ? "Approve and publish a change proposed by someone else (the four-eyes rule). You cannot publish your own proposal." : "The thresholds below drive every ALLOW / BLOCK / REVIEW decision. Propose a change; a Super Admin approves it."}
        actions={mode === "officer" && <Button size="sm" onClick={() => setOpen(true)}>Propose a change</Button>}
      />
      <ErrorBanner error={versions.error} />
      {cur && (
        <Card>
          <CardHeader title={`In force: version ${cur.version}`} subtitle={cur.note ?? undefined} />
          <div className="p-5 grid sm:grid-cols-2 lg:grid-cols-4 gap-4 text-sm">
            <div><p className="text-[12px] text-[var(--text-tertiary)]">Category bands (CTC)</p><p className="mt-0.5 tabular">A+ ≥ ₹{cur.params.thresholds.aPlusMin} LPA<br />A ₹{cur.params.thresholds.aMin} – {cur.params.thresholds.aPlusMin}<br />B ₹{cur.params.thresholds.bMin} – {cur.params.thresholds.aMin}<br />C &lt; ₹{cur.params.thresholds.bMin}</p></div>
            <div><p className="text-[12px] text-[var(--text-tertiary)]">Category B switching</p><p className="mt-0.5">New CTC ≥ {cur.params.switchB.multiplier} × current</p></div>
            <div><p className="text-[12px] text-[var(--text-tertiary)]">Absenteeism</p><p className="mt-0.5">Unexcused absence in the last {cur.params.absenteeism.lastDrives} drives blocks</p></div>
            <div><p className="text-[12px] text-[var(--text-tertiary)]">Offer acceptance</p><p className="mt-0.5">Earlier of {cur.params.acceptance.hours} h and the company deadline</p></div>
          </div>
        </Card>
      )}
      <Card>
        <CardHeader title="All versions" />
        {versions.loading && !versions.data ? <Spinner /> : (
          <Table caption="Policy versions">
            <THead cols={["Version", "Status", "Rules", "Why", "Created", ""]} />
            <tbody>
              {versions.data?.map((v) => (
                <Tr key={v.version}>
                  <Td className="tabular font-medium">v{v.version}</Td>
                  <Td><StatusPill value={v.status} /></Td>
                  <Td className="text-[12.5px] text-[var(--text-secondary)] max-w-md">{describe(v.params)}</Td>
                  <Td className="text-[12.5px] max-w-xs">{v.note}</Td>
                  <Td className="tabular text-[var(--text-tertiary)]">{fmtDate(v.created_at)}</Td>
                  <Td className="text-right whitespace-nowrap">{mode === "superadmin" && v.status === "proposed" && <><Button size="sm" onClick={() => void act(v.version, "publish")}>Approve & publish</Button> <Button size="sm" variant="danger" onClick={() => void act(v.version, "reject")}>Reject</Button></>}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {cur && <Propose open={open} base={cur.params} onClose={() => setOpen(false)} onDone={() => { setOpen(false); toast.success("Proposal sent to the Super Admin for approval."); void versions.reload(); }} />}
    </Page>
  );
}

function Propose({ open, base, onClose, onDone }: { open: boolean; base: PolicyParams; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ a: String(base.thresholds.aPlusMin), b: String(base.thresholds.aMin), c: String(base.thresholds.bMin), m: String(base.switchB.multiplier), d: String(base.absenteeism.lastDrives), h: String(base.acceptance.hours), note: "" });
  const act = useAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  async function save() {
    let ok = false;
    await act.run(async () => {
      await post("/policy/propose", { params: { thresholds: { aPlusMin: Number(f.a), aMin: Number(f.b), bMin: Number(f.c) }, switchB: { multiplier: Number(f.m) }, absenteeism: { lastDrives: Number(f.d) }, acceptance: { hours: Number(f.h) } }, note: f.note });
      ok = true;
    });
    if (ok) onDone();
  }
  return (
    <Modal open={open} onClose={onClose} title="Propose a policy change" description="Nothing changes until a Super Admin approves it. Needs your second factor." size="lg" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={act.busy || f.note.trim().length < 5} onClick={() => void save()}>Send proposal</Button></>}>
      <div className="grid sm:grid-cols-3 gap-4">
        <TextField label="A+ from (LPA)" value={f.a} onChange={set("a")} inputMode="decimal" />
        <TextField label="A from (LPA)" value={f.b} onChange={set("b")} inputMode="decimal" />
        <TextField label="B from (LPA)" value={f.c} onChange={set("c")} inputMode="decimal" />
        <TextField label="Category B multiplier" value={f.m} onChange={set("m")} inputMode="decimal" hint="New CTC must be at least this × current" />
        <TextField label="Absenteeism window (drives)" value={f.d} onChange={set("d")} inputMode="numeric" />
        <TextField label="Acceptance window (hours)" value={f.h} onChange={set("h")} inputMode="numeric" />
        <div className="sm:col-span-3"><TextAreaField label="Why is the policy changing?" value={f.note} onChange={set("note")} /></div>
      </div>
      <div className="mt-4"><ErrorBanner error={act.error} /></div>
    </Modal>
  );
}

// ----------------------------------------------------------------------------------------------------------- exports

interface ExportLog { id: string; kind: string; row_count: number; file_hash: string; at: string }

export function ExportsPage({ role }: { role: "coordinator" | "placement_officer" | "super_admin" }) {
  const toast = useToast();
  const log = useApi<ExportLog[]>(role === "coordinator" ? null : "/exports/log");
  const [busy, setBusy] = useState<string | null>(null);
  const [last, setLast] = useState<{ name: string; rows: number; sha: string | null } | null>(null);

  async function run(label: string, path: string) {
    setBusy(label);
    try {
      const r = await download(path);
      saveBlob(r.blob, r.filename);
      setLast({ name: r.filename, rows: r.rows, sha: r.sha256 });
      toast.success(`${r.filename} downloaded.`);
      await log.reload();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  const items: { id: string; title: string; text: string; path: string }[] = role === "super_admin"
    ? [{ id: "sum", title: "Aggregate summary", text: "Counts and CTC / stipend statistics only. No names, no IDs.", path: "/exports/summary" }]
    : [
        { id: "stu", title: role === "coordinator" ? "Students (masked, own programme)" : "Students", text: role === "coordinator" ? "E-mail and mobile are masked in your export." : "Full student register with placement status and category.", path: "/exports/students" },
        { id: "off", title: role === "coordinator" ? "Offers (masked)" : "Offers", text: role === "coordinator" ? "Exact CTC and stipend are masked for coordinators." : "FTE CTC (LPA) and internship stipend are separate columns, never combined.", path: "/exports/offers" },
        ...(role === "placement_officer" ? [{ id: "sum", title: "Aggregate summary", text: "Counts and statistics only.", path: "/exports/summary" }] : []),
      ];

  return (
    <Page>
      <PageHeader title="Exports" subtitle="Every export needs your second factor, carries a watermark with your name and the time, and is logged with its row count and file hash." />
      <div className="grid md:grid-cols-2 gap-4">
        {items.map((it) => (
          <Card key={it.id}>
            <CardHeader title={it.title} subtitle={it.text} />
            <div className="p-5 flex gap-2">
              <Button size="sm" disabled={!!busy} onClick={() => void run(it.id + "csv", `${it.path}?format=csv`)}><Download size={14} aria-hidden /> {busy === it.id + "csv" ? "Preparing…" : "CSV"}</Button>
              <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void run(it.id + "xlsx", `${it.path}?format=xlsx`)}><FileSpreadsheet size={14} aria-hidden /> {busy === it.id + "xlsx" ? "Preparing…" : "Excel"}</Button>
            </div>
          </Card>
        ))}
      </div>
      {last && <Banner tone="success"><strong>{last.name}</strong> · {last.rows} rows · SHA-256 <span className="font-mono text-[11px] break-all">{last.sha}</span></Banner>}
      {role !== "coordinator" && (
        <Card>
          <CardHeader title="Export log" subtitle={role === "placement_officer" ? "Your exports" : "All exports"} />
          {!log.data?.length ? <EmptyState title="No exports yet" /> : (
            <Table caption="Export log"><THead cols={["When", "Kind", "Rows", "File SHA-256"]} /><tbody>
              {log.data.map((l) => <Tr key={l.id}><Td className="tabular whitespace-nowrap">{fmtFullDateTime(l.at)}</Td><Td>{l.kind}</Td><Td className="tabular">{l.row_count}</Td><Td className="font-mono text-[11px] break-all">{l.file_hash.slice(0, 32)}…</Td></Tr>)}
            </tbody></Table>
          )}
        </Card>
      )}
    </Page>
  );
}

// ------------------------------------------------------------------------------------------------------------- audit

export function AuditPage({ role }: { role: "placement_officer" | "super_admin" }) {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState("");
  const [alerts, setAlerts] = useState(false);
  const [sel, setSel] = useState<AuditRow | null>(null);
  const qs = new URLSearchParams({ page: String(page), page_size: "30" });
  if (action.trim()) qs.set("action", action.trim());
  if (alerts) qs.set("alerts_only", "true");
  const list = useApi<Paged<AuditRow>>(`/audit?${qs}`);
  const verify = useAction();
  const [result, setResult] = useState<{ ok: boolean; checked: number; broken_at?: string; reason?: string } | null>(null);

  return (
    <Page>
      <PageHeader
        title={role === "super_admin" ? "Audit & integrity" : "Audit log"}
        subtitle={role === "super_admin" ? "Every sensitive read and write, hash-chained so edits and deletions are detectable." : "Your own actions and the operational activity of coordinators, students and company users."}
        actions={role === "super_admin" && <Button size="sm" disabled={verify.busy} onClick={async () => { const r = await verify.run(() => get<NonNullable<typeof result>>("/audit/verify")); if (r) setResult(r); }}><ShieldCheck size={14} aria-hidden /> {verify.busy ? "Checking chain…" : "Verify hash chain"}</Button>}
      />
      {result && (result.ok ? <Banner tone="success">Chain intact: {result.checked.toLocaleString()} entries verified, no edits or deletions found.</Banner> : <Banner tone="error"><strong>Tampering detected</strong> at entry #{result.broken_at}: {result.reason}. Entries checked before the break: {result.checked}.</Banner>)}
      <ErrorBanner error={verify.error} />
      <Card>
        <div className="flex flex-wrap items-center gap-2 p-4 border-b border-[var(--surface-border)]">
          <FilterInput aria-label="Filter by action" placeholder="Action contains… e.g. LOGIN, EXPORT" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} className="w-64" />
          <FilterSelect aria-label="Alerts" value={alerts ? "1" : ""} onChange={(e) => { setAlerts(!!e.target.value); setPage(1); }}><option value="">All entries</option><option value="1">Alerts only</option></FilterSelect>
        </div>
        <ErrorBanner error={list.error} />
        {list.loading && !list.data ? <Spinner /> : !list.data?.items.length ? <EmptyState title="No entries" /> : (
          <>
            <Table caption="Audit log">
              <THead cols={["#", "When", "Role", "Action", "Entity", "IP", ""]} />
              <tbody>
                {list.data.items.map((r) => (
                  <Tr key={r.id}>
                    <Td className="tabular text-[var(--text-tertiary)]">{r.id}</Td>
                    <Td className="tabular whitespace-nowrap">{fmtFullDateTime(r.at)}</Td>
                    <Td>{r.role ?? "—"}</Td>
                    <Td className="font-mono text-[12px]">{r.action}{r.meta && (r.meta as { alert?: boolean }).alert && <> <Badge tone="block">alert</Badge></>}</Td>
                    <Td className="text-[12px] text-[var(--text-secondary)] max-w-[14rem] truncate">{r.entity}{r.entity_id ? ` · ${r.entity_id}` : ""}</Td>
                    <Td className="tabular text-[12px] text-[var(--text-tertiary)]">{r.ip}</Td>
                    <Td className="text-right"><Button size="sm" variant="ghost" onClick={() => setSel(r)}>Details</Button></Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <Pager page={list.data.page} pageSize={list.data.page_size} total={list.data.total} onChange={setPage} />
          </>
        )}
      </Card>
      <Modal open={!!sel} onClose={() => setSel(null)} title={sel?.action ?? ""} description={sel ? fmtFullDateTime(sel.at) : undefined} size="lg">
        {sel && <pre className="text-[12px] font-mono whitespace-pre-wrap break-words rounded-[var(--radius-sm)] bg-[var(--surface-1)] p-3 border border-[var(--surface-border)]">{JSON.stringify({ actor_id: sel.actor_id, role: sel.role, entity: sel.entity, entity_id: sel.entity_id, before: sel.before, after: sel.after, meta: sel.meta, ip: sel.ip, hash_prefix: sel.hash }, null, 2)}</pre>}
      </Modal>
    </Page>
  );
}
