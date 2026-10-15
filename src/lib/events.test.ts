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
 *
 * ## And the fake is the second half of the file
 *
 * This transport listened for none of the 19 contract names for the whole life
 * of the product, and the suite was green throughout, because the fake handed
 * `onmessage` an object with a `type` property — a shape the wire never carries
 * and a browser never delivers. A mock that implements the flow itself keeps
 * passing when the real one is deleted; here it agreed with the bug. So
 * `FakeEventSource` now registers listeners for real and parses bytes.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { openEventStream } from "./events";
import { EVENT_TYPES } from "./events-contract";
import { API_ORIGIN } from "./protocol";

/**
 * One frame, transcribed from `encodeEvent` in `api/src/sse.ts:91`:
 * `` id: <n>\nevent: <type>\ndata: <json>\n\n ``.
 *
 * The bytes are the assertion. An `event:` line goes to that name's listener and
 * the `onmessage` fallback never fires for it.
 */
const NOTEBOOKS_LISTED_FRAME =
  'id: 1\nevent: notebooks-listed\ndata: {"state":"loaded","items":["Work","Home"]}\n\n';

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

  /**
   * What `addEventListener` registered, by event name.
   *
   * Read by the structural test rather than by any delivered frame: a fake that
   * can be satisfied by simulating the transport's own behaviour proves nothing
   * about the transport.
   */
  readonly listeners = new Map<string, Set<EventListener>>();

  /** Parser state — the bytes that have arrived and the frame being built. */
  private buffered = "";
  private lastEventId = "";
  private frameType = "";
  private frameData: string[] = [];

  constructor(url: string, options?: { withCredentials?: boolean }) {
    this.url = url;
    this.options = options;
    FakeEventSource.instances.push(this);
  }

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

  /** The names with a listener, in registration order. */
  listenerNames(): string[] {
    return [...this.listeners.keys()];
  }

  /**
   * Abort the connection. The listeners stay registered, because a real
   * `EventSource` keeps them: `close()` drops the connection and the ready
   * state, not the handlers. Delivery stops anyway — see `deliver`.
   */
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

  /**
   * A transport failure, straight to `onerror`.
   *
   * Fires even after `close()`, deliberately: stopping a reconnect is the
   * transport's `closed` flag, and that guard is under test too — a fake that
   * swallowed the event would make that test vacuous.
   */
  emitError() {
    this.onerror?.();
  }

  /**
   * Dispatch a named frame to the registry — **never** to `onmessage`.
   *
   * Routing it there is how the previous fake agreed with the bug: the frame
   * would reach the consumer and the transport could register no listeners at
   * all and still pass.
   */
  emitNamed(type: string, data: string, id = "1") {
    this.deliver({ data, lastEventId: id, type } as unknown as MessageEvent);
  }

  /**
   * The browser's own transport error: an `error` event at the source with no
   * `data`. It reaches both `onerror` and every listener registered for
   * `"error"`, because `onerror` is an IDL attribute the DOM registers as an
   * ordinary listener for that name. The api's own `error` event has the same
   * name and arrives through `feed` instead.
   */
  emitTransportError() {
    if (this.closed) return;
    const event = { type: "error" } as unknown as MessageEvent;
    for (const listener of this.listenersFor("error")) listener(event as unknown as Event);
    this.onerror?.();
  }

  /**
   * Push wire bytes in, the way a browser consumes a stream.
   *
   * A line at a time, dispatching on the blank line, so a frame may arrive in
   * pieces: a browser does not wait for a whole frame to land in one read, and a
   * parser that insisted on one would pass against a stream that never
   * cooperates.
   */
  feed(chunk: string) {
    this.buffered += chunk;
    let newline = this.buffered.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffered.slice(0, newline).replace(/\r$/, "");
      this.buffered = this.buffered.slice(newline + 1);
      // A blank line ends the frame. A line opening with `:` is a comment — how
      // the api sends its keepalive (`api/src/sse.ts:215-219`), and never
      // surfaced to the page.
      if (line === "") this.flush();
      else if (!line.startsWith(":")) this.readField(line);
      newline = this.buffered.indexOf("\n");
    }
  }

  private readField(line: string) {
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // The single space after the colon is framing, not value.
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") this.lastEventId = value;
    else if (field === "event") this.frameType = value;
    else if (field === "data") this.frameData.push(value);
    // Anything else — `retry:` — is not this api's vocabulary, and a browser
    // ignores what it does not model.
  }

  private flush() {
    const data = this.frameData;
    const type = this.frameType;
    this.frameData = [];
    this.frameType = "";
    // A frame with no `data:` line is never dispatched, which is what makes the
    // keepalive comment a no-op rather than an empty message.
    if (data.length === 0) return;
    const event = {
      data: data.join("\n"),
      lastEventId: this.lastEventId,
      type: type || "message",
    } as unknown as MessageEvent;
    // The browser's rule: an `event:` line names the listener; its absence
    // means `message`, which is `onmessage`.
    if (event.type === "message") {
      if (!this.closed) this.onmessage?.(event);
      return;
    }
    this.deliver(event);
  }

  private listenersFor(type: string): EventListener[] {
    return [...(this.listeners.get(type) ?? [])];
  }

  /** One dispatched event. A closed source delivers nothing, and keeps them. */
  private deliver(event: MessageEvent) {
    if (this.closed) return;
    for (const listener of this.listenersFor(event.type)) listener(event as unknown as Event);
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

  it("does not reconnect from the liveness timer once closed", () => {
    vi.useFakeTimers();
    const close = openEventStream({ onEvent: () => {} });
    FakeEventSource.last().emitOpen();

    close();
    vi.advanceTimersByTime(120_000);

    // The same leak as the line above, from the other teardown path: a timer
    // that outlives the stream fires and opens an `EventSource` for a page that
    // has gone. One per unmount, for nothing.
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

/**
 * ## Liveness: the stream that dies without saying so
 *
 * `onerror` is not enough. When a stream dies the way real ones die — a laptop
 * asleep past the NAT's UDP timeout, a handover to another interface — the
 * socket is not closed, no `close` reaches either end, and `EventSource` sits in
 * `OPEN` forever. Nothing is thrown, nothing is dispatched, nothing appears in
 * the console. The user watches a progress bar that has stopped moving and has
 * no way to tell it from one that is merely quiet.
 *
 * So the client insists on hearing something: the api emits a named `keepalive`
 * event every 15 s, and silence for three of those periods is treated as death.
 */
describe("liveness", () => {
  /** Transcribed from `emitKeepalive()` in `api/src/sse.ts`. */
  const KEEPALIVE_FRAME = "event: keepalive\ndata: {}\n\n";

  it("reconnects when no frame arrives inside the timeout", () => {
    vi.useFakeTimers();
    const states: string[] = [];
    openEventStream({ onEvent: () => {}, onState: (s) => states.push(s) });
    const first = FakeEventSource.last();
    first.emitOpen();

    // One keepalive period is not evidence of anything: the api sends one of
    // those every 15 s, so a stream that has said nothing for that long is
    // merely early. A timeout below the keepalive would kill a healthy stream
    // every time.
    vi.advanceTimersByTime(15_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(first.closed).toBe(false);

    // Three unanswered ones are.
    vi.advanceTimersByTime(30_000);
    expect(first.closed).toBe(true);
    // Reported like any other reconnect: the ring buffer replays what was
    // missed, so this is a pause, not a gap in the data.
    expect(states).toContain("replaying");

    vi.advanceTimersByTime(1_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    // A new stream, and `T-S4` on it: the flag is not a property of the page.
    expect(FakeEventSource.last().options?.withCredentials).toBe(true);
    // …and it can hear again.
    FakeEventSource.last().emitOpen();
    vi.advanceTimersByTime(30_000);
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("does not start counting before the stream opens", () => {
    vi.useFakeTimers();
    openEventStream({ onEvent: () => {} });
    const first = FakeEventSource.last();

    // A connect that has not answered yet is not a dead stream — a slow TLS
    // handshake or a cold backend must not be mistaken for a dead one. The
    // browser's own `error` covers a connect that genuinely fails.
    vi.advanceTimersByTime(120_000);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(first.closed).toBe(false);
  });

  it("counts a keepalive frame as proof of life and forwards nothing", () => {
    vi.useFakeTimers();
    const seen: { id: string; event: string; data: unknown }[] = [];
    openEventStream({ onEvent: (id, event, data) => seen.push({ id, event, data }) });
    const source = FakeEventSource.last();
    source.emitOpen();

    // Four keepalive periods, a frame every 20 s, so the stream is never silent
    // for as long as the timeout.
    for (let elapsed = 0; elapsed < 80_000; elapsed += 20_000) {
      vi.advanceTimersByTime(20_000);
      source.feed(KEEPALIVE_FRAME);
    }

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(source.closed).toBe(false);
    // And none of them reached the consumer. `useEventStream` calls `setLast` on
    // every event it is handed, so forwarding these would be a React re-render
    // every 15 s for the life of the page, carrying nothing.
    expect(seen).toEqual([]);
  });

  it("counts any frame as proof of life, not only a keepalive", () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    openEventStream({ onEvent: (_id, event) => seen.push(event) });
    const source = FakeEventSource.last();
    source.emitOpen();

    vi.advanceTimersByTime(30_000);
    source.feed(NOTEBOOKS_LISTED_FRAME);
    vi.advanceTimersByTime(30_000);

    // The event itself still lands, and the quiet stretch either side of it does
    // not add up to a dead stream.
    expect(seen).toEqual(["notebooks-listed"]);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("counts a frame it cannot parse as proof of life", () => {
    vi.useFakeTimers();
    const seen: unknown[] = [];
    openEventStream({ onEvent: (_id, _event, data) => seen.push(data) });
    const source = FakeEventSource.last();
    source.emitOpen();

    vi.advanceTimersByTime(30_000);
    source.feed('event: keepalive\ndata: {not json\n\n');
    vi.advanceTimersByTime(30_000);

    // The bytes arrived, and that is the only thing this timer measures.
    // Arming it after the parse instead would make the api's payload shape
    // load-bearing for whether a stream is considered alive.
    expect(seen).toEqual([]);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("schedules one reconnect when an error and a dead stream race", () => {
    vi.useFakeTimers();
    openEventStream({ onEvent: () => {} });
    const first = FakeEventSource.last();
    first.emitOpen();

    // The stream errors 40 s in, five seconds short of the liveness timeout. If
    // `onerror` left the liveness timer armed it would fire afterwards and open
    // a second `EventSource` alongside the one already being replaced — which is
    // doubled events from two live streams, and a hub subscriber per stray.
    vi.advanceTimersByTime(40_000);
    first.emitError();
    vi.advanceTimersByTime(10_000);

    // Past the 45 s deadline either way, so a surviving liveness timer would
    // have fired and opened a third stream by now.
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(first.closed).toBe(true);
  });
});

describe("named events: what the api actually writes", () => {
  it("(a) delivers a named `notebooks-listed` frame, and the unnamed path never sees it", () => {
    const seen: { id: string; event: string; data: unknown }[] = [];
    openEventStream({ onEvent: (id, event, data) => seen.push({ id, event, data }) });
    const source = FakeEventSource.last();

    // Two writes, because a stream arrives in pieces and a parser that needed
    // the whole frame in one read would pass against a server that never
    // cooperates.
    source.feed(NOTEBOOKS_LISTED_FRAME.slice(0, 18));
    source.feed(NOTEBOOKS_LISTED_FRAME.slice(18));

    // Once, not twice: the named listener and the `onmessage` fallback are
    // disjoint by SSE semantics, and a consumer that handled one answer twice
    // would advance the list revision twice for it.
    expect(seen).toEqual([
      { id: "1", event: "notebooks-listed", data: { state: "loaded", items: ["Work", "Home"] } },
    ]);
  });

  it("(b) registers a listener for every name in the contract", () => {
    openEventStream({ onEvent: () => {} });
    const registered = FakeEventSource.last().listenerNames();

    // Name by name, because the contract is a transcription of `api/src/sse.ts:28`
    // and a name missing here is one the page will never hear of.
    for (const name of EVENT_TYPES) {
      expect(registered).toContain(name);
    }
    // And nothing beyond it, so a typo cannot hide inside a matching count.
    expect(registered).toEqual([...EVENT_TYPES]);
  });

  it("(c) still delivers an unnamed frame", () => {
    const seen: { id: string; event: string; data: unknown }[] = [];
    openEventStream({ onEvent: (id, event, data) => seen.push({ id, event, data }) });

    FakeEventSource.last().feed('id: 7\ndata: {"state":"loaded","items":[]}\n\n');

    // The fallback is not the path today's traffic takes — every api frame is
    // named — but it is the only handler that would fire if one arrived without
    // an `event:` line, and dropping it would make the fix a swap rather than an
    // addition.
    expect(seen).toEqual([{ id: "7", event: "message", data: { state: "loaded", items: [] } }]);
  });

  it("(d) re-registers on the new source after a reconnect, cookie and all", () => {
    vi.useFakeTimers();
    const seen: { id: string; event: string; data: unknown }[] = [];
    openEventStream({ onEvent: (id, event, data) => seen.push({ id, event, data }) });
    const first = FakeEventSource.last();

    first.emitError();
    vi.advanceTimersByTime(1_000);
    const second = FakeEventSource.last();

    expect(second).not.toBe(first);
    // `T-S4` on the reconnect and not only on the first attempt: the second
    // source is a different object and the flag has to be given to it too.
    expect(second.options?.withCredentials).toBe(true);
    // The registry belongs to the source that was thrown away, so registering
    // outside `connect()` is the obvious way to write this — and it silently
    // leaves every reconnect deaf again.
    expect(second.listenerNames()).toEqual([...EVENT_TYPES]);

    second.feed(NOTEBOOKS_LISTED_FRAME);
    expect(seen).toEqual([
      { id: "1", event: "notebooks-listed", data: { state: "loaded", items: ["Work", "Home"] } },
    ]);
  });

  it("(e) stops delivering once the returned close function has run", () => {
    const seen: unknown[] = [];
    const close = openEventStream({ onEvent: (_id, _event, data) => seen.push(data) });
    const source = FakeEventSource.last();

    close();

    // The handlers are still registered — a real `EventSource` does not remove
    // them on close — so this asserts the teardown rather than the fake
    // forgetting something. A stop that only worked because a mock dropped its
    // handlers would be a stop nobody had exercised.
    expect(source.listenerNames()).toEqual([...EVENT_TYPES]);
    source.feed(NOTEBOOKS_LISTED_FRAME);
    expect(seen).toEqual([]);
  });

  it("(f) does not report the browser's own transport error as an `error` event", () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const states: string[] = [];
    openEventStream({ onEvent: (_id, event) => seen.push(event), onState: (s) => states.push(s) });
    const source = FakeEventSource.last();
    source.emitOpen();

    // An `error` event with no `data`. `App.tsx` clears `listingPending` on an
    // `error` event, so a transport error that reached the consumer would
    // report a listing failure the user never had, on every reconnect.
    source.emitTransportError();

    expect(seen).toEqual([]);
    // …and the stream still recovers, because `onerror` — not this listener —
    // owns the reconnect.
    vi.advanceTimersByTime(1_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(states).toContain("replaying");

    // The guard is against the browser's event, not against the name: the api's
    // own `error` frame is how a failed listing is reported and must still land.
    FakeEventSource.last().feed('id: 9\nevent: error\ndata: {"error":"notebooks-failed"}\n\n');
    expect(seen).toEqual(["error"]);
  });

  it("(g) drops a malformed named frame rather than tearing the stream down", () => {
    const seen: unknown[] = [];
    const states: string[] = [];
    openEventStream({
      onEvent: (_id, _event, data) => seen.push(data),
      onState: (s) => states.push(s),
    });
    const source = FakeEventSource.last();
    source.emitOpen();

    source.feed('id: 1\nevent: export-progress\ndata: {"exportId":\n\n');

    // One bad frame is the server's problem, not a reason to drop a stream the
    // user is watching an export through. The named path has to hold the line
    // the unnamed one has held since the first version.
    expect(seen).toEqual([]);
    expect(source.closed).toBe(false);
    expect(states).not.toContain("replaying");
  });

  it("(h) delivers a `listing-log` frame, with the frame id the dedupe keys on", () => {
    const seen: { id: string; event: string; data: unknown }[] = [];
    openEventStream({ onEvent: (id, event, data) => seen.push({ id, event, data }) });
    const source = FakeEventSource.last();

    // Transcribed from `encodeEvent` plus the api's `publish()` for this case:
    // `{line, level}` and **no `id`** in the payload, because a listing has no
    // artifact behind it. The id that arrives is therefore the hub's frame id,
    // which is the only replay key the frame has — the one the page dedupes on.
    source.feed('id: 77\nevent: listing-log\ndata: {"line":"Found 3 notebooks!","level":"INFO"}\n\n');

    expect(seen).toEqual([
      {
        id: "77",
        event: "listing-log",
        data: { line: "Found 3 notebooks!", level: "INFO" },
      },
    ]);
  });
});