import { MapPin } from "lucide-react";
import { Button } from "../ui/Button";
import { PolicyExplain } from "../ui/PolicyExplain";
import { StatusBadge } from "../ui/StatusBadge";
import { CategoryBadge } from "../ui/Badge";
import { fmtShortDate, inr, lpa, OFFER_TYPE } from "../../lib/format";
import type { MyDrive } from "../../lib/models";
import { toPolicyDecision } from "../../lib/types";

export function packageText(d: Pick<MyDrive, "offer_type" | "ctc_lpa" | "stipend_amount" | "stipend_period">) {
  const parts: string[] = [];
  if (d.ctc_lpa != null) parts.push(lpa(d.ctc_lpa));
  if (d.stipend_amount != null) parts.push(`${inr(d.stipend_amount)}${d.stipend_period === "monthly" ? "/mo" : ""} stipend`);
  return parts.join(" + ") || "—";
}

/** One open drive with the policy engine's verdict for THIS student, and the reason when it is not ALLOW. */
export function DriveItem({ d, onApply, busy }: { d: MyDrive; onApply: (d: MyDrive) => void; busy: boolean }) {
  const decision = toPolicyDecision(d.decision);
  const applied = d.application_stage && d.application_stage !== "withdrawn";
  return (
    <li className="px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="text-sm font-semibold text-[var(--text-primary)]">{d.company}</h4>
            <StatusBadge outcome={d.decision.result} size="sm" />
            {d.category && <CategoryBadge category={d.category} />}
          </div>
          <p className="mt-0.5 text-[13px] text-[var(--text-secondary)]">{d.title}</p>
          <div className="mt-1.5 flex items-center gap-3 flex-wrap text-[12px] text-[var(--text-tertiary)]">
            <span className="tabular">{packageText(d)}</span>
            <span>{OFFER_TYPE[d.offer_type]}</span>
            {d.drive_date && (
              <span className="flex items-center gap-1">
                <MapPin size={11} aria-hidden />
                {fmtShortDate(d.drive_date)}
              </span>
            )}
          </div>
        </div>
        {d.acceptance_deadline && (
          <div className="text-right shrink-0">
            <p className="text-[11px] text-[var(--text-tertiary)]">Offer deadline</p>
            <p className="text-[13px] tabular font-medium text-[var(--text-primary)]">{fmtShortDate(d.acceptance_deadline)}</p>
          </div>
        )}
      </div>

      {d.decision.result !== "ALLOW" && !applied && (
        <div className="mt-3">
          <PolicyExplain decision={decision} />
        </div>
      )}

      <div className="mt-3 flex items-center gap-3">
        {applied ? (
          <span className="text-[13px] font-medium text-[var(--status-allow-text)]">Applied — {d.application_stage!.replace(/_/g, " ")}</span>
        ) : d.decision.result === "BLOCK" ? null : (
          <Button size="sm" onClick={() => onApply(d)} disabled={busy}>
            {d.decision.result === "REVIEW" ? "Apply (needs officer review)" : "Apply now"}
          </Button>
        )}
      </div>
    </li>
  );
}
