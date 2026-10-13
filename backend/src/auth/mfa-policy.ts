import { MfaType } from '@prisma/client';
import { env } from '../config/env';
import { RoleName } from '../common/types';

/**
 * Which second factors each role may use (architecture doc, section 4). The strength of the factor scales with what
 * the role can change: staff who edit offers need phishing-resistant MFA, students need something that works on any phone.
 *
 *  student                 TOTP app           fallback: e-mail OTP (6 digits, 5 min) + recovery codes
 *  coordinator / officer   passkey (WebAuthn) fallback: TOTP + recovery codes
 *  HR                      TOTP app           fallback: e-mail OTP + recovery codes
 *  admin                   passkey only       reset by a Super Admin
 *  super admin             hardware key only  two keys registered; sealed offline recovery codes
 */
export interface MfaPolicy {
  /** Factors that can be used to sign in / step up (enrolled factors only). */
  login: MfaType[];
  /** Factors the user may enrol. */
  enrol: MfaType[];
  /** E-mail OTP is available as a sign-in fallback without enrolment. */
  emailOtp: boolean;
  recoveryCodes: boolean;
  /** Minimum number of enrolled passkeys before enrolment counts as complete (Super Admin: two keys). */
  minPasskeys: number;
  rememberDevice: boolean;
  primary: MfaType;
}

export function mfaPolicy(role: RoleName): MfaPolicy {
  const devTotp = env.ALLOW_TOTP_FOR_PRIVILEGED;
  switch (role) {
    case 'student':
      return { login: ['totp', 'email'], enrol: ['totp'], emailOtp: true, recoveryCodes: true, minPasskeys: 0, rememberDevice: true, primary: 'totp' };
    case 'hr':
      return { login: ['totp', 'email'], enrol: ['totp'], emailOtp: true, recoveryCodes: true, minPasskeys: 0, rememberDevice: false, primary: 'totp' };
    case 'coordinator':
    case 'officer':
      return { login: ['passkey', 'totp'], enrol: ['passkey', 'totp'], emailOtp: false, recoveryCodes: true, minPasskeys: 0, rememberDevice: false, primary: 'passkey' };
    case 'admin':
      return { login: devTotp ? ['passkey', 'totp'] : ['passkey'], enrol: devTotp ? ['passkey', 'totp'] : ['passkey'], emailOtp: false, recoveryCodes: false, minPasskeys: devTotp ? 0 : 1, rememberDevice: false, primary: 'passkey' };
    case 'superadmin':
      return { login: devTotp ? ['passkey', 'totp'] : ['passkey'], enrol: devTotp ? ['passkey', 'totp'] : ['passkey'], emailOtp: false, recoveryCodes: true, minPasskeys: devTotp ? 0 : 2, rememberDevice: false, primary: 'passkey' };
  }
}

/** Is enrolment complete for this role given the user's confirmed factors? */
export function enrolmentComplete(role: RoleName, factors: { type: MfaType }[]): boolean {
  const p = mfaPolicy(role);
  const usable = factors.filter((f) => p.enrol.includes(f.type));
  if (!usable.length) return false;
  if (p.minPasskeys > 0) return factors.filter((f) => f.type === 'passkey').length >= p.minPasskeys;
  return true;
}
