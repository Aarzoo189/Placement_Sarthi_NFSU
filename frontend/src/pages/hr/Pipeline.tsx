import { Upload } from "lucide-react";
import { useRef, useState } from "react";
import { Badge, StatusPill } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { SelectField, TextAreaField, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { Page, PageHeader } from "../../components/ui/PageHeader";
import { StatTile } from "../../components/ui/StatTile";
import { AppStatusBadge } from "../../components/ui/StatusBadge";
import { Banner, EmptyState, ErrorBanner, Spinner } from "../../components/ui/States";
import { Table, Td, THead, Tr } from "../../components/ui/Table";
import { useToast } from "../../components/ui/Toast";
import { packageText } from "../../components/student/DriveItem";
import { errorMessage, post, upload } from "../../lib/api";
import { fmtShortDate, lpa } from "../../lib/format";
import type { Drive, Offer, StudentRow } from "../../lib/models";
import { useAction, useApi } from "../../lib/use-api";
import { Award, ClipboardList, Users } from "lucide-react";

interface Pipeline { drive: Drive; counts: Record<string, number>; applicants: { application_id: string; stage: string; student: StudentRow }[]; offers: Offer[] }

/**
 * Company HR sees ONLY applicants of their own drive, with a masked view (name, programme, CGPA, resume) until a student is
 * shortlisted. The server enforces that; this page renders what it is given.
 */
export function HrPipeline() {
  const toast = useToast();
  const drives = useApi<Drive[]>("/drives");
  const [driveId, setDriveId] = useState("");
  const id = driveId || drives.data?.[0]?.id || null;
  const pipe = useApi<Pipeline>(id ? `/dashboards/drive-pipeline/${id}` : null);
  const [propose, setPropose] = useState<StudentRow | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const [uploadStage, setUploadStage] = useState<"shortlisted" | "selected" | "rejected">("shortlisted");
  const act = useAction();

  async function stage(studentId: string, s: string) {
    try {
      const r = await post<{ failed: { reason: string }[] }>(`/drives/${id}/stage`, { student_ids: [studentId], stage: s });
      if (r.failed.length) toast.error(r.failed[0]!.reason); else toast.success(`Moved to ${s}.`);
      await pipe.reload();
    } catch (e) { toast.error(errorMessage(e)); }
  }

  async function uploadCsv(f: File | undefined) {
    if (!f || !id) return;
    const r = await act.run(() => upload<{ updated: number; failed: unknown[]; not_applicants: string[] }>(`/drives/${id}/stage-upload?stage=${uploadStage}`, f));
    if (r) { toast.success(`${r.updated} updated. ${r.failed.length} could not be moved; ${r.not_applicants.length} IDs did not apply to this drive.`); await pipe.reload(); }
  }

  if (drives.loading && !drives.data) return <Spinner />;
  if (!drives.data?.length) return <Page><PageHeader title="Drive pipeline" /><EmptyState title="No drive is linked to your account">The Placement Officer invites you to a specific drive. Your account expires when the drive closes.</EmptyState></Page>;
  const p = pipe.data;

  return (
    <Page>
      <PageHeader
        title={p ? `${p.drive.company} — ${p.drive.title}` : "Drive pipeline"}
        subtitle={p ? `${packageText(p.drive)} · status ${p.drive.status}` : undefined}
        actions={drives.data.length > 1 && <div className="w-56"><SelectField label="Drive" value={id ?? ""} onChange={(e) => setDriveId(e.target.value)}>{drives.data.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}</SelectField></div>}
      />
      <ErrorBanner error={pipe.error} />
      {pipe.loading && !p ? <Spinner /> : p && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatTile label="Applicants" value={Object.entries(p.counts).filter(([k]) => k !== "rejected").reduce((a, [, n]) => a + n, 0)} icon={Users} />
            <StatTile label="Shortlisted" value={p.counts.shortlisted ?? 0} icon={ClipboardList} tone="accent" />
            <StatTile label="Selected" value={p.counts.selected ?? 0} icon={Award} />
            <StatTile label="Offers proposed / made" value={p.offers.length} icon={Award} />
          </div>
          <Banner tone="info">Student contact details are hidden until you shortlist a student. You see only name, programme, CGPA and resume for applicants of this drive.</Banner>

          <Card>
            <CardHeader
              title="Applicants"
              action={
                <div className="flex items-center gap-2">
                  <select aria-label="Result type" value={uploadStage} onChange={(e) => setUploadStage(e.target.value as typeof uploadStage)} className="h-8 px-2 text-[13px] rounded-[var(--radius-sm)] border border-[var(--surface-border-strong)] bg-[var(--surface-2)]"><option value="shortlisted">Shortlist</option><option value="selected">Final selection</option><option value="rejected">Rejections</option></select>
                  <input ref={file} type="file" accept=".csv,text/csv,text/plain" className="sr-only" aria-label="CSV of Placement IDs" onChange={(e) => { void uploadCsv(e.target.files?.[0]); e.target.value = ""; }} />
                  <Button size="sm" variant="secondary" disabled={act.busy} onClick={() => file.current?.click()}><Upload size={14} aria-hidden /> Upload CSV of IDs</Button>
                </div>
              }
            />
            <div className="px-5 pt-3"><ErrorBanner error={act.error} /></div>
            {p.applicants.length === 0 ? <EmptyState title="No applicants yet" /> : (
              <Table caption="Applicants">
                <THead cols={["Student", "Programme", "CGPA", "Contact", "Stage", ""]} />
                <tbody>
                  {p.applicants.map((a) => (
                    <Tr key={a.application_id}>
                      <Td className="font-medium text-[var(--text-primary)]">{a.student.name}{a.student.has_resume && <Badge tone="brand">Resume</Badge>}</Td>
                      <Td>{a.student.programme_code}</Td>
                      <Td className="tabular">{a.student.cgpa ?? "—"}</Td>
                      <Td className="text-[12.5px]">{a.student.masked ? <span className="text-[var(--text-tertiary)]">Hidden until shortlist</span> : <>{a.student.email}<br />{a.student.mobile}</>}</Td>
                      <Td><AppStatusBadge status={a.stage} /></Td>
                      <Td className="text-right whitespace-nowrap">
                        {a.stage === "applied" && <Button size="sm" onClick={() => void stage(a.student.id, "shortlisted")}>Shortlist</Button>}
                        {a.stage === "shortlisted" && <Button size="sm" onClick={() => void stage(a.student.id, "selected")}>Select</Button>}
                        {a.stage === "selected" && !p.offers.some((o) => o.student.id === a.student.id) && <Button size="sm" variant="secondary" onClick={() => setPropose(a.student)}>Propose offer</Button>}
                        {["applied", "shortlisted"].includes(a.stage) && <Button size="sm" variant="danger" onClick={() => void stage(a.student.id, "rejected")}>Reject</Button>}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          <Card>
            <CardHeader title="Offers" subtitle="You propose; the Placement Officer confirms; the student accepts or declines." />
            {p.offers.length === 0 ? <EmptyState title="No confirmed offers yet" /> : (
              <Table caption="Offers"><THead cols={["Student", "Package", "Deadline", "Status"]} /><tbody>
                {p.offers.map((o) => <Tr key={o.id}><Td>{o.student.name}</Td><Td className="tabular">{o.ctc_lpa != null ? lpa(o.ctc_lpa) : ""}</Td><Td className="tabular">{fmtShortDate(o.deadline)}</Td><Td><StatusPill value={o.acceptance_status} /></Td></Tr>)}
              </tbody></Table>
            )}
          </Card>
        </>
      )}
      {propose && id && p && <ProposeOffer driveId={id} drive={p.drive} student={propose} onClose={() => setPropose(null)} onDone={() => { setPropose(null); toast.success("Proposal sent to the Placement Officer for confirmation."); void pipe.reload(); }} />}
    </Page>
  );
}

function ProposeOffer({ driveId, drive, student, onClose, onDone }: { driveId: string; drive: Drive; student: StudentRow; onClose: () => void; onDone: () => void }) {
  const [ctc, setCtc] = useState(drive.ctc_lpa != null ? String(drive.ctc_lpa) : "");
  const [stipend, setStipend] = useState(drive.stipend_amount != null ? String(drive.stipend_amount) : "");
  const [note, setNote] = useState("");
  const act = useAction();
  async function save() {
    let ok = false;
    await act.run(async () => { await post("/offers/proposals", { drive_id: driveId, student_id: student.id, ctc_lpa: drive.offer_type === "I" ? null : Number(ctc), stipend_amount: drive.offer_type === "F" || !stipend ? null : Number(stipend), ...(note && { note }) }); ok = true; });
    if (ok) onDone();
  }
  return (
    <Modal open onClose={onClose} title={`Propose an offer to ${student.name}`} description="Needs your second factor. The Placement Officer must confirm before the student sees it." size="sm" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={act.busy || (drive.offer_type !== "I" && !Number(ctc))} onClick={() => void save()}>Send proposal</Button></>}>
      <div className="space-y-4">
        {drive.offer_type !== "I" && <TextField label="CTC (LPA)" value={ctc} onChange={(e) => setCtc(e.target.value)} inputMode="decimal" />}
        {drive.offer_type !== "F" && <TextField label="Stipend (₹)" value={stipend} onChange={(e) => setStipend(e.target.value)} inputMode="numeric" />}
        <TextAreaField label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <ErrorBanner error={act.error} />
      </div>
    </Modal>
  );
}
