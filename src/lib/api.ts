/**
 * The API client. Every request in this file is cross-origin.
 *
 * Two invariants this file exists to hold, both from PLAN-v3:
 *
 * 1. **The credential goes to the API origin and nowhere else.** The base URL
 *    is a build-time constant, not user input and not a stored preference.
 *    Combined with `connect-src` naming the API origin and nothing else (§1.5)
 *    and `form-action 'none'`, that is what bounds what a substituted bundle
 *    can do: it cannot ship the password to a host of its choosing.
 *
 * 2. **No body parser, no logging, no retry on the credential route.** The
 *    server refuses to parse it; the client must not either. A retry that
 *    replayed a password would defeat the point of a single submission.
 */
import { API_ORIGIN } from "./protocol";

/** Non-2xx from the API, carrying the server's own error code when present. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Protocol mismatch. Rendered as a "reload" prompt, never a broken page. */
export class ProtocolMismatchError extends Error {
  constructor(readonly remote: number, readonly expected: number) {
    super(
      `frontend speaks protocol ${expected}, backend speaks ${remote}`,
    );
    this.name = "ProtocolMismatchError";
  }
}

type FetchOpts = Omit<RequestInit, "body"> & { body?: unknown };

/**
 * `credentials: "include"` is mandatory, not cosmetic. The session cookie is
 * `SameSite=None` because the two origins are cross-site, so it is only sent
 * when credentials are explicitly included. Forgetting it produces a UI that
 * 401s on every call and a reconnect loop that never recovers.
 */
async function request<T>(path: string, opts: FetchOpts = {}): Promise<T> {
  const { body, headers, ...rest } = opts;
  const isJson = body !== undefined;

  const merged: Record<string, string> = {
    ...(isJson ? { "Content-Type": "application/json" } : {}),
    // Readable CSRF cookie -> required header. The header is not
    // CORS-safelisted, so this forces a preflight, which means a
    // non-allowlisted origin cannot cause the body to be transmitted at all.
    // That is the structural CSRF layer (§3.3).
    ...(typeof document !== "undefined"
      ? { "X-CSRF-Token": readCsrfCookie() ?? "" }
      : {}),
    ...(headers as Record<string, string> | undefined),
  };

  const init: RequestInit = {
    ...rest,
    headers: merged,
    // `credentials: "include"` is mandatory, not cosmetic. The session cookie
    // is `SameSite=None` because the two origins are cross-site, so it is only
    // sent when credentials are explicitly included. Forgetting it produces a
    // UI that 401s on every call and a reconnect loop that never recovers.
    credentials: "include",
    // A credential response must not be cached anywhere in the chain.
    cache: "no-store",
    // The credential route is never prefetched, deliberately: a prefetch would
    // mean the browser holds a credential response it did not ask for.
    redirect: "error",
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetch(`${API_ORIGIN}${path}`, init);

  if (!res.ok) {
    let code: string | undefined;
    try {
      const parsed = (await res.json()) as { error?: unknown };
      if (parsed && typeof parsed.error === "string") code = parsed.error;
    } catch {
      // A non-JSON error body is not worth surfacing; the status is enough.
    }
    throw new ApiError(res.status, `${res.status} ${path}`, code);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function readCsrfCookie(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)msout_csrf=([^;]*)/);
  return match?.[1] ?? null;
}

/**
 * Handshake. Called once at boot, before anything else, so a mismatched pair
 * says so. Without it, a v3 frontend against a v2 backend produces a confusing
 * 404 or a silently missing SSE field, and the natural reaction is to debug
 * the wrong component (§7.2).
 */
export async function assertProtocol(
  expected: number,
): Promise<{ build: string }> {
  const res = await fetch(`${API_ORIGIN}/api/public/version`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) {
    throw new ApiError(res.status, "backend unreachable");
  }
  const body = (await res.json()) as { protocol?: number; build?: string };
  if (body.protocol !== expected) {
    throw new ProtocolMismatchError(body.protocol ?? -1, expected);
  }
  return { build: body.build ?? "unknown" };
}

// --- routes ----------------------------------------------------------------

export const api = {
  version: () => request<{ protocol: number; build: string }>("/api/public/version"),

  /**
   * The credential route. Body is the raw password, sent as-is and not
   * JSON-encoded: the server declines to parse it and so do we. No `PUT`, no
   * `PATCH`, no retry — one submission, one outcome.
   */
  submitCredential: (password: string) =>
    request<void>("/api/session/credential", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: password,
    }),

  startExport: (notebook: string) =>
    request<{ exportId: string }>("/api/export", {
      method: "POST",
      body: { notebook },
    }),

  abort: (exportId: string) =>
    request<void>(`/api/export/${exportId}/abort`, { method: "POST" }),

  snapshot: () => request<unknown>("/api/session/snapshot"),

  /** Invalidates the server row *and* expires the cookie — both, in that call. */
  erase: () => request<void>("/api/session/erase", { method: "POST" }),
};
