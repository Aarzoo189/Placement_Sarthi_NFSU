import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import { AuthLayout } from "../components/auth/AuthLayout";
import { EnrolMfa } from "../components/auth/EnrolMfa";
import { SecondFactor } from "../components/auth/SecondFactor";
import { Button } from "../components/ui/Button";
import { TextField } from "../components/ui/Field";
import { Banner, Spinner } from "../components/ui/States";
import { ApiError, errorMessage, post } from "../lib/api";
import { useSession, type AuthPayload } from "../lib/session";
import { roleMeta } from "../lib/types";

const schema = z.object({
  email: z.string().trim().min(1, "Enter your e-mail address.").email("Enter a valid e-mail address."),
  password: z.string().min(1, "Password is required."),
});
type Values = z.infer<typeof schema>;

export function SignIn() {
  const s = useSession();
  const navigate = useNavigate();

  useEffect(() => {
    if (s.stage === "full" && s.role) navigate(roleMeta(s.role).home, { replace: true });
  }, [s.stage, s.role, navigate]);

  if (s.stage === "loading") {
    return (
      <AuthLayout title="NFSU Placement Portal">
        <Spinner label="Checking your session" />
      </AuthLayout>
    );
  }

  if (s.stage === "mfa_pending" && s.mfa) {
    return (
      <AuthLayout title="Verify it is you" subtitle={`Signed in as ${s.user?.email ?? "your account"}. Confirm with your second factor to continue.`}>
        <SecondFactor methods={s.mfa.methods} primary={s.mfa.primary} allowRemember={s.role === "student"} onVerified={s.apply} />
        <button type="button" onClick={() => void s.signOut()} className="mt-6 text-[12.5px] text-[var(--text-secondary)] hover:underline">
          Use a different account
        </button>
      </AuthLayout>
    );
  }

  if (s.stage === "enrol_pending" && s.enrol) {
    return (
      <AuthLayout title="Set up multi-factor authentication" subtitle="One more step before you can see any placement data.">
        <EnrolMfa allowed={s.enrol.allowed} minPasskeys={s.enrol.min_passkeys} passkeys={s.enrol.passkeys} firstTime onDone={s.apply} onProgress={s.apply} />
        <button type="button" onClick={() => void s.signOut()} className="mt-6 text-[12.5px] text-[var(--text-secondary)] hover:underline">
          Cancel and sign out
        </button>
      </AuthLayout>
    );
  }

  return <Credentials notice={s.notice} onApply={(p) => { s.clearNotice(); s.apply(p); }} />;
}

function Credentials({ notice, onApply }: { notice: string | null; onApply: (p: AuthPayload) => void }) {
  const { register, handleSubmit, formState } = useForm<Values>({ resolver: zodResolver(schema), mode: "onTouched" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(v: Values) {
    setBusy(true);
    setError(null);
    try {
      onApply(await post<AuthPayload>("/auth/login", v));
    } catch (e) {
      setError(e instanceof ApiError && e.code === "LOCKED" ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Sign in to your portal" subtitle="Use your university e-mail address. Your role is set by your account, not chosen here.">
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-5">
        {notice && <Banner tone="warn">{notice}</Banner>}
        {error && <Banner tone="error">{error}</Banner>}
        <TextField label="E-mail" type="email" autoComplete="username" placeholder="name@nfsu.ac.in" error={formState.errors.email?.message} {...register("email")} />
        <TextField label="Password" type="password" autoComplete="current-password" placeholder="••••••••••••" error={formState.errors.password?.message} {...register("password")} />
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Signing in…" : "Continue"}
          <ArrowRight size={15} aria-hidden />
        </Button>
      </form>
      <p className="mt-6 text-[12px] text-[var(--text-tertiary)] leading-relaxed">
        Every sign-in needs your password and a second factor. After 5 failed attempts the account is locked for 15 minutes. New accounts are activated from the
        link e-mailed to you.
      </p>
    </AuthLayout>
  );
}
