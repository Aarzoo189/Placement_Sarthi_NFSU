import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

const control =
  "w-full rounded-[var(--radius-sm)] border bg-[var(--surface-2)] text-[var(--text-primary)] text-sm placeholder:text-[var(--text-tertiary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-60";
const ok = "border-[var(--surface-border-strong)]";
const bad = "border-[var(--status-block-text)]";

interface FieldShellProps {
  label: string;
  error?: string;
  hint?: string;
  children: (a: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

function FieldShell({ label, error, hint, children }: FieldShellProps) {
  const id = useId();
  const dId = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div>
      <label htmlFor={id} className="block text-[13px] font-medium text-[var(--text-primary)] mb-1.5">
        {label}
      </label>
      {children({ id, describedBy: dId, invalid: !!error })}
      {error ? (
        <p id={`${id}-err`} role="alert" className="mt-1.5 text-[12px] text-[var(--status-block-text)]">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-[12px] text-[var(--text-tertiary)]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

type CommonProps = { label: string; error?: string; hint?: string };

export const TextField = forwardRef<HTMLInputElement, CommonProps & InputHTMLAttributes<HTMLInputElement>>(({ label, error, hint, className = "", ...rest }, ref) => (
  <FieldShell label={label} error={error} hint={hint}>
    {({ id, describedBy, invalid }) => <input ref={ref} id={id} aria-invalid={invalid} aria-describedby={describedBy} className={`${control} h-10 px-3 ${invalid ? bad : ok} ${className}`} {...rest} />}
  </FieldShell>
));
TextField.displayName = "TextField";

export const SelectField = forwardRef<HTMLSelectElement, CommonProps & SelectHTMLAttributes<HTMLSelectElement>>(({ label, error, hint, className = "", children, ...rest }, ref) => (
  <FieldShell label={label} error={error} hint={hint}>
    {({ id, describedBy, invalid }) => (
      <select ref={ref} id={id} aria-invalid={invalid} aria-describedby={describedBy} className={`${control} h-10 px-3 ${invalid ? bad : ok} ${className}`} {...rest}>
        {children}
      </select>
    )}
  </FieldShell>
));
SelectField.displayName = "SelectField";

export const TextAreaField = forwardRef<HTMLTextAreaElement, CommonProps & TextareaHTMLAttributes<HTMLTextAreaElement>>(({ label, error, hint, className = "", ...rest }, ref) => (
  <FieldShell label={label} error={error} hint={hint}>
    {({ id, describedBy, invalid }) => <textarea ref={ref} id={id} aria-invalid={invalid} aria-describedby={describedBy} rows={3} className={`${control} px-3 py-2 ${invalid ? bad : ok} ${className}`} {...rest} />}
  </FieldShell>
));
TextAreaField.displayName = "TextAreaField";

export function Checkbox({ label, ...rest }: { label: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex items-start gap-2.5 text-[13px] text-[var(--text-primary)] cursor-pointer">
      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--brand-primary)]" {...rest} />
      <span>{label}</span>
    </label>
  );
}

/** A compact control for filter bars (no label block). */
export const FilterSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { "aria-label": string }>(({ className = "", ...rest }, ref) => (
  <select ref={ref} className={`${control} ${ok} h-9 px-2.5 w-auto ${className}`} {...rest} />
));
FilterSelect.displayName = "FilterSelect";

export const FilterInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { "aria-label": string }>(({ className = "", ...rest }, ref) => (
  <input ref={ref} className={`${control} ${ok} h-9 px-3 ${className}`} {...rest} />
));
FilterInput.displayName = "FilterInput";
