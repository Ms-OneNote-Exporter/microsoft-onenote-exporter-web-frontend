/**
 * The CSRF token, now carried in a response body rather than a cookie.
 *
 * This exists because the cookie arrangement could never have worked. The
 * frontend is served from `microsoft-onenote-exporter.phttp.com`; the cookie
 * was set by the API origin with no `Domain` attribute, so it was host-only
 * there — and `document.cookie` only ever returns cookies scoped to the page's
 * own origin. The header therefore went out as an empty string on every request
 * and the backend refused all of them.
 *
 * Neither side's tests caught that: the backend's assert the token is set and
 * checked, this one's asserted the header is present, and both were true while
 * the value could never arrive. The tests below therefore check the *value*,
 * not the presence of a mechanism.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { api, readCsrfToken } from "./api";
import { parseSessionStatus } from "./session";

const TOKEN = "a".repeat(43);

const ACCOUNT = "someone@example.com";

function stubFetch(impl: (url: string, init: RequestInit) => Response) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  // A cookie on the frontend origin, which is exactly the situation that made
  // the old implementation look correct in a test and fail in a browser.
  document.cookie = "msout_csrf=cookie-value-should-be-ignored";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the token is never read from a cookie", () => {
  it("ignores a readable msout_csrf cookie on the page's own origin", async () => {
    const spy = stubFetch(() => ok(undefined));

    await api.submitCredential(ACCOUNT, "hunter2", TOKEN);

    const [, init] = spy.mock.calls[0]!;
    // The whole point of this change. The cookie value must not reach the wire,
    // even when one is present and readable — otherwise a stale or
    // attacker-planted cookie on the frontend origin could choose the token.
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe(TOKEN);
    expect(JSON.stringify(init.headers)).not.toContain("cookie-value");
  });

  it("presents the token it was given, not an empty string", async () => {
    const spy = stubFetch(() => ok(undefined));

    await api.submitCredential(ACCOUNT, "hunter2", TOKEN);

    const [, init] = spy.mock.calls[0]!;
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).not.toBe("");
  });
});

describe("every mutating route requires the token", () => {
  const cases: [string, () => Promise<unknown>][] = [
    ["credential", () => api.submitCredential(ACCOUNT, "pw", TOKEN)],
    ["notebooks", () => api.listNotebooks(TOKEN)],
    ["export", () => api.startExport("Personal", TOKEN)],
    ["abort", () => api.abort("e1", TOKEN)],
    ["erase", () => api.erase(TOKEN)],
  ];

  for (const [name, call] of cases) {
    it(`presents it on ${name}`, async () => {
      const spy = stubFetch(() => ok({ exportId: "e1" }));
      await call();
      const [, init] = spy.mock.calls[0]!;
      expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe(TOKEN);
    });
  }

  it("does not require one on the mint route, which has no session yet", async () => {
    // Ordering matters: `POST /api/session` creates the credential, so there is
    // nothing to derive a token from. It is the one POST without this header,
    // and it is the reason there is no chicken-and-egg.
    const spy = stubFetch(() => ok({ csrfToken: TOKEN }));
    await api.createSession("3f2504e0-4f89-11d3-9a0c-0305e82c3301", TOKEN);
    const [, init] = spy.mock.calls[0]!;
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
  });
});

describe("readCsrfToken", () => {
  it("reads the token out of the session-creation response", () => {
    expect(readCsrfToken({ csrfToken: TOKEN })).toBe(TOKEN);
    expect(readCsrfToken({ csrf_token: TOKEN })).toBe(TOKEN);
  });

  it("returns null rather than a partial token", () => {
    // A truncated or non-string value would be presented as-is and produce a
    // bare `forbidden`, which is the failure this change exists to remove.
    expect(readCsrfToken({})).toBeNull();
    expect(readCsrfToken({ csrfToken: "" })).toBeNull();
    expect(readCsrfToken({ csrfToken: 42 })).toBeNull();
    expect(readCsrfToken(null)).toBeNull();
    expect(readCsrfToken("nope")).toBeNull();
  });
});

describe("the status snapshot carries the token, so a reload recovers it", () => {
  const SNAPSHOT = {
    session: { state: "created" },
    auth: { state: "none" },
    notebooks: { state: "idle", items: [] },
    export: { state: "none", partialReason: null, id: null, notebook: null, progress: null },
    artifact: { available: false, partial: false, downloadUrl: null, fileName: null },
  };

  it("reads it from the snapshot", () => {
    const parsed = parseSessionStatus({ ...SNAPSHOT, csrfToken: TOKEN });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.csrfToken).toBe(TOKEN);
  });

  it("reports null when the backend sends none", () => {
    const parsed = parseSessionStatus(SNAPSHOT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Surfaced to the user as a version mismatch rather than papered over with
    // an empty header and a `forbidden` from every route.
    expect(parsed.value.csrfToken).toBeNull();
  });

  it("reports null for an empty string, which is worse than absent", () => {
    const parsed = parseSessionStatus({ ...SNAPSHOT, csrfToken: "" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.csrfToken).toBeNull();
  });
});
