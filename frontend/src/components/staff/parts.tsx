import { ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage, get } from "../../lib/api";
import type { Page, StudentRow } from "../../lib/models";
import { Button } from "../ui/Button";
import { FilterInput } from "../ui/Field";

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function Pager({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-[var(--surface-border)] text-[12.5px] text-[var(--text-secondary)]">
      <span className="tabular">
        {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
      </span>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label="Previous page"><ChevronLeft size={15} aria-hidden /></Button>
        <span className="tabular px-1">{page} / {pages}</span>
        <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => onChange(page + 1)} aria-label="Next page"><ChevronRight size={15} aria-hidden /></Button>
      </div>
    </div>
  );
}

/** Search a student by name / Placement ID / e-mail, and pick one. Results are scoped by the server to what the viewer may see. */
export function StudentPicker({ value, onChange, label = "Student" }: { value: StudentRow | null; onChange: (s: StudentRow | null) => void; label?: string }) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q.trim());
  const [results, setResults] = useState<StudentRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (dq.length < 2) {
      setResults([]);
      return;
    }
    get<Page<StudentRow>>(`/students?page_size=8&q=${encodeURIComponent(dq)}`)
      .then((r) => live && (setResults(r.items), setErr(null)))
      .catch((e) => live && setErr(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [dq]);

  if (value) {
    return (
      <div>
        <p className="block text-[13px] font-medium text-[var(--text-primary)] mb-1.5">{label}</p>
        <div className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-[var(--surface-border-strong)] bg-[var(--surface-1)] px-3 py-2">
          <div className="min-w-0">
            <p className="text-sm font-medium text-[var(--text-primary)] truncate">{value.name}</p>
            <p className="text-[12px] text-[var(--text-tertiary)] tabular">{value.placement_id} · {value.programme_code}</p>
          </div>
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>Change</Button>
        </div>
      </div>
    );
  }
  return (
    <div>
      <label htmlFor="student-picker" className="block text-[13px] font-medium text-[var(--text-primary)] mb-1.5">{label}</label>
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" aria-hidden />
        <FilterInput id="student-picker" aria-label={label} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or Placement ID…" className="w-full pl-8 h-10" autoComplete="off" />
      </div>
      {err && <p className="mt-1.5 text-[12px] text-[var(--status-block-text)]">{err}</p>}
      {results.length > 0 && (
        <ul className="mt-1 rounded-[var(--radius-sm)] border border-[var(--surface-border)] bg-[var(--surface-2)] divide-y divide-[var(--surface-border)] max-h-52 overflow-y-auto">
          {results.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => { onChange(s); setQ(""); }} className="w-full text-left px-3 py-2 hover:bg-[var(--surface-1)]">
                <span className="text-sm text-[var(--text-primary)]">{s.name}</span>
                <span className="ml-2 text-[12px] text-[var(--text-tertiary)] tabular">{s.placement_id} · {s.programme_code}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A labelled key/value row for detail panels. */
export const KV = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div>
    <dt className="text-[12px] text-[var(--text-tertiary)]">{k}</dt>
    <dd className="mt-0.5 text-sm text-[var(--text-primary)] break-words">{children}</dd>
  </div>
);
