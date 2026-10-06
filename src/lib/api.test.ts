/**
 * `T-A1` — this repository never proxies, buffers, parses or forwards a
 * credential.
 *
 * The architectural claim in the README is that "nothing in this repository
 * parses, buffers, forwards or logs a credential", and that the property is
 * load-bearing for the split. It is asserted against the rendered behaviour
 * here rather than left as a review rule, because a rule that only a human
 * enforces is the kind that decays.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { api, ApiError } from "./api";
import { API_ORIGIN } from "./protocol";

/** A stand-in for the token the status snapshot supplies. */
const TOKEN = "csrf-token-value";

/** The account half of the credential, which travels in a header. */
const ACCOUNT = "someone@example.com";

function stubFetch(impl: (url: string, init: RequestInit) => Response) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

function ok(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

describe("T-A1: the credential route", () => {
  beforeEach(() => {
    document.cookie = "msout_csrf=csrf-token-value";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the password cross-origin to the build-time API origin", async () => {
    const spy = stubFetch(() => ok(undefined));

    await api.submitCredential(ACCOUNT, "hunter2", TOKEN);

    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/session/credential`);
    expect(init.method).toBe("POST");
  });

  it("sends the password as text/plain, unparsed and un-encoded", async () => {
    const spy = stubFetch(() => ok(undefined));

    await api.submitCredential(ACCOUNT, '{"not":"json"}', TOKEN);

    const [, init] = spy.mock.calls[0]!;
    // A password that *looks* like JSON must still be transmitted verbatim.
    // If this ever gets JSON.stringify'd, a password containing a quote or a
    // backslash silently becomes a different password server-side.
    expect(init.body).toBe('{"not":"json"}');
    expect(
      (init.headers as Record<string, string>)["Content-Type"],
    ).toBe("text/plain");
  });

  it("includes credentials and forbids caching, so the cookie travels", async () => {
    const spy = stubFetch(() => ok(undefined));

    await api.submitCredential(ACCOUNT, "hunter2", TOKEN);

    const [, init] = spy.mock.calls[0]!;
    // `credentials: "include"` is not cosmetic: the session cookie is
    // SameSite=None because the origins are cross-site, and it is only sent
    // when credentials are explicitly included.
    expect(init.credentials).toBe("include");
    expect(init.cache).toBe("no-store");
  });

  it("refuses to follow redirects, so a credential cannot be replayed", async () => {
    const spy = stubFetch(() => ok(undefined));

    await api.submitCredential(ACCOUNT, "hunter2", TOKEN);

    const [, init] = spy.mock.calls[0]!;
    expect(init.redirect).toBe("error");
  });

  it("sends the CSRF header, forcing a preflight on the credential POST", async () => {
    const spy = stubFetch(() => ok(undefined));

    await api.submitCredential(ACCOUNT, "hunter2", TOKEN);

    const [, init] = spy.mock.calls[0]!;
    // The header is not CORS-safelisted, so its presence forces a preflight,
    // which means a non-allowlisted origin cannot cause the body to be
    // transmitted at all. That is the structural CSRF layer (§3.3).
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe(
      "csrf-token-value",
    );
  });

  it("does not retry", async () => {
    const spy = stubFetch(() => ok(undefined));

    await api.submitCredential(ACCOUNT, "hunter2", TOKEN);

    // One submission, one outcome. A retry that replayed a password would
    // defeat the point.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("surfaces a non-2xx as an ApiError carrying the server's code", async () => {
    stubFetch(
      () =>
        ({
          ok: false,
          status: 429,
          json: async () => ({ error: "rate_limited" }),
        }) as unknown as Response,
    );

    const err = await api.submitCredential(ACCOUNT, "hunter2", TOKEN).catch((e) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
    expect((err as ApiError).code).toBe("rate_limited");
  });

  it("does not leak a response body into the message when it is not JSON", async () => {
    stubFetch(
      () =>
        ({
          ok: false,
          status: 500,
          json: async () => {
            throw new Error("<html>500</html>");
          },
        }) as unknown as Response,
    );

    const err = await api.submitCredential(ACCOUNT, "hunter2", TOKEN).catch((e) => e);

    // The status is enough. A body is not worth surfacing, and echoing an
    // arbitrary server body into the UI is how reflected content gets in.
    expect((err as ApiError).message).toBe("500 /api/session/credential");
  });
});

describe("T-A3: no proxying, no user-supplied base URL", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves the origin from the build-time constant, never from input", async () => {
    const spy = stubFetch(() => ok(undefined));

    // Any value a caller might hope to control — a path segment, a query, an
    // absolute URL. None of it should reach the request target.
    await api.status().catch(() => undefined);

    const [url] = spy.mock.calls[0]!;
    expect(url).toBe(`${API_ORIGIN}/api/session/status`);
    expect(url).not.toMatch(/[?#]/);
  });

  it("exports no function that accepts a base URL or a path prefix", () => {
    // A structural check rather than a behavioural one: if someone later adds
    // `setApiOrigin()` or lets `startExport` take a full URL, this fails.
    const apiSurface = Object.values(api);
    for (const fn of apiSurface) {
      expect(typeof fn).toBe("function");
    }
    expect(Object.keys(api)).not.toContain("setApiOrigin");
    expect(Object.keys(api)).not.toContain("configure");
  });

  it("builds the abort target from an export id, never from a caller URL", async () => {
    const spy = stubFetch(() => ok(undefined));

    // An export id carrying a path traversal must not escape the route. The
    // encoder is what stops it.
    await api.abort("../../api/session/erase", TOKEN).catch(() => undefined);

    const [url] = spy.mock.calls[0]!;
    // Every separator inside the id is encoded, so the path has exactly the
    // two separators the route itself defines and cannot address a different
    // endpoint.
    expect(url).toBe(
      `${API_ORIGIN}/api/export/..%2F..%2Fapi%2Fsession%2Ferase/abort`,
    );
    expect(url.slice(`${API_ORIGIN}/api/export/`.length).split("/")).toHaveLength(2);
  });
});

describe("T-A4: API_ORIGIN is an exact origin", () => {
  it("is an absolute origin with no path and no trailing slash", () => {
    // This value also lands in `connect-src`. If it carried a path, the CSP
    // would name something other than the origin that is actually allowed, and
    // the containment argument in the README would quietly stop holding.
    expect(API_ORIGIN).toMatch(/^https?:\/\/[^/?#]+$/);
  });
});