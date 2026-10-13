/**
 * Password rules (architecture doc, section 4): at least 12 characters, checked against a breached-password list,
 * no forced rotation. The bundled list is a prototype stand-in; production should query a k-anonymity breach API
 * (e.g. Pwned Passwords range search) or load the full NCSC/HIBP corpus.
 */
const COMMON = new Set(
  `password password1 password12 password123 password1234 passw0rd p@ssw0rd p@ssword 123456 1234567 12345678 123456789 1234567890
12345678910 123456789012 111111111111 000000000000 qwerty qwerty123 qwertyuiop qwertyuiop123 qwerty123456 1q2w3e4r 1q2w3e4r5t 1qaz2wsx
zaq12wsx asdfghjkl asdfghjkl123 zxcvbnm letmein letmein123 welcome welcome1 welcome123 welcome12345 admin admin123 admin1234 administrator
administrator123 root toor changeme changeme123 iloveyou iloveyou123 monkey dragon master sunshine princess football baseball superman
batman trustno1 abc123 abc12345 abcd1234 abcdefgh abcdefghijkl india123 india@123 india12345 delhi123 gujarat123 gandhinagar nfsu nfsu123
nfsu@123 nfsu12345 nfsuplacement placement placement123 placement@123 placementportal student student123 student@123 faculty faculty123
coordinator officer officer123 company company123 hr123 hrpassword university university123 college college123 cybersecurity
forensic forensics forensic123 secret secret123 default login login123 test test123 test1234 testing123 guest guest123 user user123
hello123 hello@123 whatever freedom shadow michael jordan23 cricket cricket123 krishna ganesh shiva sharma123 kumar123 singh123
12341234 11223344 123123123 321321321 987654321 987654321012 aaaaaaaaaaaa 111111111111 qazwsxedc qazwsxedc123 mypassword mypassword123
iloveyou1234 passwordpassword password1password 1234abcd abcd12345678 q1w2e3r4t5y6 changeit changeit123`
    .split(/\s+/)
    .filter(Boolean),
);

export interface PasswordCheck {
  ok: boolean;
  reasons: string[];
}

export function checkPassword(password: string, context: { email?: string; name?: string } = {}): PasswordCheck {
  const reasons: string[] = [];
  if (password.length < 12) reasons.push('Use at least 12 characters.');
  if (password.length > 128) reasons.push('Use at most 128 characters.');

  const lower = password.toLowerCase();
  if (COMMON.has(lower) || COMMON.has(lower.replace(/[^a-z0-9@]/g, ''))) reasons.push('This password appears in lists of breached or very common passwords.');
  if (/^(.)\1+$/.test(password)) reasons.push('Do not repeat one character.');
  if (/^(?:0123456789|1234567890|abcdefghijkl|qwertyuiop)/i.test(password)) reasons.push('Do not use a keyboard or number sequence.');

  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) reasons.push('Do not include your e-mail name in the password.');
  const first = context.name?.split(/\s+/)[0]?.toLowerCase();
  if (first && first.length >= 4 && lower.includes(first)) reasons.push('Do not include your name in the password.');

  return { ok: reasons.length === 0, reasons };
}
