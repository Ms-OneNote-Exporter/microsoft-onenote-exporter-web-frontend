/**
 * `T-F5` — the boot shell's four states.
 *
 * The requirement is a *version-mismatch screen*, not a broken page. That
 * distinction is the whole point: a mismatched pair is a known, expected,
 * self-inflicted condition of two independently deployed components (PLAN-v3
 * §7.2), and it should say so in words a user can act on. Rendering a blank
 * page or a raw exception instead sends whoever is debugging it to the wrong
 * repository.
 *
 * `App` is rendered here with `fetch` stubbed, which is the closest this
 * repository gets to an integration test. It still cannot see CORS, cookies or
 * route existence — see the Status section of the README.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { App } from "./App";
import { EXPECTED_PROTOCOL } from "./lib/protocol";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubVersion(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response),
  );
}

describe("T-F5: the handshake screen", () => {
  it("shows a checking state before the handshake resolves", () => {
    // Never resolves, so the pending state is what renders.
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));
    render(<App />);
    expect(screen.getByText(/checking backend/i)).toBeTruthy();
  });

  it("names both protocols on a mismatch, and offers a reload", async () => {
    stubVersion(200, { protocol: EXPECTED_PROTOCOL - 1, build: "old" });
    render(<App />);

    const heading = await screen.findByRole("heading", { name: /out of date/i });
    expect(heading).toBeTruthy();

    // Both numbers. A message that says only "mismatch" leaves the reader
    // guessing which side needs the fix.
    const text = document.body.textContent ?? "";
    expect(text).toContain(String(EXPECTED_PROTOCOL));
    expect(text).toContain(String(EXPECTED_PROTOCOL - 1));
    expect(screen.getByRole("button", { name: /reload/i })).toBeTruthy();
  });

  it("treats a missing protocol field as a mismatch rather than a pass", async () => {
    // The dangerous failure is a backend that omits `protocol`, which would
    // otherwise compare `undefined !== 3` and look like a bug in the comparison
    // rather than a version problem.
    stubVersion(200, { build: "no-protocol-field" });
    render(<App />);

    await screen.findByRole("heading", { name: /out of date/i });
  });

  it("says the service is unreachable rather than rendering an error", async () => {
    stubVersion(503, {});
    render(<App />);

    const heading = await screen.findByRole("heading", {
      name: /cannot reach the service/i,
    });
    expect(heading).toBeTruthy();

    // The reassurance matters: this page is served independently, so it loading
    // while the service is down is expected and loses nothing.
    expect(document.body.textContent).toMatch(/served independently/i);
  });

  it("reaches the ready state and renders the consent disclosure", async () => {
    stubVersion(200, { protocol: EXPECTED_PROTOCOL, build: "abc123" });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/api/public/version")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ protocol: EXPECTED_PROTOCOL, build: "abc123" }),
          } as unknown as Response);
        }
        // The status snapshot, which the shell reads once ready. A session-less
        // 404 is the normal answer for a first-time visitor.
        return Promise.resolve({
          ok: false,
          status: 404,
          json: async () => ({ error: "no_session" }),
        } as unknown as Response);
      }),
    );

    render(<App />);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: /before you sign in/i })).toBeTruthy(),
    );
    expect(document.body.textContent).toMatch(/Backend protocol 3 confirmed/);
  });

  it("treats a 401 on the status route as 'no session', not as an error", async () => {
    // Found by loading the real deployed site: every first-time visitor saw a red
    // alert reading "The session state could not be read (401)". A 401 is the
    // service answering that this visitor has no session, which is the expected
    // state — not a failure worth an alert.
    stubVersion(200, { protocol: EXPECTED_PROTOCOL, build: "abc123" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve(
          url.includes("/api/public/version")
            ? ({
                ok: true,
                status: 200,
                json: async () => ({ protocol: EXPECTED_PROTOCOL, build: "abc123" }),
              } as unknown as Response)
            : ({
                ok: false,
                status: 401,
                json: async () => ({ error: "unauthorised" }),
              } as unknown as Response),
        ),
      ),
    );

    render(<App />);

    await screen.findByRole("heading", { name: /before you sign in/i });

    expect(document.body.textContent).not.toMatch(/could not be read/i);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still reports a 5xx on the status route, which is a genuine failure", async () => {
    // The other half of the same distinction: a 500 leaves the question open,
    // and claiming "no session" there could cost a user the session they have.
    stubVersion(200, { protocol: EXPECTED_PROTOCOL, build: "abc123" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve(
          url.includes("/api/public/version")
            ? ({
                ok: true,
                status: 200,
                json: async () => ({ protocol: EXPECTED_PROTOCOL, build: "abc123" }),
              } as unknown as Response)
            : ({
                ok: false,
                status: 503,
                json: async () => ({ error: "unavailable" }),
              } as unknown as Response),
        ),
      ),
    );

    render(<App />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(document.body.textContent).toMatch(/could not be read \(503\)/);
  });

  it("does not open the event stream before a session exists", async () => {
    // `EventSource` must not be constructed for a visitor with no session: it
    // would open a connection that 404s and, per the note in `events.ts`, would
    // sit in CONNECTING with no error event to explain why.
    const EventSourceCtor = vi.fn();
    vi.stubGlobal("EventSource", EventSourceCtor);

    stubVersion(200, { protocol: EXPECTED_PROTOCOL, build: "abc123" });
    render(<App />);

    await screen.findByRole("heading", { name: /before you sign in/i });
    expect(EventSourceCtor).not.toHaveBeenCalled();
  });
});