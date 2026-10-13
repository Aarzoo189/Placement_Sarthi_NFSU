import { FileSearch, Inbox, ShieldAlert } from "lucide-react";
import { Link } from "react-router-dom";
import { OverviewView } from "../../components/staff/OverviewView";
import { Card, CardHeader } from "../../components/ui/Card";
import { Page, PageHeader } from "../../components/ui/PageHeader";
import { StatTile } from "../../components/ui/StatTile";
import { Banner, ErrorBanner, Spinner } from "../../components/ui/States";
import { useApi } from "../../lib/use-api";
import { Badge } from "../../components/ui/Badge";
import type { Overview } from "../../lib/models";
import { fmtFullDateTime } from "../../lib/format";

const KIND: Record<string, string> = { engine_review: "Policy reviews", absenteeism: "Absenteeism flags", violation: "Suspected violations", expired_offer: "Expired offers" };

function Counts({ base }: { base: string }) {
  const c = useApi<Record<string, number>>("/review/counts");
  const total = Object.values(c.data ?? {}).reduce((a, b) => a + b, 0);
  if (!c.data) return null;
  return (
    <Card>
      <CardHeader title="Waiting for review" action={<Link to={`${base}/review`} className="text-[13px] font-medium text-[var(--brand-primary)] hover:underline">Open queue</Link>} />
      <div className="p-5 flex flex-wrap gap-2">
        {total === 0 ? <p className="text-[13px] text-[var(--text-tertiary)]">Nothing is waiting.</p> : Object.entries(c.data).map(([k, n]) => <Badge key={k} tone="review">{KIND[k] ?? k}: {n}</Badge>)}
      </div>
    </Card>
  );
}

export function CoordinatorDashboard() {
  const o = useApi<Overview>("/dashboards/programme");
  const changes = useApi<unknown[]>("/students/contact-changes");
  return (
    <Page>
      <PageHeader title="Programme overview" subtitle="Placement progress for the programme(s) you coordinate. Figures come from the same records as the student list, so they always match." />
      <ErrorBanner error={o.error} />
      {o.loading && !o.data ? <Spinner /> : o.data && <OverviewView o={o.data} extraTiles={<div className="grid grid-cols-2 gap-3 max-w-lg"><StatTile label="Contact-change requests" value={changes.data?.length ?? 0} icon={Inbox} tone={changes.data?.length ? "accent" : "default"} /><StatTile label="Not yet eligible-verified" value={o.data.students.pending_eligibility} icon={FileSearch} tone={o.data.students.pending_eligibility ? "accent" : "default"} /></div>} />}
      <Counts base="/coordinator" />
    </Page>
  );
}

export function PlacementOfficerDashboard() {
  const o = useApi<Overview>("/dashboards/overview");
  const proposals = useApi<unknown[]>("/offers/proposals");
  return (
    <Page>
      <PageHeader title="University-wide placement activity" subtitle="All programmes and batches. Placed students and offers are counted separately; CTC and stipend are never mixed." />
      {proposals.data && proposals.data.length > 0 && <Banner tone="warn" action={<Link className="text-[13px] font-medium underline" to="/placement-officer/proposals">Review</Link>}>{proposals.data.length} offer proposal{proposals.data.length > 1 ? "s" : ""} from companies waiting for your confirmation.</Banner>}
      <ErrorBanner error={o.error} />
      {o.loading && !o.data ? <Spinner /> : o.data && <OverviewView o={o.data} />}
      <Counts base="/placement-officer" />
    </Page>
  );
}

interface Status {
  database: string;
  redis: string;
  audit_entries: number;
  encryption: { algorithm: string; key_version: string; key_fingerprint: string; source: string };
  mfa_policy: { allow_totp_for_privileged: boolean; superadmin_networks: string[] };
  last_restore_drill: { at: string; result: string; backup_file: string } | null;
}

export function SuperAdminDashboard() {
  const o = useApi<Overview>("/dashboards/overview");
  const s = useApi<Status>("/system/status");
  return (
    <Page>
      <PageHeader title="Platform overview" subtitle="Aggregate figures only: the Super Admin does not see or edit individual student or offer records." />
      <ErrorBanner error={o.error ?? s.error} />
      {s.data && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatTile label="Database" value={s.data.database} icon={ShieldAlert} tone={s.data.database === "up" ? "default" : "accent"} />
          <StatTile label="Redis (sessions, jobs)" value={s.data.redis} icon={ShieldAlert} tone={s.data.redis === "up" ? "default" : "accent"} />
          <StatTile label="Audit entries" value={s.data.audit_entries.toLocaleString()} icon={FileSearch} />
          <StatTile label="Last restore drill" value={s.data.last_restore_drill ? s.data.last_restore_drill.result : "none"} icon={ShieldAlert} hint={s.data.last_restore_drill ? fmtFullDateTime(s.data.last_restore_drill.at) : "record one on System & keys"} tone={s.data.last_restore_drill?.result === "success" ? "default" : "accent"} />
        </div>
      )}
      {s.data?.mfa_policy.allow_totp_for_privileged && <Banner tone="warn">Development setting: authenticator apps are allowed for admin roles. In production, set <code className="font-mono">ALLOW_TOTP_FOR_PRIVILEGED=false</code> so passkeys / hardware keys are the only option.</Banner>}
      {o.loading && !o.data ? <Spinner /> : o.data && <OverviewView o={o.data} />}
    </Page>
  );
}
