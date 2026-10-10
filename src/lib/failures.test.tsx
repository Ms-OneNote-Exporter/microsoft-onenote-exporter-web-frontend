/**
 * `T-F9` — a failed mutating call tells the user what to do.
 *
 * Both halves are cheap and both fail today:
 *
 * 1. a rejected `listNotebooks` must **render something** — a real 409 here, and
 *    the *designed* answer to "clicked too early" rather than an edge case;
 * 2. it must leave **no unhandled rejection** — the original defect, `void`
 *    discarding a promise that rejects.
 *
 * The mapping itself is asserted separately below, because the case that matters
 * is the one a status code cannot distinguish: two different 409s, two different
 * instructions, and the backend that already tells them apart.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { App } from "../App";
import { ApiError } from "./api";
import { EXPECTED_PROTOCOL } from "./protocol";
import { describeFailure } from "./failures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A snapshot for a signed-in session, so the picker renders. */
const SNAPSHOT = {
  protocol: EXPECTED_PROTOCOL,
  session: { state: "authenticated", expiresAt: null },
  auth: { state: "valid", lastCheckedAt: null },
  notebooks: { state: "idle", items: [] },
  export: { state: "none" },
  artifact: { partial: false },
  csrfToken: "csrf-token-value",
};

/**
 * A fetch stub whose notebook POST rejects with the given response.
 *
 * `unhandled` is the assertion that matters most and the one a normal DOM
 * assertion cannot make: an unhandled rejection is invisible in the rendered
 * output, so a test that only looks at the screen would pass while the defect
 * this file exists to fix is still shipping.
 */
function stubListingFailure(
  response: { status: number; body: unknown },
  notebooks: string[] = ["Work"],
): { rejections: unknown[] } {
  const rejections: unknown[] = [];
  const onUnhandled = (event: PromiseRejectionEvent) => {
    rejections.push(event.reason);
    event.preventDefault();
  };
  window.addEventListener("unhandledrejection", onUnhandled);
  // Vitest's own handler would fail the run before the assertion is reached, so
  // the stub is consumed and re-asserted explicitly below.
  afterEach(() => window.removeEventListener("unhandledrejection", onUnhandled));

  stubEventSource();

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
      if (url.includes("/api/session/notebooks")) {
        return Promise.resolve({
          ok: false,
          status: response.status,
          json: async () => response.body,
        } as unknown as Response);
      }
      if (url.includes("/api/session/status")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ ...SNAPSHOT, notebooks: { state: "loaded", items: notebooks } }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as unknown as Response);
    }),
  );

  return { rejections };
}

/**
 * jsdom has no `EventSource`, and a signed-in session opens one on mount — so
 * every test here needs a stub. A no-op that never fires, because none of these
 * tests are about the stream.
 *
 * The `listeners` registry is not decoration: the transport registers a handler
 * for every name in the contract, and a stub without `addEventListener` throws
 * `TypeError: source.addEventListener is not a function` inside `render(<App />)`.
 * Nothing is guarded here on purpose — a stub that absorbed that call would let
 * the missing wire come back silently.
 */
function stubEventSource() {
  vi.stubGlobal(
    "EventSource",
    class {
      close() {}
      onopen: null | (() => void) = null;
      onerror: null | (() => void) = null;
      onmessage: null | ((e: MessageEvent) => void) = null;
      readonly listeners = new Map<string, Set<EventListener>>();
      addEventListener(type: string, listener: EventListener | null) {
        if (!listener) return;
        const forType = this.listeners.get(type) ?? new Set<EventListener>();
        forType.add(listener);
        this.listeners.set(type, forType);
      }
      removeEventListener(type: string, listener: EventListener | null) {
        if (!listener) return;
        this.listeners.get(type)?.delete(listener);
      }
    },
  );
}

async function renderPickerAndList() {
  render(<App />);
  const button = await screen.findByRole("button", { name: /list my notebooks/i });
  button.click();
  return button;
}

describe("T-F9: a failed listing is surfaced", () => {
  it("renders an explanation when the listing request is refused", async () => {
    stubListingFailure({ status: 409, body: { error: "not authenticated" } });
    await renderPickerAndList();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/still signing in/i);
  });

  it("leaves no unhandled rejection", async () => {
    const { rejections } = stubListingFailure({
      status: 409,
      body: { error: "not authenticated" },
    });
    await renderPickerAndList();
    await screen.findByRole("alert");

    // The original defect: `void api.listNotebooks(...)` with no `.catch`, so a
    // rejection escaped as an unhandled rejection and no state was ever touched.
    // A DOM assertion cannot catch this — the failure produced no markup to
    // assert on — which is why it is asserted directly.
    await waitFor(() => {
      expect(rejections).toEqual([]);
    });
  });

  it("re-enables the button after a failure, so the user can retry", async () => {
    stubListingFailure({ status: 409, body: { error: "not authenticated" } });
    const button = await renderPickerAndList();
    await screen.findByRole("alert");

    // Not left disabled. A message that says "try again in a moment" next to a
    // permanently greyed-out button is advice the page contradicts.
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("cannot be clicked twice while the request is in flight", async () => {
    // The compounding case. The second click earns a 503 from the backend, so a
    // button that accepts one turns a working listing into a refusal.
    let releasePost: () => void = () => {};
    stubEventSource();
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
        if (url.includes("/api/session/notebooks")) {
          // Held open, so the pending window is observable.
          return new Promise((resolve) => {
            releasePost = () =>
              resolve({
                ok: true,
                status: 202,
                json: async () => ({ listing: true }),
              } as unknown as Response);
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => SNAPSHOT,
        } as unknown as Response);
      }),
    );

    render(<App />);
    const button = await screen.findByRole("button", { name: /list my notebooks/i });
    button.click();

    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    // A second click while disabled must not produce a second POST.
    button.click();
    const posts = vi
      .mocked(fetch)
      .mock.calls.filter(([u]) => String(u).includes("/api/session/notebooks"));
    expect(posts).toHaveLength(1);

    releasePost();
  });

  it("says a listing is already running for a 503", async () => {
    stubListingFailure({
      status: 503,
      body: {
        error: "a notebook listing is already running; try again shortly",
        reason: "busy",
        retryable: true,
      },
    });
    await renderPickerAndList();

    expect((await screen.findByRole("alert")).textContent).toMatch(
      /already running/i,
    );
  });

  it("says sign in again when retrying cannot help", async () => {
    // The case that makes the status code insufficient. Same 409 as the "still
    // signing in" case, opposite instruction.
    stubListingFailure({
      status: 409,
      body: {
        error: "sign in again before listing notebooks",
        reason: "no_auth",
        retryable: false,
      },
    });
    await renderPickerAndList();

    const text = (await screen.findByRole("alert")).textContent ?? "";
    expect(text).toMatch(/sign in again/i);
    expect(text).not.toMatch(/still signing in/i);
  });

  it("clears the previous message on a retry rather than stacking alerts", async () => {
    stubListingFailure({ status: 409, body: { error: "not authenticated" } });
    const button = await renderPickerAndList();
    await screen.findByRole("alert");

    button.click();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});

describe("T-F9: the mapping keeps the cases apart", () => {
  it("treats an absent `retryable` as unknown, not as false", () => {
    // The distinction that would send a user back to the password form when all
    // they needed was to wait three seconds.
    const message = describeFailure(new ApiError(409, "409 /api/session/notebooks"), "list");
    expect(message).toMatch(/try again in a moment/i);
  });

  it("honours `retryable: false` over the status code", () => {
    const message = describeFailure(
      new ApiError(409, "409", "sign in again before listing notebooks", "no_auth", false),
      "list",
    );
    expect(message).toMatch(/will not help/i);
  });

  it("distinguishes an export already running from a session not ready", () => {
    const running = describeFailure(
      new ApiError(409, "409", "an export is already running"),
      "start",
    );
    const notReady = describeFailure(new ApiError(409, "409", "not authenticated"), "start");
    expect(running).toMatch(/already running/i);
    expect(notReady).toMatch(/not ready/i);
    expect(running).not.toBe(notReady);
  });

  it("warns that an export may still be running when the abort fails", () => {
    // A failed cancellation is not a stopped export, and saying only "could not
    // stop" would leave the user believing it had.
    const message = describeFailure(new ApiError(502, "502"), "abort");
    expect(message).toMatch(/may still be running/i);
  });

  it("handles a network failure with no status at all", () => {
    const message = describeFailure(new TypeError("Failed to fetch"), "list");
    expect(message).toMatch(/could not be reached/i);
  });

  it("names the status for anything unrecognised", () => {
    const message = describeFailure(new ApiError(418, "418", "teapot"), "list");
    expect(message).toMatch(/418/);
  });
});