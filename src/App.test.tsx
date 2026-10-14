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
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { act, render, screen, cleanup, waitFor } from "@testing-library/react";
import { App } from "./App";
import { EXPECTED_PROTOCOL } from "./lib/protocol";
import { FRONTEND_VERSION } from "./lib/version";
import pkg from "../package.json";

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

  /**
   * The version line.
   *
   * Two components deploy independently, so "which one am I looking at?" is a
   * question with two answers, and a report carrying only a protocol number
   * cannot be acted on. The backend's `build` was already fetched at handshake
   * and then discarded, so this asserts against the value that was always
   * available rather than a new request.
   */
  describe("T-F8: the header names both versions", () => {
    it("shows this build's version and the backend's", async () => {
      stubVersion(200, { protocol: EXPECTED_PROTOCOL, build: "deadbeefcafe" });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) =>
          Promise.resolve(
            url.includes("/api/public/version")
              ? ({
                  ok: true,
                  status: 200,
                  json: async () => ({ protocol: EXPECTED_PROTOCOL, build: "deadbeefcafe" }),
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

      const line = screen.getByTestId("versions").textContent ?? "";
      expect(line).toContain(FRONTEND_VERSION);
      // The backend's own build string, not the protocol. Two components, two
      // build identifiers; showing one and calling it "the version" is what
      // this assertion exists to prevent.
      expect(line).toContain("deadbeefcafe");
    });

    it("prints the version from package.json, not a placeholder", () => {
      // The value is substituted at build time, so a hardcoded fallback would
      // pass every render test above while shipping a lie.
      expect(FRONTEND_VERSION).toBe(pkg.version);
      expect(FRONTEND_VERSION).not.toBe("");
      expect(FRONTEND_VERSION).not.toMatch(/undefined|null|NaN/);
    });

    it("says 'unknown' rather than blank when the backend omits `build`", async () => {
      // `build` is optional in the handshake response. An empty line reads as a
      // rendering failure, and `undefined` in the text is worse than either.
      stubVersion(200, { protocol: EXPECTED_PROTOCOL });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) =>
          Promise.resolve(
            url.includes("/api/public/version")
              ? ({
                  ok: true,
                  status: 200,
                  json: async () => ({ protocol: EXPECTED_PROTOCOL }),
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

      expect(screen.getByTestId("versions").textContent).toContain("unknown");
    });

    it("still names both protocols on a mismatch screen", async () => {
      // The version line lives in the ready header, so a mismatched pair — the
      // case where the versions most need comparing — does not get it. This
      // asserts what the mismatch screen does say, so the gap is a decision
      // rather than an oversight.
      stubVersion(200, { protocol: EXPECTED_PROTOCOL - 1, build: "old-build" });
      render(<App />);

      await screen.findByRole("heading", { name: /out of date/i });
      const text = document.body.textContent ?? "";
      expect(text).toContain(String(EXPECTED_PROTOCOL));
      expect(text).toContain(String(EXPECTED_PROTOCOL - 1));
    });
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

/**
 * The block showing what the runner printed while it works.
 *
 * ## The silence this ends
 *
 * `@msout/microsoft-onenote-list-notebooks` used to emit nothing at all during a
 * listing, so between the click and `notebooks-listed` — tens of seconds, in a
 * container launching a browser — the page said nothing, and a user could not tell
 * "working" from "stuck". The line stream now exists end to end, and these cases
 * assert the parts of it that are decisions rather than plumbing: the shape of a
 * line, the replay dedupe, the cap, and the fact that a refresh cannot take any
 * of it away.
 *
 * They run through `App` with real bytes on a fake source, because every one of
 * those is a property of the page rather than of a component in isolation: the
 * handler only runs because the transport registered a listener for the name, and
 * a test that dispatched a frame by hand would pass if that registration were
 * deleted.
 */

/** A signed-in session, which is what puts the export page — and the block — on screen. */
const SIGNED_IN = {
  session: { state: "authenticated" },
  auth: { state: "valid" },
  notebooks: { state: "loaded", items: ["Work"] },
  export: { state: "none" },
  artifact: { downloadUrl: null, partial: false },
  csrfToken: "csrf-token",
};

/**
 * One frame, in the bytes `encodeEvent` writes (`api/src/sse.ts:92`):
 * `` id: <n>\nevent: <type>\ndata: <json>\n\n ``.
 */
function frame(type: string, data: unknown, id: string): string {
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * The transport fake again, and the reason it is here rather than imported is
 * that `events.test.ts` owns the full one — backoff, teardown, the transport's
 * own `error` event. What this file needs from it is narrower and different:
 * bytes in, named dispatch out, onto whatever the page registered.
 *
 * Dispatching by `event.type` to that name's listener is the part that must
 * match the real thing. An `EventSource` whose fake routes everything to
 * `onmessage` would satisfy a page that had registered no listeners at all, which
 * is the exact bug this chain of repositories spent its life shipping.
 */
class WireEventSource {
  static instances: WireEventSource[] = [];

  static last(): WireEventSource {
    const last = WireEventSource.instances.at(-1);
    if (!last) throw new Error("no EventSource was constructed");
    return last;
  }

  readonly listeners = new Map<string, Set<EventListener>>();
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  /** Parser state — the bytes that have arrived and the frame being built. */
  private buffered = "";
  private lastEventId = "";
  private frameType = "";
  private frameData: string[] = [];

  constructor(readonly url: string) {
    WireEventSource.instances.push(this);
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

  close() {
    this.closed = true;
  }

  /** Push wire bytes in, a line at a time, dispatching on the blank line. */
  feed(chunk: string) {
    this.buffered += chunk;
    let newline = this.buffered.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffered.slice(0, newline).replace(/\r$/, "");
      this.buffered = this.buffered.slice(newline + 1);
      if (line === "") this.flush();
      else if (!line.startsWith(":")) this.readField(line);
      newline = this.buffered.indexOf("\n");
    }
  }

  private readField(line: string) {
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") this.lastEventId = value;
    else if (field === "event") this.frameType = value;
    else if (field === "data") this.frameData.push(value);
  }

  private flush() {
    const data = this.frameData;
    const type = this.frameType;
    this.frameData = [];
    this.frameType = "";
    if (data.length === 0) return;
    if (this.closed) return;
    const event = {
      data: data.join("\n"),
      lastEventId: this.lastEventId,
      type: type || "message",
    } as unknown as MessageEvent;
    // The browser's rule: an `event:` line names the listener, its absence means
    // `message`. The page registers one listener per contract name, so a frame
    // for a name it does not carry would be dropped — which is precisely how a
    // listing log went missing before the name was transcribed.
    if (event.type === "message") {
      this.onmessage?.(event);
      return;
    }
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      listener(event as unknown as Event);
    }
  }
}

describe("the terminal block", () => {
  beforeEach(() => {
    WireEventSource.instances = [];
  });

  /**
   * The export page, with a stream attached and a counter of the snapshot reads.
   *
   * The status route answers a *signed-in* session, because with no session the
   * page shows the consent disclosure and the stream is never opened — which is
   * itself asserted above, and which would make every case below vacuous.
   */
  async function renderExportPage() {
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        url.includes("/api/public/version")
          ? ({
              ok: true,
              status: 200,
              json: async () => ({ protocol: EXPECTED_PROTOCOL, build: "abc123" }),
            } as unknown as Response)
          : ({ ok: true, status: 200, json: async () => SIGNED_IN } as unknown as Response),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", WireEventSource);

    render(<App />);
    await screen.findByRole("heading", { name: /choose a notebook/i });

    return {
      source: WireEventSource.last(),
      statusReads: () =>
        fetchMock.mock.calls.filter((call) => String(call[0]).includes("/api/session/status"))
          .length,
    };
  }

  /** Bytes onto the wire, inside `act` because they re-render the page. */
  function feed(source: WireEventSource, bytes: string) {
    act(() => source.feed(bytes));
  }

  function block(): HTMLElement {
    return screen.getByTestId("log-block");
  }

  it("says it has nothing yet, rather than rendering an empty box", async () => {
    await renderExportPage();

    // An empty box is indistinguishable from a block that failed to render, and
    // the whole point of the block is that the page is no longer silent.
    expect(block().textContent).toMatch(/nothing has been logged yet/i);
  });

  it("shows a listing line as it arrives, with its level as text", async () => {
    const { source } = await renderExportPage();

    feed(
      source,
      frame("listing-log", { line: "Network idle timeout - continuing anyway…", level: "WARN" }, "11"),
    );

    // The marker is the level word in the text, not a colour: the line still says
    // what happened when it is copied out of the page or read by something that
    // cannot see.
    expect(block().textContent).toContain("! WARN: Network idle timeout");
  });

  it("shows an export line, and keeps every line of one export", async () => {
    const { source } = await renderExportPage();

    // Same `id` in both payloads: on `export-log` that is the **export** id, not
    // the frame's. A dedupe keyed on it would keep the first line of the whole
    // export and drop the other forty thousand.
    feed(source, frame("export-log", { id: "artifact-1", line: "Walking page 1" }, "21"));
    feed(source, frame("export-log", { id: "artifact-1", line: "Walking page 2" }, "22"));

    expect(block().textContent).toContain("Walking page 1");
    expect(block().textContent).toContain("Walking page 2");
  });

  it("prints a frame that arrives twice once, because a replay is not new work", async () => {
    const { source } = await renderExportPage();

    // The runner replays its ring from the pump's `since` cursor on every
    // reconnect, so the bytes go out twice. A terminal that printed both would
    // tell the user the line happened twice.
    const bytes = frame("listing-log", { line: "Found 3 notebooks!", level: "INFO" }, "31");
    feed(source, bytes);
    feed(source, bytes);

    const occurrences = (block().textContent ?? "").split("Found 3 notebooks!").length - 1;
    expect(occurrences).toBe(1);
  });

  it("caps the block at 500 lines, dropping the oldest and saying how many", async () => {
    const { source } = await renderExportPage();

    // One write, because the point is the cap rather than the transport's
    // tolerance of a frame arriving in pieces.
    let bytes = "";
    for (let n = 1; n <= 512; n += 1) {
      bytes += frame("listing-log", { line: `line ${n}`, level: "INFO" }, String(n));
    }
    feed(source, bytes);

    const text = block().textContent ?? "";
    // The newest survive; the oldest are the ones the cap takes, because what is
    // left has to be what is happening now.
    expect(text).toContain("line 512");
    expect(text).not.toContain("line 1\n");
    // And the loss is stated. A silently truncated block is the same "everything
    // looks fine" shape as the export card that used to claim a complete vault
    // over one that was missing a page.
    expect(screen.getByTestId("log-dropped").textContent).toContain(
      "Showing the last 500 of 512 lines",
    );
  });

  it("keeps the replay set bounded, and the bound is real", async () => {
    const { source } = await renderExportPage();

    // Past MAX_SEEN_FRAME_IDS (1000) — the api's ring buffer is 500 frames and the
    // set keeps twice that, so the set must evict rather than grow for the life of
    // the session.
    let bytes = "";
    for (let n = 1; n <= 1300; n += 1) {
      bytes += frame("listing-log", { line: `line ${n}`, level: "INFO" }, String(n));
    }
    feed(source, bytes);

    // Inside the window, a replay is still one line: the dedupe's whole job.
    const recent = frame("listing-log", { line: "line 1200", level: "INFO" }, "1200");
    feed(source, recent);
    const occurrences = (block().textContent ?? "").split("line 1200").length - 1;
    expect(occurrences).toBe(1);

    // And outside it, the bound is what it is: an id evicted before the window can
    // no longer be recognised, so a replay of it prints twice. Pinned rather than
    // left incidental, because it is the trade the bound buys — a fixed few
    // kilobytes against a line that shows twice on a replay the api's ring buffer
    // cannot have produced.
    const evicted = frame("listing-log", { line: "line 1", level: "INFO" }, "1");
    feed(source, evicted);
    // The line was capped out of the visible block 800 lines ago, so its presence
    // now can only be the re-append — and the total the view reports is where that
    // shows: 1300 seen, then one more.
    expect(block().textContent).toContain("line 1");
    expect(screen.getByTestId("log-dropped").textContent).toContain(
      "Showing the last 500 of 1301 lines",
    );
  });

  it("keeps the block through a refresh, which carries no lines at all", async () => {
    const { source, statusReads } = await renderExportPage();
    feed(source, frame("listing-log", { line: "Found 3 notebooks!", level: "INFO" }, "41"));
    const before = statusReads();

    // `session-status` is the refresh trigger, and the snapshot it reads back
    // has no field for any of this. A block rebuilt from the snapshot would be
    // empty from here on — the silent block this change exists to remove.
    feed(source, frame("session-status", SIGNED_IN, "42"));
    await waitFor(() => expect(statusReads()).toBeGreaterThan(before));

    expect(block().textContent).toContain("Found 3 notebooks!");
  });

  it("starts a fresh block when the next run is queued", async () => {
    const { source } = await renderExportPage();
    feed(source, frame("listing-log", { line: "Found 3 notebooks!", level: "INFO" }, "51"));
    expect(block().textContent).toContain("Found 3 notebooks!");

    // A reader who still has the last run's output above the new one cannot tell
    // where this one begins, which is why a terminal clears its screen on a new
    // command rather than scrolling on.
    feed(source, frame("export-queued", { id: "artifact-2", notebook: "Work" }, "52"));

    expect(block().textContent).not.toContain("Found 3 notebooks!");
    expect(block().textContent).toMatch(/nothing has been logged yet/i);
  });
});
/**
 * Which challenge gets which screen.
 *
 * ## What was broken
 *
 * A `challenge` of kind `code` rendered a notice saying "follow the prompt on your
 * phone" — advice for a phone-approval — and the api answered the same challenge with
 * `login-failed {reason: "challenge-not-supported"}`. So a user holding the code
 * Microsoft had just texted was told, in two places, that their password was wrong.
 *
 * The split is therefore a decision, not a refactor: `code` needs an input and the
 * other kinds do not. These cases go through `App` on real bytes because the choice is
 * made in the render tree, and a test of the component alone would pass whatever the
 * page decided to render for it.
 */
describe("an outstanding MFA challenge", () => {
  beforeEach(() => {
    WireEventSource.instances = [];
  });

  /** The export page with a stream attached, and its `fetch` spy. */
  async function renderWithStream() {
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        url.includes("/api/public/version")
          ? ({
              ok: true,
              status: 200,
              json: async () => ({ protocol: EXPECTED_PROTOCOL, build: "abc123" }),
            } as unknown as Response)
          : ({ ok: true, status: 200, json: async () => SIGNED_IN } as unknown as Response),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", WireEventSource);

    render(<App />);
    await screen.findByRole("heading", { name: /choose a notebook/i });

    return { source: WireEventSource.last(), fetchMock };
  }

  function feed(source: WireEventSource, bytes: string) {
    act(() => source.feed(bytes));
  }

  it("asks a code challenge for the code, instead of advising the phone", async () => {
    const { source } = await renderWithStream();

    feed(
      source,
      frame(
        "challenge",
        {
          kind: "code",
          label: "Enter the code we sent to your phone",
          number: null,
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
        },
        "61",
      ),
    );

    expect(
      screen.getByRole("heading", { name: /enter the code microsoft sent you/i }),
    ).toBeTruthy();
    expect(screen.getByLabelText(/sign-in code/i)).toBeTruthy();
    // The notice it replaces said "follow the prompt on your phone", which is advice
    // for a challenge the user acts on without typing anything.
    expect(document.body.textContent).not.toMatch(/follow the prompt on your phone/i);
  });

  it("keeps showing the number for a phone-approval challenge, with no input", async () => {
    const { source } = await renderWithStream();

    feed(
      source,
      frame(
        "challenge",
        {
          kind: "phone-approval",
          label: "Tap approve in your phone",
          number: "42 918 337",
          expiresAt: null,
        },
        "62",
      ),
    );

    // There is no code to type on this path — an input asking for six digits would be
    // a question the user cannot answer.
    expect(screen.queryByLabelText(/sign-in code/i)).toBeNull();
    expect(screen.getByLabelText(/number to match/i).textContent).toBe("42 918 337");
  });

  it("sends the code to the answer route with the session's CSRF token", async () => {
    const { source, fetchMock } = await renderWithStream();
    feed(
      source,
      frame(
        "challenge",
        { kind: "code", label: "", number: null, expiresAt: null },
        "63",
      ),
    );

    const input = screen.getByLabelText(/sign-in code/i) as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "123456");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      screen.getByRole("button", { name: /send code/i }).click();
    });

    await waitFor(() => {
      const posted = fetchMock.mock.calls.find((call) =>
        String(call[0]).includes("/api/session/challenge/answer"),
      );
      expect(posted).toBeTruthy();
      expect((posted![1] as RequestInit).method).toBe("POST");
      expect(JSON.parse(String((posted![1] as RequestInit).body))).toEqual({
        code: "123456",
      });
      // The token comes from the snapshot. Without it the server's hook refuses the
      // request and the form fails with a bare `forbidden`.
      const headers = (posted![1] as RequestInit).headers as Record<string, string>;
      expect(headers["X-CSRF-Token"]).toBe(SIGNED_IN.csrfToken);
    });
  });

  it("drops the prompt on challenge-seen, so a second tab stops showing an input", async () => {
    const { source } = await renderWithStream();
    feed(
      source,
      frame("challenge", { kind: "code", label: "", number: null, expiresAt: null }, "64"),
    );
    expect(screen.getByLabelText(/sign-in code/i)).toBeTruthy();

    // `challenge-seen` says accepted, not correct — only the login can know that, and
    // it says so on this same stream. So this clears the prompt and nothing else: a
    // wrong code still has to come back as a failure rather than as silence.
    feed(source, frame("challenge-seen", {}, "65"));

    expect(screen.queryByLabelText(/sign-in code/i)).toBeNull();
  });
});