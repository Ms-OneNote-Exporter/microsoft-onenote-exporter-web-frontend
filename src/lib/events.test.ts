/**
 * `T-S4` and the SSE transport.
 *
 * The `withCredentials` assertion is the point of this file. That flag is the
 * single most likely bug in the whole cross-origin design and it fails
 * silently: without it the browser omits the cross-site session cookie, every
 * reconnect 401s, and the UI shows "reconnecting…" forever with nothing in the
 * console. There is no error event for a 401 on an `EventSource` — the ready
 * state just stays `CONNECTING`.
 *
 * So it is asserted structurally, at construction, rather than left to review.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { openEventStream } from "./events";
import { API_ORIGIN } from "./protocol";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static last(): FakeEventSource {
    const last = FakeEventSource.instances.at(-1);
    if (!last) throw new Error("no EventSource was constructed");
    return last;
  }

  readonly url: string;
  readonly options: { withCredentials?: boolean } | undefined;
  closed = false;

  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string, options?: { withCredentials?: boolean }) {
    this.url = url;
    this.options = options;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emitOpen() {
    this.onopen?.();
  }

  emitMessage(data: unknown, id = "1", type = "message") {
    this.onmessage?.({ data: JSON.stringify(data), lastEventId: id, type } as MessageEvent);
  }

  emitRaw(data: string, id = "1", type = "message") {
    this.onmessage?.({ data, lastEventId: id, type } as MessageEvent);
  }

  emitError() {
    this.onerror?.();
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("T-S4: the EventSource carries the session cookie", () => {
  it("sets withCredentials at construction", () => {
    openEventStream({ onEvent: () => {} });

    // Asserted on the constructor argument, not on behaviour, because the
    // failure mode is silent: there is no observable event that distinguishes
    // "sent the cookie" from "did not".
    expect(FakeEventSource.last().options?.withCredentials).toBe(true);
  });

  it("targets the session-scoped stream endpoint", () => {
    openEventStream({ onEvent: () => {} });
    expect(FakeEventSource.last().url).toBe(`${API_ORIGIN}/api/session/events`);
  });

  it("emits connecting before the first open", () => {
    const states: string[] = [];
    openEventStream({ onEvent: () => {}, onState: (s) => states.push(s) });
    expect(states).toEqual(["connecting"]);
  });

  it("reports open once the stream connects", () => {
    const states: string[] = [];
    openEventStream({ onEvent: () => {}, onState: (s) => states.push(s) });

    FakeEventSource.last().emitOpen();

    expect(states).toEqual(["connecting", "open"]);
  });

  it("parses frames and hands the id, event name and data through", () => {
    const seen: { id: string; event: string; data: unknown }[] = [];
    openEventStream({ onEvent: (id, event, data) => seen.push({ id, event, data }) });

    FakeEventSource.last().emitMessage({ exportId: "x", state: "running" }, "42", "export-progress");

    expect(seen).toEqual([
      { id: "42", event: "export-progress", data: { exportId: "x", state: "running" } },
    ]);
  });

  it("ignores a malformed frame rather than tearing the stream down", () => {
    const seen: unknown[] = [];
    const states: string[] = [];
    openEventStream({
      onEvent: (_id, _event, data) => seen.push(data),
      onState: (s) => states.push(s),
    });
    const source = FakeEventSource.last();
    source.emitOpen();

    source.emitRaw("{not json");

    // One bad frame is the server's problem, not a reason to drop a stream the
    // user is watching an export through.
    expect(seen).toEqual([]);
    expect(source.closed).toBe(false);
    expect(states).not.toContain("replaying");
  });
});

describe("reconnect and replay", () => {
  it("reconnects with backoff after an error", () => {
    vi.useFakeTimers();
    openEventStream({ onEvent: () => {} });
    expect(FakeEventSource.instances).toHaveLength(1);

    FakeEventSource.last().emitError();
    expect(FakeEventSource.instances).toHaveLength(1);

    // No immediate reconnect: a tight loop against a 401ing endpoint is how the
    // UI ends up showing "reconnecting…" forever.
    vi.advanceTimersByTime(1_000);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("doubles the delay on each consecutive failure, up to the ceiling", () => {
    vi.useFakeTimers();
    openEventStream({ onEvent: () => {} });

    FakeEventSource.last().emitError();
    vi.advanceTimersByTime(1_000); // -> attempt 2

    FakeEventSource.last().emitError();
    vi.advanceTimersByTime(1_999);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3); // waited 2s

    FakeEventSource.last().emitError();
    vi.advanceTimersByTime(4_000);
    expect(FakeEventSource.instances).toHaveLength(4);
  });

  it("reports replaying on a reconnect, so the UI can say progress will catch up", () => {
    vi.useFakeTimers();
    const states: string[] = [];
    openEventStream({ onEvent: () => {}, onState: (s) => states.push(s) });

    FakeEventSource.last().emitError();
    vi.advanceTimersByTime(1_000);

    // The server's ring buffer replays from Last-Event-ID, so a reconnect is
    // not a gap in the data — but saying so is better than a frozen progress
    // bar with no explanation.
    expect(states).toContain("replaying");
  });

  it("resets the backoff after a successful reconnect", () => {
    vi.useFakeTimers();
    openEventStream({ onEvent: () => {} });

    FakeEventSource.last().emitError();
    vi.advanceTimersByTime(1_000);
    FakeEventSource.last().emitOpen();

    // A later failure should wait 1s again, not the accumulated value.
    FakeEventSource.last().emitError();
    vi.advanceTimersByTime(1_000);
    expect(FakeEventSource.instances).toHaveLength(3);
  });
});

describe("teardown", () => {
  it("closes the stream and stops reconnecting", () => {
    vi.useFakeTimers();
    const states: string[] = [];
    const close = openEventStream({ onEvent: () => {}, onState: (s) => states.push(s) });
    const first = FakeEventSource.last();

    close();
    vi.advanceTimersByTime(60_000);

    expect(first.closed).toBe(true);
    // One stream, opened once. A teardown that still reconnects is a leak that
    // only shows up as doubled events under StrictMode.
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(states.at(-1)).toBe("closed");
  });

  it("does not reconnect after an error once closed", () => {
    vi.useFakeTimers();
    const close = openEventStream({ onEvent: () => {} });

    close();
    FakeEventSource.last().emitError();
    vi.advanceTimersByTime(60_000);

    expect(FakeEventSource.instances).toHaveLength(1);
  });
});