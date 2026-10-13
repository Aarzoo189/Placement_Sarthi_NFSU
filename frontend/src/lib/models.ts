import type { ServerDecision } from "./types";

export type OfferType = "I" | "F" | "IF";
export type Category = "A+" | "A" | "B" | "C";

export interface Switching {
  rule: string;
  blocked_all: boolean;
  allowed_categories: Category[];
  allowed_offer_types: OfferType[];
  min_ctc_lpa: number | null;
  note: string;
  pending_offer_count?: number;
}

/** A student record as the server returns it for the viewer's role. `masked` = fields are hidden by the server, not by the UI. */
export interface StudentRow {
  id: string;
  placement_id: string;
  name: string;
  email: string | null;
  mobile: string | null;
  programme_id: string;
  programme_code: string;
  programme_name?: string;
  batch: number;
  cgpa?: number;
  backlogs?: number;
  registration_status?: "not_registered" | "registered" | "deregistered";
  eligibility_status?: "pending" | "eligible" | "ineligible";
  placement_status?: string;
  current_category?: Category | null;
  accepted_offer_count?: number;
  has_resume?: boolean;
  masked?: boolean;
  switching?: Switching | null;
}

export interface Page<T> {
  total: number;
  page: number;
  page_size: number;
  items: T[];
}

export interface Programme {
  id: string;
  code: string;
  name: string;
}

export interface Drive {
  id: string;
  company_id: string;
  company: string;
  title: string;
  offer_type: OfferType;
  ctc_lpa: number | null;
  stipend_amount: number | null;
  stipend_period: string | null;
  category: Category | null;
  criteria: { min_cgpa?: number; max_backlogs?: number; programmes?: string[]; batches?: number[] };
  acceptance_deadline: string | null;
  drive_date: string | null;
  status: "draft" | "open" | "closed";
  opened_at: string | null;
  closed_at: string | null;
}

export interface MyDrive extends Drive {
  decision: ServerDecision;
  application_stage: string | null;
}

export interface MyApplication {
  application_id: string;
  stage: string;
  applied_at: string;
  updated_at: string;
  drive: { id: string; title: string; company: string; offer_type: OfferType; status: string };
  decision: { result: "ALLOW" | "BLOCK" | "REVIEW"; fired_rules: ServerDecision["fired_rules"] } | null;
}

export interface Offer {
  id: string;
  student: { id: string; placement_id: string; name: string; programme_code: string; batch: number };
  drive_id: string | null;
  company: string;
  drive_title: string | null;
  off_campus: boolean;
  type: OfferType;
  category: Category | null;
  ctc_lpa: number | null;
  stipend_amount: number | null;
  offer_date: string;
  deadline: string;
  acceptance_status: "pending" | "accepted" | "declined" | "expired";
  ppo_status: string;
  joining_status: string;
  noc_status: string;
  policy_version: number | null;
}

export interface MyPlacement {
  profile: StudentRow & { switching: Switching | null };
  offers: Offer[];
  drives: MyDrive[];
  pending_deadlines: { offer_id: string; company: string; deadline: string }[];
}

export interface Stats {
  count: number;
  highest: number | null;
  average: number | null;
  median: number | null;
}

export interface Overview {
  scope: "university" | "programme";
  students: { total: number; registered: number; eligible: number; ineligible: number; pending_eligibility: number };
  placement: {
    placed_students: number;
    unplaced_students: number;
    offers_accepted: number;
    internship_only: number;
    fte_only: number;
    internship_ppo_fte: number;
    offers_by_type: Record<OfferType, number>;
    students_by_type: Record<OfferType, number>;
    pending_acceptance: number;
    awaiting_joining: number;
    missing_noc: number;
  };
  fte_ctc_lpa: Stats & { basis: string; by_category: { category: Category; offers: number }[] };
  internship_stipend: Stats & { basis: string };
  course_wise: { programme: string; registered: number; eligible: number; placed_students: number; offers: number; avg_ctc: number | null }[];
  batch_wise: { batch: number; registered: number; eligible: number; placed_students: number; offers: number; avg_ctc: number | null }[];
  excluded_offers: { declined: number; expired: number; items: { offer_id: string; student: string; placement_id: string; company: string; type: OfferType; status: string }[] };
}

export interface ReviewItem {
  id: string;
  kind: "engine_review" | "absenteeism" | "violation" | "expired_offer" | "missing_noc";
  status: string;
  opened_at: string;
  resolved_at: string | null;
  resolution_reason: string | null;
  summary: string;
  fired_rules: ServerDecision["fired_rules"] | null;
  student: { id: string; name: string; placement_id: string; programme_code: string } | null;
}

export interface PolicyParams {
  thresholds: { aPlusMin: number; aMin: number; bMin: number };
  switchB: { multiplier: number };
  absenteeism: { lastDrives: number };
  acceptance: { hours: number };
}

export interface PolicyVersion {
  version: number;
  status: "draft" | "proposed" | "published" | "superseded" | "rejected";
  note: string | null;
  created_by: string | null;
  proposed_by: string | null;
  published_by: string | null;
  created_at: string;
  published_at: string | null;
  params: PolicyParams;
}

export interface ExceptionRow {
  id: string;
  rule_code: string;
  rule: string;
  reason: string;
  expires_at: string;
  revoked_at: string | null;
  active: boolean;
  student: { id: string; placement_id: string; name: string; programme_code: string };
}

export interface AuditRow {
  id: string;
  at: string;
  actor_id: string | null;
  role: string | null;
  action: string;
  entity: string | null;
  entity_id: string | null;
  before: unknown;
  after: unknown;
  meta: Record<string, unknown> | null;
  ip: string | null;
  hash: string;
}

export const RULE_NAMES: Record<string, string> = {
  R1: "R1 Registration",
  R2: "R2 Eligibility",
  R3: "R3 Company criteria",
  R4: "R4 Absenteeism",
  R5: "R5 Offer-type rule",
  R6: "R6 Category switching",
  R7: "R7 Pending offer",
  R8: "R8 Data conflict",
};
