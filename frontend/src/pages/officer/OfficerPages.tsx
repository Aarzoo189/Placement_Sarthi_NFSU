import { useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Page, PageHeader } from "../../components/ui/PageHeader";
import { EmptyState, ErrorBanner, Spinner } from "../../components/ui/States";
import { Table, Td, THead, Tr } from "../../components/ui/Table";
import { useToast } from "../../components/ui/Toast";
import { errorMessage, post } from "../../lib/api";
import { inr, lpa, OFFER_TYPE, relative } from "../../lib/format";
import type { Stats } from "../../lib/models";
import { useApi } from "../../lib/use-api";

interface Proposal { id: string; drive: { id: string; title: string; company: string; offer_type: string }; student: { id: string; name: string; placement_id: string; programme_code: string } | null; ctc_lpa: number | null; stipend_amount: number | null; note: string | null; proposed_at: string }

/** HR proposes; the Placement Officer confirms, which creates the offer with its acceptance deadline (earlier of 24 h and the company's). */
export function ProposalsPage() {
  const toast = useToast();
  const list = useApi<Proposal[]>("/offers/proposals");
  const [busy, setBusy] = useState<string | null>(null);

  async function confirm(p: Proposal) {
    setBusy(p.id);
    try {
      const r = await post<{ deadline: string }>(`/offers/proposals/${p.id}/confirm`);
      toast.success(`Offer confirmed. The student must respond by ${new Date(r.deadline).toLocaleString("en-IN")}.`);
      await list.reload();
    } catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  }
  async function reject(p: Proposal) {
    const reason = window.prompt("Why are you rejecting this proposal? (min. 5 characters)");
    if (!reason || reason.trim().length < 5) return;
    try { await post(`/offers/proposals/${p.id}/reject`, { reason }); toast.success("Proposal rejected."); await list.reload(); } catch (e) { toast.error(errorMessage(e)); }
  }

  return (
    <Page>
      <PageHeader title="Offer proposals" subtitle="Companies propose offers for students they selected. Nothing is binding until you confirm it. Confirming needs your second factor." />
      <ErrorBanner error={list.error} />
      <Card>
        {list.loading && !list.data ? <Spinner /> : !list.data?.length ? <EmptyState title="No proposals waiting" /> : (
          <Table caption="Offer proposals">
            <THead cols={["Student", "Company / drive", "Type", "Package", "Note", "Proposed", ""]} />
            <tbody>
              {list.data.map((p) => (
                <Tr key={p.id}>
                  <Td>{p.student?.name}<br /><span className="text-[12px] text-[var(--text-tertiary)] tabular">{p.student?.placement_id} · {p.student?.programme_code}</span></Td>
                  <Td>{p.drive.company}<br /><span className="text-[12px] text-[var(--text-tertiary)]">{p.drive.title}</span></Td>
                  <Td>{OFFER_TYPE[p.drive.offer_type]}</Td>
                  <Td className="tabular whitespace-nowrap">{p.ctc_lpa != null ? lpa(p.ctc_lpa) : ""}{p.stipend_amount != null ? <><br />{inr(p.stipend_amount)} stipend</> : ""}</Td>
                  <Td className="max-w-xs text-[12.5px] text-[var(--text-secondary)]">{p.note}</Td>
                  <Td className="tabular text-[var(--text-tertiary)]">{relative(p.proposed_at)}</Td>
                  <Td className="text-right whitespace-nowrap"><Button size="sm" disabled={busy === p.id} onClick={() => void confirm(p)}>Confirm</Button> <Button size="sm" variant="danger" onClick={() => void reject(p)}>Reject</Button></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}

interface CompanyRow { company: string; offers_made: number; accepted: number; pending: number; declined: number; expired: number; types: Record<string, number>; categories: string[]; ctc_lpa: Stats; stipend: Stats }

export function CompanyReportPage() {
  const list = useApi<CompanyRow[]>("/dashboards/companies");
  return (
    <Page>
      <PageHeader title="Company report" subtitle="Offers, categories and packages per company. CTC (LPA) and internship stipend (₹) are separate columns and are never combined." />
      <ErrorBanner error={list.error} />
      <Card>
        {list.loading && !list.data ? <Spinner /> : !list.data?.length ? <EmptyState title="No offers yet" /> : (
          <Table caption="Company-wise offers">
            <THead cols={["Company", "Offers", "Accepted", "Pending", "Declined / expired", "Types (I / F / I+F)", "Categories", "FTE CTC (avg / max)", "Stipend (avg / max)"]} />
            <tbody>
              {list.data.map((c) => (
                <Tr key={c.company}>
                  <Td className="font-medium text-[var(--text-primary)]">{c.company}</Td>
                  <Td className="tabular">{c.offers_made}</Td>
                  <Td className="tabular">{c.accepted}</Td>
                  <Td className="tabular">{c.pending}</Td>
                  <Td className="tabular">{c.declined} / {c.expired}</Td>
                  <Td className="tabular">{c.types.I} / {c.types.F} / {c.types.IF}</Td>
                  <Td>{c.categories.map((x) => <Badge key={x}>{x}</Badge>)}</Td>
                  <Td className="tabular whitespace-nowrap">{c.ctc_lpa.count ? `${lpa(c.ctc_lpa.average)} / ${lpa(c.ctc_lpa.highest)}` : "—"}</Td>
                  <Td className="tabular whitespace-nowrap">{c.stipend.count ? `${inr(c.stipend.average)} / ${inr(c.stipend.highest)}` : "—"}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </Page>
  );
}
