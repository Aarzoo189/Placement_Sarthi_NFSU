import { ApiError, errorMessage, post } from "../../lib/api";
import type { MyApplication, MyDrive, MyPlacement } from "../../lib/models";
import { useApi } from "../../lib/use-api";
import { useToast } from "../../components/ui/Toast";
import { useState } from "react";

/** Everything the student pages need, from the server's dashboard + applications endpoints. */
export function useStudent() {
  const placement = useApi<MyPlacement>("/dashboards/my-placement");
  const applications = useApi<MyApplication[]>("/applications/mine");
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    await Promise.all([placement.reload(), applications.reload()]);
  };

  /** Apply. The policy engine runs on the SERVER for every application; a BLOCK comes back with the reasons. */
  async function apply(d: MyDrive) {
    setBusy(true);
    try {
      const r = await post<{ stage: string }>(`/drives/${d.id}/apply`);
      toast.success(r.stage === "pending_review" ? `Application sent to ${d.company}. It is held for Placement Officer review first.` : `Applied to ${d.company}.`);
    } catch (e) {
      if (e instanceof ApiError && e.code === "POLICY_BLOCK") toast.error(`Not allowed: ${e.message}`);
      else toast.error(errorMessage(e));
    } finally {
      setBusy(false);
      await reload();
    }
  }

  async function confirmRegistration() {
    try {
      await post("/students/me/confirm-registration");
      toast.success("Registration confirmed.");
      await reload();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return { placement, applications, busy, apply, reload, confirmRegistration };
}
