/**
 * `T-F10` — a status refresh cannot erase the notebook list it just delivered.
 *
 * ## The bug this file exists for
 *
 * The client learned the notebook list from SSE (`notebooks-listed`, a **merge**)
 * and also rebuilt its whole state from `GET /api/session/status` (a
 * **replace**). The backend emits `session-status` immediately after accepting a
 * listing — before the runner finishes, which takes tens of seconds because it
 * launches a browser. So the two collide:
 *
 * ```
 * t+0ms     POST /notebooks -> 202
 * t+1ms     SSE session-status -> refreshStatus() starts a round trip
 * t+~15s    SSE notebooks-listed -> 3 names merged into state   <- the answer
 * t+~18s    the t+1ms trip resolves with notebooks: []          <- overwritten
 * ```
 *
 * Whether the list survives depends on whether an HTTP round trip beats a
 * 15-second listing. A cold connection or a loaded laptop wins, and the user
 * watches their notebooks disappear.
 *
 * ## Both halves are tested, and the second is not optional
 *
 * `reconcileNotebooks` must keep a fresher local list. It must **also** clear the
 * list for an account that genuinely has no notebooks — otherwise the fix
 * introduces its own bug, one that looks like success on screen. A merge that can
 * never yield an empty list is a merge that cannot be trusted.
 *
 * The `App` tests drive the real race with the status route **held open** and
 * released on demand, so the interleaving is deterministic rather than dependent
 * on timing luck.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { act, render, screen, cleanup, waitFor } from "@testing-library/react";
import { App } from "../App";
import { parseNotebooks } from "./notebooks-event";
import { reconcileNotebooks, type NotebookList } from "./session";
import { EXPECTED_PROTOCOL } from "./protocol";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const IDLE: NotebookList = { state: "idle", items: [] };
const LOADED: NotebookList = { state: "loaded", items: ["Work", "Home", "Ideas"] };

/**
 * An `EventSource` the test can push frames through.
 *
 * `emit` is handed to the constructor so a test can fire an event at a chosen
 * moment — which is the whole requirement here: the `notebooks-listed` frame has
 * to land *while* a refresh is already in flight, and that cannot be arranged by
 * waiting.
 */
function stubEventSource() {
  const instances: FakeEventSource[] = [];

  class FakeEventSource {
    close() {}
    onopen: null | (() => void) = null;
    onerror: null | (() => void) = null;
    onmessage: null | ((e: MessageEvent) => void) = null;
    constructor() {
      instances.push(this);
    }
    emit(event: string, data: unknown) {
      this.onmessage?.({
        data: JSON.stringify(data),
        lastEventId: "1",
        type: event,
      } as unknown as MessageEvent);
    }
  }

  vi.stubGlobal("EventSource", FakeEventSource);
  return instances;
}

function snapshotWith(notebooks: { state: string; items: string[] }) {
  return {
    protocol: EXPECTED_PROTOCOL,
    session: { state: "authenticated" },
    auth: { state: "valid" },
    notebooks,
    export: { state: "none" },
    artifact: { partial: false },
    csrfToken: "csrf-token-value",
  };
}

/**
 * A status route that reports an empty notebook list, with every call after the
 * first held open until `release()` is called.
 *
 * An empty list on every response is the hostile case: it is what the backend
 * genuinely answers at t+1ms, and it is the only value capable of erasing what
 * the event delivered.
 */
function stubStatusRoute(options: { hold: boolean }) {
  let calls = 0;
  let released = 0;
  const releases: (() => void)[] = [];

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
      if (url.includes("/api/session/status")) {
        calls += 1;
        const answer = {
          ok: true,
          status: 200,
          json: async () => snapshotWith({ state: "loaded", items: [] }),
        } as unknown as Response;
        if (!options.hold || calls === 1) return Promise.resolve(answer);
        return new Promise((resolve) => {
          releases.push(() => resolve(answer));
        });
      }
      if (url.includes("/api/session/notebooks")) {
        return Promise.resolve({
          ok: true,
          status: 202,
          json: async () => ({ listing: true }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({}),
      } as unknown as Response);
    }),
  );

  return {
    calls: () => calls,
    /**
     * How many held responses have been released.
     *
     * Asserted so the test cannot pass by never releasing anything — the state
     * assertion below would then be reading a screen no refresh had touched.
     */
    released: () => released,
    /** Let every held status response land. */
    release: () => {
      while (releases.length > 0) {
        released += 1;
        releases.shift()?.();
      }
    },
  };
}

describe("reconcileNotebooks: a refresh must not overwrite a fresher field", () => {
  it("keeps the local list when the list changed while the request was in flight", () => {
    // The bug, as a pure function. The snapshot was taken at revision 0 and the
    // local list was installed at revision 1, so its empty `notebooks` describes
    // a moment before the answer existed.
    expect(
      reconcileNotebooks({
        current: LOADED,
        incoming: IDLE,
        seqAtRequest: 0,
        seqNow: 1,
        listingInFlight: false,
      }),
    ).toBe(LOADED);
  });

  it("keeps the local list while a listing is in flight and the snapshot is empty", () => {
    // The second, independent guard: nothing has changed locally *yet*, because
    // the listing has not produced an event — but the snapshot still predates it.
    expect(
      reconcileNotebooks({
        current: LOADED,
        incoming: IDLE,
        seqAtRequest: 3,
        seqNow: 3,
        listingInFlight: true,
      }),
    ).toBe(LOADED);
  });

  it("clears the list for a genuinely empty account", () => {
    // The other half, and the one that keeps the fix from becoming its own bug.
    // No listing in flight, nothing changed locally: an empty snapshot is the
    // truth and must be honoured.
    expect(
      reconcileNotebooks({
        current: LOADED,
        incoming: IDLE,
        seqAtRequest: 7,
        seqNow: 7,
        listingInFlight: false,
      }),
    ).toBe(IDLE);
  });

  it("always takes a snapshot that has notebooks", () => {
    // Only an empty incoming list can be stale in a way that loses data.
    // Suppressing a non-empty one would freeze a deleted notebook on screen.
    const fresh: NotebookList = { state: "loaded", items: ["Work"] };
    expect(
      reconcileNotebooks({
        current: LOADED,
        incoming: fresh,
        seqAtRequest: 1,
        seqNow: 9,
        listingInFlight: true,
      }),
    ).toBe(fresh);
  });

  it("keeps a non-empty list over an empty snapshot that says 'listing'", () => {
    expect(
      reconcileNotebooks({
        current: LOADED,
        incoming: { state: "listing", items: [] },
        seqAtRequest: 2,
        seqNow: 2,
        listingInFlight: true,
      }),
    ).toBe(LOADED);
  });

  it("does not invent a list that was never there", () => {
    // Nothing local to protect, so an empty snapshot is simply installed — even
    // mid-listing. Inventing one would be a worse lie than an empty chooser.
    expect(
      reconcileNotebooks({
        current: IDLE,
        incoming: IDLE,
        seqAtRequest: 0,
        seqNow: 4,
        listingInFlight: true,
      }),
    ).toBe(IDLE);
  });
});

describe("T-F10: the race, driven deterministically", () => {
  it("keeps the notebooks a `notebooks-listed` event delivered, when a stale refresh resolves after it", async () => {
    // The event lands while a refresh is already in flight, and that refresh
    // then reports an empty list. The names must survive — this is the bug.
    const status = stubStatusRoute({ hold: true });
    const streams = stubEventSource();

    render(<App />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /list my notebooks/i })).toBeTruthy(),
    );

    await waitFor(() => expect(streams.length).toBeGreaterThan(0));

    // Click, so a listing is genuinely in flight.
    screen.getByRole("button", { name: /list my notebooks/i }).click();

    // The api emits these two immediately after accepting the listing, before the
    // runner has finished — which is what starts the refresh that will lose the
    // race. Reproduced here rather than assumed, because the ordering *is* the bug.
    streams[0]!.emit("auth-state", { state: "authenticating" });
    streams[0]!.emit("session-status", { state: "authenticated" });
    await waitFor(() => expect(status.calls()).toBeGreaterThan(1));

    // The listing completes, tens of seconds later in production. This is the
    // answer.
    streams[0]!.emit("notebooks-listed", { state: "loaded", items: ["Work", "Home"] });
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Work" })).toBeTruthy(),
    );

    // Now the in-flight refresh lands, carrying the snapshot taken before the
    // listing existed. This is the overwrite.
    //
    // Flushed inside `act` and then asserted: without the flush the assertion
    // runs before React has applied the state update and passes on the list that
    // is *still* on screen — which is exactly how a test of this bug passes while
    // the bug is present.
    await act(async () => {
      status.release();
    });
    // Two refreshes are held: the api emits `auth-state` and `session-status` back
    // to back, and both trigger one. Asserting an exact count would pin an
    // incidental detail; what matters is that at least one landed.
    expect(status.released()).toBeGreaterThan(0);
    expect(screen.getByRole("radio", { name: "Work" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Home" })).toBeTruthy();
  });

  it("clears the list when a refresh reports an empty one and no listing is in flight", async () => {
    // The regression guard for the fix itself, driven through the component.
    // The first status read carries a list, a second read reports empty, and the
    // list must go — otherwise the merge has invented notebooks that do not
    // exist and an empty account would render as a full chooser.
    let calls = 0;
    let releaseSecond: (() => void) | null = null;
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
        if (url.includes("/api/session/status")) {
          calls += 1;
          const empty = {
            ok: true,
            status: 200,
            json: async () => snapshotWith({ state: "idle", items: [] }),
          } as unknown as Response;
          if (calls === 1) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => snapshotWith({ state: "loaded", items: ["Work"] }),
            } as unknown as Response);
          }
          // Held so it lands only after the list is on screen — the same ordering
          // as the race above, with no listing in flight.
          return new Promise((resolve) => {
            releaseSecond = () => resolve(empty);
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({}),
        } as unknown as Response);
      }),
    );
    const streams = stubEventSource();

    render(<App />);
    await waitFor(() => expect(screen.getByRole("radio", { name: "Work" })).toBeTruthy());

    // An `auth-state` nudge triggers the second read, which reports empty.
    await waitFor(() => expect(streams.length).toBeGreaterThan(0));
    streams[0]!.emit("auth-state", { state: "none" });
    await waitFor(() => expect(releaseSecond).not.toBeNull());

    releaseSecond!();
    await waitFor(() => expect(screen.queryByRole("radio", { name: "Work" })).toBeNull());
    // And the empty state is stated, rather than an empty chooser that looks like
    // success with nothing to explain it.
    expect(document.body.textContent).toMatch(/no notebooks listed yet/i);
  });
});

describe("T-F10: the event payload", () => {
  it("keeps a `notebooks-listed` list that arrives with no `state`", () => {
    // The event *is* the completed listing, so a payload with items and no state
    // is a listing. Defaulting to anything else drops the user's notebooks into a
    // wrong branch — a false alarm on the one screen where that is most annoying.
    expect(parseNotebooks({ items: ["Work"] })).toEqual({
      state: "loaded",
      items: ["Work"],
    });
  });

  it("treats an unrecognised notebook state as loaded rather than failed", () => {
    expect(parseNotebooks({ state: "who-knows", items: ["Work"] }).state).toBe("loaded");
  });

  it("reads an absent or malformed payload as an empty loaded list", () => {
    // Never `idle`: an unreadable event is not the absence of a listing.
    expect(parseNotebooks(null)).toEqual({ state: "loaded", items: [] });
    expect(parseNotebooks({ items: "not an array" }).items).toEqual([]);
    expect(parseNotebooks({ items: ["Work", 7, null] }).items).toEqual(["Work"]);
  });
});