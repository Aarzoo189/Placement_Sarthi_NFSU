import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { AuthLayout } from "../components/auth/AuthLayout";
import { Button } from "../components/ui/Button";
import { TextField } from "../components/ui/Field";
import { Banner } from "../components/ui/States";
import { ApiError, post } from "../lib/api";
import { useSession, type AuthPayload } from "../lib/session";

const schema = z
  .object({
    password: z.string().min(12, "Use at least 12 characters.").max(128, "Use at most 128 characters."),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "The two passwords do not match." });
type Values = z.infer<typeof schema>;

/** One-time activation link (valid 24 h): set a password, then enrol MFA before seeing any data. */
export function Activate() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const { apply } = useSession();
  const navigate = useNavigate();
  const { register, handleSubmit, formState } = useForm<Values>({ resolver: zodResolver(schema), mode: "onTouched" });
  const [reasons, setReasons] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(v: Values) {
    setBusy(true);
    setError(null);
    setReasons([]);
    try {
      apply(await post<AuthPayload>("/auth/activate", { token, password: v.password }));
      navigate("/", { replace: true }); // the sign-in page shows the MFA enrolment step
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
        const r = e.body.reasons;
        if (Array.isArray(r)) setReasons(r.map(String));
      } else setError("Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <AuthLayout title="Activation link needed">
        <Banner tone="warn">This page needs the activation link from your e-mail. Open the link again, or ask your coordinator to send a new one.</Banner>
        <Link to="/" className="mt-4 inline-block text-[13px] text-[var(--brand-primary)] hover:underline">
          Back to sign in
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Activate your account" subtitle="Choose a password. Next you will register a second factor; you cannot see any data until that is done.">
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-5">
        {error && (
          <Banner tone="error">
            <p>{error}</p>
            {reasons.length > 0 && (
              <ul className="mt-1 list-disc pl-4">
                {reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </Banner>
        )}
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          hint="At least 12 characters. Long passphrases are best; there is no forced rotation. Common or breached passwords are refused."
          error={formState.errors.password?.message}
          {...register("password")}
        />
        <TextField label="Confirm password" type="password" autoComplete="new-password" error={formState.errors.confirm?.message} {...register("confirm")} />
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Activating…" : "Activate account"}
        </Button>
      </form>
    </AuthLayout>
  );
}
