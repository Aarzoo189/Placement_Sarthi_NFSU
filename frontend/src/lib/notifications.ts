import type { MyApplication, Offer, StudentRow } from "./models";
import { timeLeft } from "./format";

export interface NotificationItem {
  id: string;
  title: string;
  detail: string;
  at: Date;
  /** needs the student to do something */
  action: boolean;
  kind: "info" | "allow" | "review" | "block";
}

/**
 * Notifications are derived from the student's real records (offers, applications, registration, switching rules): there is
 * no separate message store to drift out of date. Items that need a response sort first.
 */
export function buildNotifications(input: { offers: Offer[]; applications: MyApplication[]; profile: StudentRow | null }): NotificationItem[] {
  const out: NotificationItem[] = [];
  const { offers, applications, profile } = input;

  for (const o of offers) {
    if (o.acceptance_status === "pending") {
      const expired = new Date(o.deadline).getTime() <= Date.now();
      out.push({
        id: `o-${o.id}`,
        title: expired ? "Offer deadline passed" : "Offer waiting for your response",
        detail: expired ? `The offer from ${o.company} has expired.` : `Respond to ${o.company}: ${timeLeft(o.deadline)}. An unanswered offer expires automatically.`,
        at: new Date(o.offer_date),
        action: !expired,
        kind: expired ? "block" : "review",
      });
    } else if (o.acceptance_status === "accepted") {
      out.push({ id: `o-${o.id}`, title: "Offer accepted", detail: `You accepted the offer from ${o.company}. Your placement status was updated.`, at: new Date(o.offer_date), action: false, kind: "allow" });
    } else if (o.acceptance_status === "expired") {
      out.push({ id: `o-${o.id}`, title: "Offer expired", detail: `The offer from ${o.company} expired unanswered.`, at: new Date(o.deadline), action: false, kind: "block" });
    }
    if (o.acceptance_status === "accepted" && o.off_campus && o.noc_status === "pending") {
      out.push({ id: `noc-${o.id}`, title: "NOC pending", detail: `Your off-campus offer from ${o.company} has no NOC on record. Speak to your coordinator.`, at: new Date(o.offer_date), action: true, kind: "review" });
    }
  }

  for (const a of applications) {
    const where = `${a.drive.company} — ${a.drive.title}`;
    const at = new Date(a.updated_at);
    if (a.stage === "pending_review") out.push({ id: `a-${a.application_id}`, title: "Application held for review", detail: `${where}: the policy engine asked the Placement Officer to review this application.`, at, action: false, kind: "review" });
    else if (a.stage === "shortlisted") out.push({ id: `a-${a.application_id}`, title: "You were shortlisted", detail: where, at, action: false, kind: "allow" });
    else if (a.stage === "selected") out.push({ id: `a-${a.application_id}`, title: "You were selected", detail: `${where}. The company will propose an offer; the Placement Officer confirms it.`, at, action: false, kind: "allow" });
    else if (a.stage === "rejected") out.push({ id: `a-${a.application_id}`, title: "Not selected", detail: where, at, action: false, kind: "block" });
  }

  if (profile) {
    if (profile.registration_status === "not_registered") out.push({ id: "reg", title: "Confirm your registration", detail: "You cannot apply to drives until you confirm your placement registration on the dashboard.", at: new Date(), action: true, kind: "review" });
    if (profile.eligibility_status === "pending") out.push({ id: "elig", title: "Eligibility verification pending", detail: "Your coordinator has not verified your eligibility yet. Applications are held for review until they do.", at: new Date(), action: false, kind: "review" });
    if (profile.eligibility_status === "ineligible") out.push({ id: "inelig", title: "Marked ineligible", detail: "You are currently ineligible for placements. Contact your coordinator.", at: new Date(), action: false, kind: "block" });
    const sw = profile.switching;
    if (sw?.blocked_all) out.push({ id: "sw", title: "Out of the placement process", detail: sw.note, at: new Date(), action: false, kind: "info" });
    else if (sw?.min_ctc_lpa) out.push({ id: "sw", title: "Switching rule applies", detail: sw.note, at: new Date(), action: false, kind: "info" });
  }

  return out.sort((a, b) => Number(b.action) - Number(a.action) || b.at.getTime() - a.at.getTime());
}
