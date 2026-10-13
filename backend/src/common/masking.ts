import { RoleName } from './types';

/**
 * Field masking. The access guard decides WHICH records a role may see; masking decides WHICH FIELDS of those
 * records are shown (architecture doc, section 3 matrix). Masked values are produced on the server: the browser
 * never receives the real value and then hides it.
 */
export const maskMobile = (m: string | null | undefined) => (m ? `${'*'.repeat(Math.max(m.length - 3, 0))}${m.slice(-3)}` : null);

export const maskEmail = (e: string | null | undefined) => {
  if (!e) return null;
  const [u, d] = e.split('@');
  return `${u.slice(0, 1)}${'*'.repeat(Math.max(u.length - 1, 1))}@${d ?? ''}`;
};

export const maskName = (n: string) => n;

export interface StudentRow {
  id: string;
  placement_id: string;
  name: string;
  email: string;
  mobile: string | null;
  programme_id: string;
  programme_code?: string;
  batch: number;
  cgpa: number | string;
  backlogs: number;
  registration_status: string;
  eligibility_status: string;
  archived_at?: Date | null;
  has_resume?: boolean;
  [k: string]: unknown;
}

export interface MaskContext {
  role: RoleName;
  /** Student record belongs to the viewer. */
  isSelf?: boolean;
  /** HR only: has the student been shortlisted for the viewer's drive? */
  shortlisted?: boolean;
  /** Super Admin break-glass: full view for this one request, logged. */
  breakGlass?: boolean;
}

/**
 * Student record, per role (matrix rows "View student records" and "Mobile number / email"):
 *   student      own record, everything except internal fields
 *   coordinator  own programme, full contact details
 *   officer      all, full
 *   admin        all, full
 *   hr           name, programme, CGPA, resume only; contact details after shortlist
 *   superadmin   masked unless break-glass
 */
export function maskStudent(row: StudentRow, ctx: MaskContext): Record<string, unknown> {
  const { role } = ctx;
  const full = role === 'officer' || role === 'admin' || role === 'coordinator' || (role === 'student' && ctx.isSelf) || (role === 'superadmin' && ctx.breakGlass);

  if (full) return { ...row, masked: false };

  if (role === 'hr') {
    const base = {
      id: row.id,
      name: row.name,
      programme_id: row.programme_id,
      programme_code: row.programme_code,
      batch: row.batch,
      cgpa: row.cgpa,
      has_resume: row.has_resume ?? false,
    };
    return ctx.shortlisted ? { ...base, email: row.email, mobile: row.mobile, masked: false } : { ...base, email: null, mobile: null, masked: true }; // contact details only after shortlist
  }

  // superadmin without break-glass (and any unknown role: fail closed)
  return {
    id: row.id,
    placement_id: row.placement_id,
    name: row.name,
    programme_id: row.programme_id,
    programme_code: row.programme_code,
    batch: row.batch,
    registration_status: row.registration_status,
    eligibility_status: row.eligibility_status,
    email: maskEmail(row.email),
    mobile: maskMobile(row.mobile),
    masked: true,
  };
}
