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

type FetchOpts = Omit<RequestInit, "body"> & {
  body?: unknown;
  /**
   * The session's CSRF token, presented as the required header.
   *
   * **Required on every mutating route**, and required by the type rather than
   * by convention: a call site cannot compile without it. That is the point.
   * The previous arrangement read the token out of a `msout_csrf` cookie with
   * `document.cookie`, which cannot work across origins — `document.cookie`
   * only ever returns cookies scoped to the page's own origin, and the cookie is
   * set by the API origin. The header therefore went out as an empty string on
   * every request and the backend refused all of them with a bare `forbidden`.
   *
   * The token now arrives in a response body instead, which a foreign origin
   * cannot read: CORS lets a non-allowlisted origin *trigger* a request but not
   * read the response. That is what makes body delivery safe here, and it is
   * the same reason a cookie is safe to leave out of the picture entirely.
   */
  csrfToken?: string;
};

/**
 * A `string` body is transmitted verbatim; anything else is JSON-encoded.
 *
 * This distinction is the whole reason the credential route works. The server
 * declines to parse the credential, so JSON-encoding it would send
 * `"hunter2"` — quotes included — and a password containing a quote or a
 * backslash would reach the server as a *different* password than the one the
 * user typed. The header follows the same rule for the same reason: declaring
 * `text/plain` and sending a JSON body is a mismatch, not a hardening.
 */
function encodeBody(body: unknown): {
  payload: string;
  isRaw: boolean;
} {
  return typeof body === "string"
    ? { payload: body, isRaw: true }
    : { payload: JSON.stringify(body), isRaw: false };
}

/**
 * `credentials: "include"` is mandatory, not cosmetic. The session cookie is
 * `SameSite=None` because the two origins are cross-site, so it is only sent
 * when credentials are explicitly included. Forgetting it produces a UI that
 * 401s on every call and a reconnect loop that never recovers.
 */
async function request<T>(path: string, opts: FetchOpts = {}): Promise<T> {
  const { body, headers, ...rest } = opts;
  const encoded = body === undefined ? null : encodeBody(body);

  const merged: Record<string, string> = {
    // A raw string body declares its own content type at the call site, so
    // only the JSON case is defaulted here.
    ...(encoded && !encoded.isRaw
      ? { "Content-Type": "application/json" }
      : {}),
    // CSRF layer 1 (§3.3): the token is presented as a header that is not
    // CORS-safelisted, so its presence forces a preflight, and a preflight only
    // succeeds for an allowlisted origin. A non-allowlisted origin therefore
    // cannot cause the browser to transmit a mutating body at all.
    //
    // Sent on GET as well. The header is not needed there — layer 1 only covers
    // state-changing requests — but sending it uniformly means a request cannot
    // be distinguished by whether it carries the token, and a caller cannot
    // forget to attach it on the one route that mattered.
    ...(opts.csrfToken !== undefined ? { "X-CSRF-Token": opts.csrfToken } : {}),
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
  if (encoded) init.body = encoded.payload;

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

/**
 * Read a CSRF token out of a response body, defensively.
 *
 * A foreign origin cannot read a cross-origin response, so a token delivered in
 * the body is not readable by an attacker — the same property that made the
 * cookie approach safe is what makes this one safe. It is also *narrower* than a
 * cookie: nothing on the page can read it except this code, and it is gone on
 * reload, which is why the status snapshot has to carry it too.
 */
export function readCsrfToken(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  // Both spellings accepted while the field name is unconfirmed with the
  // backend. `matched` on the session status reports which one arrived.
  const value = record.csrfToken ?? record.csrf_token;
  return typeof value === "string" && value !== "" ? value : null;
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
   * Creates the session. `guid` identifies it, `secret` authorises it.
   *
   * This is the one route where the body *is* JSON, and it is a different
   * secret from the credential: the session secret is generated here in the
   * browser and authorises the session (PLAN-v3 §4). The server stores only
   * its sha256 and compares with `timingSafeEqual`, because a compromised
   * Component A could generate a weak one — which is why the API validates the
   * 43-character shape mechanically instead of trusting this file.
   *
   * Neither value ever appears in a URL. The secret is returned in an HttpOnly
   * cookie, so it does not come back to us either.
   * The response carries the session's CSRF token, which every later mutating
   * request must present. It used to arrive as a readable `msout_csrf` cookie,
   * which cannot work from a different origin — see the note on `FetchOpts`.
   */
  createSession: (guid: string, secret: string) =>
    request<unknown>("/api/session", {
      method: "POST",
      body: { guid, secret },
    }),

  /**
   * The credential route: the Microsoft password, sent as bytes and not
   * parsed on either side. No `PUT`, no `PATCH`, no retry — one submission, one
   * outcome.
   *
   * Deliberately not trimmed at all. Browsers strip every CR and LF from
   * `<input type="password">` before this ever sees the value, so there is no
   * paste artefact left to remove; a trailing space is genuinely part of the
   * password and guessing wrong about it corrupts it.
   *
   * `csrfToken` is a required parameter rather than an optional one, so a call
   * site that forgets it does not compile.
   */
  submitCredential: (password: string, csrfToken: string) =>
    request<void>("/api/session/credential", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: password,
      csrfToken,
    }),

  /** The snapshot behind landing, refresh-restore and the export page. */
  status: () => request<unknown>("/api/session/status"),

  /**
   * Starts the notebook listing. A `POST` and not a `GET`: listing runs a CLI
   * in the runner, and a `GET` that mutates server state is the kind of route
   * that later gets prefetched or crawled. The result arrives over SSE.
   */
  listNotebooks: (csrfToken: string) =>
    request<void>("/api/session/notebooks", { method: "POST", csrfToken }),

  startExport: (notebook: string, csrfToken: string) =>
    request<{ exportId: string }>("/api/export", {
      method: "POST",
      body: { notebook },
      csrfToken,
    }),

  abort: (exportId: string, csrfToken: string) =>
    request<void>(`/api/export/${encodeURIComponent(exportId)}/abort`, {
      method: "POST",
      csrfToken,
    }),

  /** Invalidates the server row *and* expires the cookie — both, in that call. */
  erase: (csrfToken: string) =>
    request<void>("/api/session/erase", { method: "POST", csrfToken }),
};
