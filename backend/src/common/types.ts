export type RoleName = 'student' | 'coordinator' | 'officer' | 'hr' | 'admin' | 'superadmin';

/** Who is making the request. Passed into every service call and into the DB session (for row-level security). */
export interface Actor {
  id: string;
  role: RoleName | 'system';
  email?: string;
  ip?: string;
  /** Programme ids a coordinator is scoped to (resolved from coordinator_scope at session start). */
  programmeIds?: string[];
  /** Company id for HR accounts. */
  companyId?: string;
}

export type SessionStage = 'mfa_pending' | 'enrol_pending' | 'full';

export interface SessionData {
  /** sha256 of the opaque cookie value: the raw value is never stored server-side. */
  id: string;
  user_id: string;
  email: string;
  name: string;
  role: RoleName;
  /** coordinator scope / HR company, resolved at session start (admin changes revoke the user's sessions). */
  programme_ids?: string[];
  company_id?: string;
  stage: SessionStage;
  csrf: string;
  created_at: number;
  last_seen: number;
  /** epoch ms of the last step-up (re-authentication with MFA) */
  step_up_at: number | null;
  ip: string;
  user_agent: string;
  /** Pending WebAuthn challenge, TOTP enrolment secret etc. (never leaves the server). */
  scratch?: Record<string, unknown>;
}

/** Session timeouts per role (architecture doc, section 4). Minutes / hours. */
export const SESSION_POLICY: Record<RoleName, { idleMs: number; absoluteMs: number }> = {
  student: { idleMs: 15 * 60_000, absoluteMs: 8 * 3_600_000 },
  coordinator: { idleMs: 15 * 60_000, absoluteMs: 8 * 3_600_000 },
  officer: { idleMs: 15 * 60_000, absoluteMs: 8 * 3_600_000 },
  hr: { idleMs: 15 * 60_000, absoluteMs: 4 * 3_600_000 },
  admin: { idleMs: 10 * 60_000, absoluteMs: 4 * 3_600_000 },
  superadmin: { idleMs: 10 * 60_000, absoluteMs: 2 * 3_600_000 },
};

/** How long a step-up (fresh MFA) stays valid. */
export const STEP_UP_WINDOW_MS = 5 * 60_000;

export const STAFF_ROLES: RoleName[] = ['coordinator', 'officer', 'admin', 'superadmin'];
