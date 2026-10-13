import { Navigate } from "react-router-dom";
import { useSession } from "../../lib/session";
import type { Role } from "../../lib/types";
import { roleMeta } from "../../lib/types";
import { Spinner } from "../ui/States";
import { AppShell } from "./AppShell";

/**
 * Route guard. This only decides what to RENDER: it is a convenience, not security. Every request the page makes is
 * authenticated and authorised again by the server (role -> scope -> field), so forcing this guard open in dev tools
 * shows an empty page and 403s, never someone else's data.
 */
export function ProtectedRoute({ role: allowed, children }: { role: Role; children: React.ReactNode }) {
  const { stage, role } = useSession();
  if (stage === "loading") return <Spinner label="Loading" />;
  if (stage !== "full" || !role) return <Navigate to="/" replace />;
  if (role !== allowed) return <Navigate to={roleMeta(role).home} replace />;
  return <AppShell>{children}</AppShell>;
}
