import { Check, X } from "lucide-react";
import { useState } from "react";
import { DriveItem } from "../../components/student/DriveItem";
import { Badge, CategoryBadge, StatusPill } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { Modal } from "../../components/ui/Modal";
import { Page, PageHeader } from "../../components/ui/PageHeader";
import { PolicyExplain } from "../../components/ui/PolicyExplain";
import { AppStatusBadge } from "../../components/ui/StatusBadge";
import { Banner, EmptyState, ErrorBanner, Spinner } from "../../components/ui/States";
import { Table, Td, THead, Tr } from "../../components/ui/Table";
import { useToast } from "../../components/ui/Toast";
import { errorMessage, post } from "../../lib/api";
import { fmtDateTime, fmtShortDate, inr, lpa, OFFER_TYPE, relative, timeLeft } from "../../lib/format";
import type { Offer } from "../../lib/models";
import { buildNotifications } from "../../lib/notifications";
import { toPolicyDecision, type ServerDecision } from "../../lib/types";
import { useAction } from "../../lib/use-api";
import { useStudent } from "./useStudent";

// ---------------------------------------------------------------------------------------------------------- drives

export function StudentDrives() {
  const { placement, busy, apply } = useStudent();
  if (placement.loading && !placement.data) return <Spinner />;
  const drives = placement.data?.drives ?? [];
  const allowed = drives.filter((d) => d.decision.result === "ALLOW" && !d.application_stage).length;
  return (
    <Page>
      <PageHeader title="Drives" subtitle="Open recruitment drives. The policy engine checks every rule for you, on the server, and tells you why when a drive is closed to you." />
      <ErrorBanner error={placement.error} />
      <Card>
        <CardHeader title={`${drives.length} open`} subtitle={`${allowed} you can apply to right now`} />
        {drives.length === 0 ? <EmptyState title="No drives are open right now" /> : <ul className="divide-y divide-[var(--surface-border)]">{drives.map((d) => <DriveItem key={d.id} d={d} onApply={(x) => void apply(x)} busy={busy} />)}</ul>}
      </Card>
    </Page>
  );
}

// ---------------------------------------------------------------------------------------------------- applications

export function StudentApplications() {
  const { applications, reload } = useStudent();
  const toast = useToast();
  const [openId, setOpenId] = useState<string | null>(null);
  const rows = applications.data ?? [];
  const sel = rows.find((r) => r.application_id === openId);

  async function withdraw(driveId: string) {
    try {
      await post(`/drives/${driveId}/withdraw`);
      toast.success("Application withdrawn.");
      setOpenId(null);
      await reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <Page>
      <PageHeader title="Applications" subtitle="Every application you have made and where it stands." />
      <ErrorBanner error={applications.error} />
      <Card>
        {applications.loading && !applications.data ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState title="No applications yet">Apply to a drive from the Drives page.</EmptyState>
        ) : (
          <Table caption="My applications">
            <THead cols={["Company", "Role", "Type", "Status", "Applied", ""]} />
            <tbody>
              {rows.map((a) => (
                <Tr key={a.application_id}>
                  <Td className="font-medium text-[var(--text-primary)]">{a.drive.company}</Td>
                  <Td className="text-[var(--text-secondary)]">{a.drive.title}</Td>
                  <Td>{OFFER_TYPE[a.drive.offer_type]}</Td>
                  <Td><AppStatusBadge status={a.stage} /></Td>
                  <Td className="tabular text-[var(--text-tertiary)]">{fmtShortDate(a.applied_at)}</Td>
                  <Td className="text-right"><Button size="sm" variant="ghost" onClick={() => setOpenId(a.application_id)}>Details</Button></Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal
        open={!!sel}
        onClose={() => setOpenId(null)}
        title={sel ? `${sel.drive.company} — ${sel.drive.title}` : ""}
        footer={sel && ["applied", "pending_review"].includes(sel.stage) && sel.drive.status === "open" ? <Button variant="danger" onClick={() => void withdraw(sel.drive.id)}>Withdraw application</Button> : undefined}
      >
        {sel && (
          <div className="space-y-3">
            <p className="text-[13px] text-[var(--text-secondary)]">Applied {fmtDateTime(sel.applied_at)} · last update {relative(sel.updated_at)}</p>
            <AppStatusBadge status={sel.stage} />
            {sel.decision && <PolicyExplain decision={toPolicyDecision({ result: sel.decision.result, summary: sel.decision.result, fired_rules: sel.decision.fired_rules } as ServerDecision)} />}
            <p className="text-[12px] text-[var(--text-tertiary)]">This is the decision the policy engine stored when you applied, so it can always be explained later.</p>
          </div>
        )}
      </Modal>
    </Page>
  );
}

// -------------------------------------------------------------------------------------------------------- offers

export function StudentOffers() {
  const { placement, reload } = useStudent();
  const toast = useToast();
  const act = useAction();
  const [confirm, setConfirm] = useState<{ offer: Offer; decision: "accept" | "decline" } | null>(null);
  const offers = placement.data?.offers ?? [];
  const pending = offers.filter((o) => o.acceptance_status === "pending" && new Date(o.deadline) > new Date());

  async function submit() {
    if (!confirm) return;
    let ok = false;
    await act.run(async () => {
      await post(`/offers/${confirm.offer.id}/respond`, { decision: confirm.decision });
      ok = true;
    });
    if (ok) {
      toast.success(confirm.decision === "accept" ? `Offer from ${confirm.offer.company} accepted.` : `Offer from ${confirm.offer.company} declined.`);
      setConfirm(null);
      await reload();
    }
  }

  return (
    <Page>
      <PageHeader title="Offers" subtitle="Accept or decline each offer before its deadline. An unanswered offer expires automatically at the deadline." />
      <ErrorBanner error={placement.error} />
      {pending.length > 0 && <Banner tone="warn">{pending.length} offer{pending.length > 1 ? "s" : ""} waiting for your response. Accepting changes your placement status and which drives you can still apply to.</Banner>}
      <Card>
        {placement.loading && !placement.data ? (
          <Spinner />
        ) : offers.length === 0 ? (
          <EmptyState title="No offers yet">When a company proposes an offer and the Placement Officer confirms it, it appears here.</EmptyState>
        ) : (
          <ul className="divide-y divide-[var(--surface-border)]">
            {offers.map((o) => {
              const open = o.acceptance_status === "pending" && new Date(o.deadline) > new Date();
              return (
                <li key={o.id} className="px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="text-sm font-semibold text-[var(--text-primary)]">{o.company}</h4>
                      <CategoryBadge category={o.category} />
                      <Badge>{OFFER_TYPE[o.type]}</Badge>
                      {o.off_campus && <Badge tone="brand">Off-campus</Badge>}
                    </div>
                    <p className="mt-0.5 text-[13px] text-[var(--text-secondary)]">{o.drive_title ?? "Off-campus offer"}</p>
                    <p className="mt-1 text-[12.5px] tabular text-[var(--text-tertiary)]">
                      {[o.ctc_lpa != null ? lpa(o.ctc_lpa) : null, o.stipend_amount != null ? `${inr(o.stipend_amount)} stipend` : null].filter(Boolean).join(" + ") || "—"} · issued {fmtShortDate(o.offer_date)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 sm:justify-end flex-wrap">
                    {open ? (
                      <>
                        <span className="text-[12px] text-[var(--status-review-text)] tabular">{timeLeft(o.deadline)} · {fmtDateTime(o.deadline)}</span>
                        <Button size="sm" onClick={() => setConfirm({ offer: o, decision: "accept" })}><Check size={14} aria-hidden /> Accept</Button>
                        <Button size="sm" variant="danger" onClick={() => setConfirm({ offer: o, decision: "decline" })}><X size={14} aria-hidden /> Decline</Button>
                      </>
                    ) : (
                      <StatusPill value={o.acceptance_status} />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Modal
        open={!!confirm}
        onClose={() => { setConfirm(null); act.clearError(); }}
        title={confirm?.decision === "accept" ? "Accept this offer?" : "Decline this offer?"}
        description={confirm ? `${confirm.offer.company} — ${confirm.offer.drive_title ?? "off-campus offer"}` : undefined}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setConfirm(null); act.clearError(); }}>Cancel</Button>
            <Button variant={confirm?.decision === "decline" ? "danger" : "primary"} disabled={act.busy} onClick={() => void submit()}>
              {act.busy ? "Saving…" : confirm?.decision === "accept" ? "Yes, accept" : "Yes, decline"}
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-[var(--text-secondary)]">
          {confirm?.decision === "accept"
            ? "This cannot be undone. Your placement status and the drives you can apply to will be recalculated from your accepted offers. You will be asked to confirm with your second factor."
            : "This cannot be undone. You will be asked to confirm with your second factor."}
        </p>
        <div className="mt-3"><ErrorBanner error={act.error} /></div>
      </Modal>
    </Page>
  );
}

// ---------------------------------------------------------------------------------------------------- notifications

export function StudentNotifications() {
  const { placement, applications } = useStudent();
  if ((placement.loading && !placement.data) || (applications.loading && !applications.data)) return <Spinner />;
  const items = buildNotifications({ offers: placement.data?.offers ?? [], applications: applications.data ?? [], profile: placement.data?.profile ?? null });
  const tone = { info: "bg-[var(--surface-1)]", allow: "bg-[var(--status-allow-bg)]", review: "bg-[var(--status-review-bg)]", block: "bg-[var(--status-block-bg)]" } as const;
  return (
    <Page>
      <PageHeader title="Notifications" subtitle="Built from your live records, so it is always current. Items that need you come first." />
      <Card>
        {items.length === 0 ? (
          <EmptyState title="Nothing needs your attention" />
        ) : (
          <ul className="divide-y divide-[var(--surface-border)]">
            {items.map((n) => (
              <li key={n.id} className="px-5 py-4 flex gap-3">
                <span className={`mt-1 h-2.5 w-2.5 rounded-full shrink-0 ${tone[n.kind]} border border-[var(--surface-border-strong)]`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium text-[var(--text-primary)]">{n.title}</p>
                    {n.action && <Badge tone="review">Needs action</Badge>}
                  </div>
                  <p className="mt-0.5 text-[13px] text-[var(--text-secondary)]">{n.detail}</p>
                </div>
                <span className="text-[11px] text-[var(--text-tertiary)] shrink-0">{relative(n.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Page>
  );
}
