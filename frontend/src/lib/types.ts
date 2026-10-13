/**
 * UI roles. The server's role names map onto these (see SERVER_ROLE below). The Placement Administrator role is not part of
 * this portal: an account with that role is told so and signed out (see lib/session.tsx).
 */
export type Role =
  | "student"
  | "coordinator"
  | "placement_officer"
  | "company_hr"
  | "super_admin";

export type ServerRole =
  | "student"
  | "coordinator"
  | "officer"
  | "hr"
  | "admin"
  | "superadmin";

/** Server role -> UI role. `admin` is intentionally absent. */
export const SERVER_ROLE: Partial<Record<ServerRole, Role>> = {
  student: "student",
  coordinator: "coordinator",
  officer: "placement_officer",
  hr: "company_hr",
  superadmin: "super_admin",
};

export interface RoleMeta {
  id: Role;
  label: string;
  shortLabel: string;
  description: string;
  home: string;
}

export const ROLES: RoleMeta[] = [
  {
    id: "student",
    label: "Student",
    shortLabel: "Student",
    description: "Track eligibility, apply to drives, manage offers",
    home: "/student",
  },
  {
    id: "coordinator",
    label: "Faculty / Course Coordinator",
    shortLabel: "Coordinator",
    description: "Verify eligibility, mark attendance, monitor cohort placement progress",
    home: "/coordinator",
  },
  {
    id: "placement_officer",
    label: "Placement Officer",
    shortLabel: "Placement Officer",
    description: "Run drives, manage companies, confirm offers, university-wide oversight",
    home: "/placement-officer",
  },
  {
    id: "company_hr",
    label: "Company HR",
    shortLabel: "Company HR",
    description: "Review applicants for your drive, shortlist, propose offers",
    home: "/company-hr",
  },
  {
    id: "super_admin",
    label: "Super Admin",
    shortLabel: "Super Admin",
    description: "Platform controls: policy approval, accounts, audit integrity, system settings",
    home: "/super-admin",
  },
];

export const roleMeta = (r: Role) => ROLES.find((x) => x.id === r)!;

// ----------------------------------------------------------------------------------------------------------------
// Policy-engine decisions (ALLOW / BLOCK / REVIEW). Shape used by the UI components.
// ----------------------------------------------------------------------------------------------------------------

export type PolicyOutcome = "ALLOW" | "BLOCK" | "REVIEW";

export interface FiredRule {
  code: string;
  title: string;
  outcome: "BLOCK" | "REVIEW" | "OVERRIDDEN";
  message: string;
  exception_id?: string;
}

export interface PolicyDecision {
  outcome: PolicyOutcome;
  reason: string;
  detail?: string;
  ruleId?: string;
  rules?: FiredRule[];
}

/** Server decision -> the UI's PolicyDecision. */
export interface ServerDecision {
  result: PolicyOutcome;
  summary: string;
  fired_rules: FiredRule[];
  decision_id?: string;
}

export function toPolicyDecision(d: ServerDecision): PolicyDecision {
  const first = d.fired_rules.find((f) => f.outcome !== "OVERRIDDEN") ?? d.fired_rules[0];
  const reason =
    d.result === "ALLOW"
      ? d.summary === "ALLOW"
        ? "You meet every placement rule for this drive"
        : d.summary.replace(/^ALLOW\s*/, "Allowed ")
      : first
        ? first.message
        : d.summary;
  return {
    outcome: d.result,
    reason: reason.charAt(0).toUpperCase() + reason.slice(1),
    ruleId: first?.code,
    rules: d.fired_rules.length > 1 ? d.fired_rules : undefined,
  };
}
