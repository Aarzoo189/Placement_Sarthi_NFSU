export const fmtDate = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";

export const fmtShortDate = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short" }) : "—";

export const fmtDateTime = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

export const fmtFullDateTime = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";

/** CTC is in LPA; a stipend is in rupees. They are different measures and are always labelled. */
export const lpa = (n: number | null | undefined) => (n == null ? "—" : `₹${Number(n.toFixed(2))} LPA`);
export const inr = (n: number | null | undefined) => (n == null ? "—" : `₹${Math.round(n).toLocaleString("en-IN")}`);

export function timeLeft(deadline: string | Date): string {
  const ms = new Date(deadline).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3_600_000);
  if (h >= 48) return `${Math.floor(h / 24)} days left`;
  if (h >= 1) return `${h} h ${Math.floor((ms % 3_600_000) / 60_000)} m left`;
  return `${Math.max(1, Math.floor(ms / 60_000))} min left`;
}

export function relative(d: string | Date): string {
  const ms = Date.now() - new Date(d).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export const OFFER_TYPE: Record<string, string> = { I: "Internship", F: "Full-time", IF: "Internship + PPO/FTE" };
export const initials = (name: string) =>
  name
    .replace(/\(.*?\)/g, "")
    .replace(/^(Dr|Prof|Mr|Ms|Mrs)\.?\s+/i, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
