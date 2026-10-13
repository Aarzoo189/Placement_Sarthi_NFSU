import { Award, ClipboardList, GraduationCap, TrendingUp, Users } from "lucide-react";
import { Badge } from "../ui/Badge";
import { BarChart } from "../ui/BarChart";
import { Card, CardHeader } from "../ui/Card";
import { StatTile } from "../ui/StatTile";
import { EmptyState } from "../ui/States";
import { Table, Td, THead, Tr } from "../ui/Table";
import { inr, lpa } from "../../lib/format";
import type { Overview } from "../../lib/models";

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div>
    <p className="text-[12px] text-[var(--text-tertiary)]">{label}</p>
    <p className="mt-0.5 text-base font-semibold tabular text-[var(--text-primary)] break-words">{value}</p>
  </div>
);

/**
 * The placement overview. Reporting rules from the problem statement are visible in the layout:
 *  - distinct STUDENTS and OFFER rows are shown side by side
 *  - FTE CTC (LPA) and internship stipend (rupees) are separate cards and separate charts, never averaged together
 *  - averages use accepted FTE offers only; declined and expired offers are excluded but listed
 */
export function OverviewView({ o, extraTiles }: { o: Overview; extraTiles?: React.ReactNode }) {
  const p = o.placement;
  const placedPct = o.students.registered ? Math.round((p.placed_students / o.students.registered) * 100) : 0;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatTile label="Registered students" value={o.students.registered} icon={GraduationCap} hint={`${o.students.eligible} eligible · ${o.students.ineligible} ineligible`} />
        <StatTile label="Placed students (distinct)" value={p.placed_students} icon={Users} hint={`${placedPct}% of registered`} />
        <StatTile label="Accepted offers (rows)" value={p.offers_accepted} icon={Award} hint="One student can hold several" />
        <StatTile label="Offers waiting for a reply" value={p.pending_acceptance} icon={ClipboardList} tone={p.pending_acceptance ? "accent" : "default"} />
      </div>
      {extraTiles}

      <div className="grid xl:grid-cols-2 gap-6">
        <Card>
          <CardHeader title="Full-time CTC" subtitle={o.fte_ctc_lpa.basis} action={<TrendingUp size={15} className="text-[var(--text-tertiary)]" aria-hidden />} />
          <div className="p-5 grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Stat label="Offers" value={String(o.fte_ctc_lpa.count)} />
            <Stat label="Highest" value={lpa(o.fte_ctc_lpa.highest)} />
            <Stat label="Average" value={lpa(o.fte_ctc_lpa.average)} />
            <Stat label="Median" value={lpa(o.fte_ctc_lpa.median)} />
          </div>
          <div className="px-5 pb-5"><BarChart title="Accepted FTE offers by category" unit="offers" bars={o.fte_ctc_lpa.by_category.map((c) => ({ label: `Category ${c.category}`, value: c.offers }))} empty="No accepted FTE offers yet" /></div>
        </Card>

        <Card>
          <CardHeader title="Internship stipend" subtitle={o.internship_stipend.basis} />
          <div className="p-5 grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Stat label="Offers" value={String(o.internship_stipend.count)} />
            <Stat label="Highest" value={inr(o.internship_stipend.highest)} />
            <Stat label="Average" value={inr(o.internship_stipend.average)} />
            <Stat label="Median" value={inr(o.internship_stipend.median)} />
          </div>
          <div className="px-5 pb-5"><BarChart title="Accepted offers by type (students)" unit="students" bars={[{ label: "Internship (I)", value: p.students_by_type.I }, { label: "Full-time (F)", value: p.students_by_type.F }, { label: "Intern + PPO/FTE", value: p.students_by_type.IF }]} /></div>
        </Card>
      </div>

      <div className="grid xl:grid-cols-2 gap-6">
        <Card>
          <CardHeader title="Course-wise outcomes" subtitle="Placed students vs offers, side by side" />
          {o.course_wise.length === 0 ? <EmptyState title="No data yet" /> : (
            <Table caption="Course-wise outcomes"><THead cols={["Programme", "Registered", "Placed", "Offers", "Avg CTC"]} /><tbody>
              {o.course_wise.map((c) => <Tr key={c.programme}><Td className="font-medium">{c.programme}</Td><Td className="tabular">{c.registered}</Td><Td className="tabular">{c.placed_students}</Td><Td className="tabular">{c.offers}</Td><Td className="tabular">{lpa(c.avg_ctc)}</Td></Tr>)}
            </tbody></Table>
          )}
        </Card>
        <Card>
          <CardHeader title="Batch-wise outcomes" />
          {o.batch_wise.length === 0 ? <EmptyState title="No data yet" /> : (
            <Table caption="Batch-wise outcomes"><THead cols={["Batch", "Registered", "Placed", "Offers", "Avg CTC"]} /><tbody>
              {o.batch_wise.map((c) => <Tr key={c.batch}><Td className="font-medium tabular">{c.batch}</Td><Td className="tabular">{c.registered}</Td><Td className="tabular">{c.placed_students}</Td><Td className="tabular">{c.offers}</Td><Td className="tabular">{lpa(c.avg_ctc)}</Td></Tr>)}
            </tbody></Table>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader title="Status of registered students" />
        <div className="p-5 flex flex-wrap gap-3">
          <Badge>Unplaced {p.unplaced_students}</Badge><Badge tone="brand">Internship only {p.internship_only}</Badge><Badge tone="allow">FTE only {p.fte_only}</Badge><Badge tone="allow">Internship + PPO/FTE {p.internship_ppo_fte}</Badge>
          <Badge tone={p.awaiting_joining ? "review" : "neutral"}>Awaiting joining {p.awaiting_joining}</Badge><Badge tone={p.missing_noc ? "block" : "neutral"}>Missing NOC {p.missing_noc}</Badge>
        </div>
      </Card>

      <Card>
        <CardHeader title="Declined and expired offers" subtitle={`Excluded from the averages above: ${o.excluded_offers.declined} declined, ${o.excluded_offers.expired} expired`} />
        {o.excluded_offers.items.length === 0 ? <EmptyState title="None" /> : (
          <Table caption="Excluded offers"><THead cols={["Student", "Company", "Type", "Outcome"]} /><tbody>
            {o.excluded_offers.items.map((e) => <Tr key={e.offer_id}><Td>{e.student} <span className="text-[12px] text-[var(--text-tertiary)] tabular">{e.placement_id}</span></Td><Td>{e.company}</Td><Td>{e.type}</Td><Td><Badge tone="block">{e.status}</Badge></Td></Tr>)}
          </tbody></Table>
        )}
      </Card>
    </div>
  );
}
