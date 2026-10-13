/**
 * API client. The browser holds NO credentials: the session is an opaque HttpOnly cookie that scripts cannot read.
 * What this module does on every call:
 *   - sends the cookie (credentials: "include") and the per-session CSRF token the server issued
 *   - turns error responses into ApiError (with the server's machine-readable `code`)
 *   - on 401 STEP_UP_REQUIRED, asks the user for a fresh second factor (modal) and retries the request once
 *   - on 401 NO_SESSION, tells the session layer the user has been signed out
 * Nothing here is trusted by the server: every request is authorised again server-side.
 */

export class ApiError extends Error {
  status: number;
  code: string | undefined;
  body: Record<string, unknown>;
  constructor(status: number, message: string, code: string | undefined, body: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

let csrfToken: string | null = null;
let lastActivity = Date.now();

type Hooks = {
  stepUp?: () => Promise<boolean>;
  sessionLost?: () => void;
  stage?: (code: string) => void;
};
const hooks: Hooks = {};

export const setCsrf = (t: string | null) => {
  csrfToken = t;
};
export const registerHooks = (h: Hooks) => Object.assign(hooks, h);
export const msSinceActivity = () => Date.now() - lastActivity;
export const touchActivity = () => {
  lastActivity = Date.now();
};

interface Options {
  /** multipart upload */
  form?: FormData;
  /** internal: this call is the retry after a step-up */
  retried?: boolean;
  /** return the raw Response (downloads) */
  raw?: boolean;
  /** do not run the step-up / session-lost handlers (auth endpoints handle their own errors) */
  quiet?: boolean;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown, opts: Options = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (csrfToken && method !== "GET") headers["X-CSRF-Token"] = csrfToken;
  let payload: BodyInit | undefined;
  if (opts.form) payload = opts.form;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: payload, credentials: "include", cache: "no-store" });
  } catch {
    throw new ApiError(0, "Cannot reach the server. Check your connection and try again.", "NETWORK", {});
  }
  touchActivity();

  if (res.ok) {
    if (opts.raw) return res as unknown as T;
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON error body */
  }
  const code = typeof data.code === "string" ? data.code : undefined;
  const message = Array.isArray(data.message) ? data.message.join("; ") : typeof data.message === "string" ? data.message : `Request failed (${res.status})`;

  if (res.status === 401 && !opts.quiet) {
    if (code === "STEP_UP_REQUIRED" && hooks.stepUp && !opts.retried) {
      if (await hooks.stepUp()) return api<T>(method, path, body, { ...opts, retried: true });
      throw new ApiError(401, "Confirmation cancelled.", "STEP_UP_CANCELLED", data);
    }
    if (code === "NO_SESSION") hooks.sessionLost?.();
    if (code === "MFA_REQUIRED" || code === "ENROL_REQUIRED") hooks.stage?.(code);
  }
  throw new ApiError(res.status, message, code, data);
}

export const get = <T>(path: string) => api<T>("GET", path);
export const post = <T = void>(path: string, body?: unknown) => api<T>("POST", path, body ?? {});
export const put = <T = void>(path: string, body?: unknown) => api<T>("PUT", path, body ?? {});
export const patch = <T = void>(path: string, body?: unknown) => api<T>("PATCH", path, body ?? {});
export const del = <T = void>(path: string, body?: unknown) => api<T>("DELETE", path, body ?? {});
export const upload = <T = unknown>(path: string, file: File, fields: Record<string, string> = {}) => {
  const f = new FormData();
  f.append("file", file);
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return api<T>("POST", path, undefined, { form: f });
};

/** Download a file (CSV / XLSX export). Goes through the same step-up handling as any other call. */
export async function download(path: string): Promise<{ blob: Blob; filename: string; sha256: string | null; rows: number }> {
  const res = await api<Response>("GET", path, undefined, { raw: true });
  const disp = res.headers.get("Content-Disposition") ?? "";
  const m = /filename="?([^";]+)"?/.exec(disp);
  return { blob: await res.blob(), filename: m?.[1] ?? "export", sha256: res.headers.get("X-Export-SHA256"), rows: Number(res.headers.get("X-Export-Rows") ?? 0) };
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const errorMessage = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Something went wrong.");
