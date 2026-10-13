import { Award, Bell, BriefcaseBusiness, ClipboardList, Megaphone } from "lucide-react";
import { Link } from "react-router-dom";
import { DriveItem } from "../../components/student/DriveItem";
import { Button } from "../../components/ui/Button";
import { Card, CardHeader } from "../../components/ui/Card";
import { CategoryBadge } from "../../components/ui/Badge";
import { PolicyExplain } from "../../components/ui/PolicyExplain";
import { StatTile } from "../../components/ui/StatTile";
import { AppStatusBadge } from "../../components/ui/StatusBadge";
import { Banner, EmptyState, Spinner } from "../../components/ui/States";
import { Page } from "../../components/ui/PageHeader";
import { fmtShortDate, lpa, timeLeft, relative } from "../../lib/format";
import type { MyPlacement } from "../../lib/models";
import { buildNotifications } from "../../lib/notifications";
import type { PolicyDecision } from "../../lib/types";
import { useStudent } from "./useStudent";

/** The student's overall standing, in the policy engine's own vocabulary. */
function standing(p: MyPlacement): PolicyDecision {
  const s = p.profile;
  if (s.registration_status !== "registered") return { outcome: "REVIEW", reason: "You have not confirmed your placement registration", detail: "Confirm it below. You cannot apply to drives until you do.", ruleId: "R1" };
  if (s.eligibility_status === "ineligible") return { outcome: "BLOCK", reason: "You are marked ineligible for this placement season", detail: "Your coordinator maintains eligibility. Speak to them if you think this is wrong.", ruleId: "R2" };
  if (s.eligibility_status === "pending") return { outcome: "REVIEW", reason: "Your eligibility is waiting for coordinator verification", detail: "Until then, applications are held for the Placement Officer's review.", ruleId: "R2" };
  if (s.switching?.blocked_all) return { outcome: "BLOCK", reason: "You are out of the placement process", detail: s.switching.note, ruleId: "R6" };
  const pending = p.offers.filter((o) => o.acceptance_status === "pending" && new Date(o.deadline) > new Date()).length;
  if (pending) return { outcome: "REVIEW", reason: `You have ${pending} offer${pending > 1 ? "s" : ""} waiting for your response`, detail: "Accept or decline before applying to further drives.", ruleId: "R7" };
  return { outcome: "ALLOW", reason: s.placement_status === "Unplaced" ? "You are eligible to apply to open drives" : `Status: ${s.placement_status}`, detail: s.switching?.note && s.switching.rule !== "none" ? s.switching.note : "Eligibility is checked by the policy engine for each drive, using the current policy rules." };
}

export function StudentDashboard() {
  const { placement, applications, busy, apply, confirmRegistration } = useStudent();
  const p = placement.data;

  if (placement.loading && !p) return <Spinner label="Loading your placement dashboard" />;
  if (!p) return <Banner tone="error">{placement.error ?? "Could not load your dashboard."}</Banner>;

  const { profile, offers, drives } = p;
  const apps = applications.data ?? [];
  const notifications = buildNotifications({ offers, applications: apps, profile }).slice(0, 4);
  const pendingOffers = offers.filter((o) => o.acceptance_status === "pending" && new Date(o.deadline) > new Date());

  return (
    <Page>
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Welcome back, {profile.name.split(" ")[0]}</h2>
        <p className="text-[13.5px] text-[var(--text-secondary)]">
          {profile.placement_id} &middot; {profile.programme_name ?? profile.programme_code} &middot; CGPA {Number(profile.cgpa ?? 0).toFixed(2)} &middot; Batch {profile.batch}
        </p>
      </div>

      <PolicyExplain decision={standing(p)} />
      {profile.registration_status === "not_registered" && (
        <Banner tone="warn" action={<Button size="sm" onClick={() => void confirmRegistration()}>Confirm registration</Button>}>
          Confirm that you are registering for campus placements this season.
        </Banner>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Applications sent" value={apps.filter((a) => a.stage !== "withdrawn").length} icon={ClipboardList} />
        <StatTile label="Placement status" value={profile.placement_status ?? "Unplaced"} icon={BriefcaseBusiness} hint={profile.current_category ? `Category ${profile.current_category}` : undefined} />
        <StatTile label="Offers received" value={offers.length} icon={Award} tone={pendingOffers.length ? "accent" : "default"} hint={pendingOffers.length ? `${pendingOffers.length} waiting` : undefined} />
        <StatTile label="Drives you can apply to" value={drives.filter((d) => d.decision.result !== "BLOCK" && !d.application_stage).length} icon={Megaphone} />
      </div>

      <div className="grid lg:grid-cols-[1fr_320px] gap-6">
        <div className="space-y-6 min-w-0">
          <Card>
            <CardHeader title="Open recruitment drives" subtitle="Eligibility is evaluated per drive by the policy engine, on the server" />
            {drives.length === 0 ? (
              <EmptyState title="No drives are open right now">New drives appear here when the Placement Cell opens them.</EmptyState>
            ) : (
              <ul className="divide-y divide-[var(--surface-border)]">
                {drives.slice(0, 5).map((d) => (
                  <DriveItem key={d.id} d={d} onApply={(x) => void apply(x)} busy={busy} />
                ))}
              </ul>
            )}
            {drives.length > 5 && (
              <div className="px-5 py-3 border-t border-[var(--surface-border)]">
                <Link to="/student/drives" className="text-[13px] font-medium text-[var(--brand-primary)] hover:underline">
                  See all {drives.length} drives
                </Link>
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Application history" action={<Link to="/student/applications" className="text-[13px] font-medium text-[var(--brand-primary)] hover:underline">View all</Link>} />
            {apps.length === 0 ? (
              <EmptyState title="No applications yet">Apply to a drive above and it will appear here.</EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--text-tertiary)] border-b border-[var(--surface-border)]">
                      <th className="font-medium px-5 py-2.5">Company</th>
                      <th className="font-medium px-3 py-2.5 hidden sm:table-cell">Role</th>
                      <th className="font-medium px-3 py-2.5">Status</th>
                      <th className="font-medium px-5 py-2.5 text-right hidden md:table-cell">Applied</th>
                    </tr>
                  </thead>
                  <tbody>
                    {apps.slice(0, 6).map((a) => (
                      <tr key={a.application_id} className="border-b border-[var(--surface-border)] last:border-0">
                        <td className="px-5 py-3 font-medium text-[var(--text-primary)]">
                          {a.drive.company}
                          <span className="sm:hidden block text-[12px] font-normal text-[var(--text-tertiary)]">{a.drive.title}</span>
                        </td>
                        <td className="px-3 py-3 text-[var(--text-secondary)] hidden sm:table-cell">{a.drive.title}</td>
                        <td className="px-3 py-3">
                          <AppStatusBadge status={a.stage} />
                        </td>
                        <td className="px-5 py-3 text-right tabular text-[var(--text-tertiary)] hidden md:table-cell">{fmtShortDate(a.applied_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-6 min-w-0">
          <Card>
            <CardHeader title="Offers & deadlines" action={<Link to="/student/offers" className="text-[13px] font-medium text-[var(--brand-primary)] hover:underline">Manage</Link>} />
            <div className="p-5 space-y-4">
              {offers.length === 0 && <p className="text-[13px] text-[var(--text-tertiary)]">No offers yet. Keep applying to eligible drives.</p>}
              {offers.slice(0, 4).map((o) => (
                <div key={o.id} className="rounded-[var(--radius-sm)] border border-[var(--surface-border)] p-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold text-[var(--text-primary)]">{o.company}</p>
                    <CategoryBadge category={o.category} />
                  </div>
                  <p className="text-[12.5px] text-[var(--text-secondary)]">{o.drive_title ?? "Off-campus offer"}</p>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="text-[13px] tabular font-medium text-[var(--text-primary)]">{o.ctc_lpa != null ? lpa(o.ctc_lpa) : o.stipend_amount != null ? `₹${Math.round(o.stipend_amount).toLocaleString("en-IN")} stipend` : "—"}</span>
                    {o.acceptance_status === "pending" ? (
                      <span className="text-[11.5px] text-[var(--status-review-text)]">{timeLeft(o.deadline)}</span>
                    ) : (
                      <span className="text-[11.5px] text-[var(--text-tertiary)] capitalize">{o.acceptance_status}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="Notifications" action={<Bell size={15} className="text-[var(--text-tertiary)]" aria-hidden />} />
            {notifications.length === 0 ? (
              <p className="px-5 py-5 text-[13px] text-[var(--text-tertiary)]">Nothing needs your attention.</p>
            ) : (
              <ul className="divide-y divide-[var(--surface-border)]">
                {notifications.map((n) => (
                  <li key={n.id} className="px-5 py-3.5">
                    <div className="flex items-start gap-2.5">
                      <span className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${n.action ? "bg-[var(--brand-gold)]" : "bg-transparent"}`} aria-hidden />
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-[var(--text-primary)]">{n.title}</p>
                        <p className="mt-0.5 text-[12.5px] text-[var(--text-secondary)]">{n.detail}</p>
                        <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">{relative(n.at)}</p>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </Page>
  );
}
