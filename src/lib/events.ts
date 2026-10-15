/**
 * Cross-origin SSE.
 *
 * `withCredentials: true` is the single most likely bug in this whole design
 * and it fails silently. Without it the browser omits the cross-site session
 * cookie, every reconnect 401s, and the UI shows "reconnecting…" forever with
 * nothing in the console. There is no error event for a 401 on an
 * `EventSource` — the ready state just stays `CONNECTING`. This is asserted
 * explicitly rather than left to review (PLAN-v3 §6, test `T-S4`).
 *
 * `EventSource` cannot send custom headers, which is why the CSRF token rides
 * in a readable cookie and why the session cookie must be `SameSite=None`:
 * ambient credentials are what make the stream work, and that is exactly why
 * the CSRF header check on mutating routes is load-bearing rather than hygiene.
 *
 * `Last-Event-ID` is CORS-safelisted, so replay after a reconnect needs no
 * extra allowed header.
 *
 * ## Named events, and the listener this file did not have
 *
 * The api writes **named** frames. `encodeEvent` in `api/src/sse.ts:91` builds
 * `id: <n>\nevent: <type>\ndata: <json>\n\n`, so `snapshot`, `notebooks-listed`,
 * `login-success` and `export-done` all arrive carrying an `event:` line — and
 * `onmessage` fires **only** for an unnamed `message` event. Three `on*`
 * handlers and not one `addEventListener` meant the client was deaf: not one
 * server-sent event had ever reached this page, and every live feature appeared
 * only after a manual refresh reading the REST snapshot.
 *
 * Proved on the deployed host rather than inferred, two probes in one page:
 * wired with `onmessage` only — exactly what the app used — the stream produced
 * `open` and then nothing, ever; wired with a listener per name it produced the
 * full `snapshot` frame with real data. The server streams perfectly. The names
 * themselves were transcribed correctly (`EVENT_TYPES`, 19-for-19 against
 * `api/src/sse.ts:28`); they were simply never listened for.
 *
 * ## Liveness: the stream that dies without saying so
 *
 * `onerror` is not enough. When a stream dies the way real ones die — a laptop
 * asleep past the NAT's UDP timeout, a handover to a different interface — the
 * socket is not closed, no `close` reaches either end, and `EventSource` sits in
 * `OPEN` indefinitely. Nothing is thrown, nothing is dispatched, nothing in the
 * console. The api keeps writing into a socket nobody is reading and believes
 * the tab is still watching.
 *
 * The only way out is to insist on *hearing* something. The api emits a named
 * `keepalive` event every 15 s (`HubOptions.keepaliveMs`, default 15_000), so a
 * stream that has gone quiet for three of those periods is treated as dead and
 * is reconnected — through the same path as an `onerror`, because the ring
 * buffer makes a reconnect a replay rather than a gap.
 *
 * The `keepalive` frame itself is never forwarded to `onEvent`. It is
 * transport-level: it proves the socket is alive and carries no application
 * meaning, and passing it on would mean a React re-render every 15 s for the
 * life of the page (`useEventStream` calls `setLast` on every event it is given).
 */
import { API_ORIGIN } from "./protocol";
import { EVENT_TYPES } from "./events-contract";

export type StreamState = "connecting" | "open" | "replaying" | "closed";

export interface StreamHandlers {
  onEvent: (id: string, event: string, data: unknown) => void;
  onState?: (state: StreamState) => void;
}

/** Backoff ceiling. The server's ring buffer covers the gap, not the clock. */
const MAX_BACKOFF_MS = 30_000;

/**
 * The api's keepalive period.
 *
 * **Hardcoded, and that is a real coupling.** It transcribes the default of
 * `HubOptions.keepaliveMs` in `api/src/sse.ts`, which is configured from
 * `sseKeepaliveMs` (also defaulting to 15 s).
 *
 * The risk is one-directional. Raise the api's period without raising this and
 * the liveness timer fires *before* the first keepalive is even due, so a
 * perfectly healthy stream is torn down on a loop. That is why the timeout below
 * is written as a multiple of this rather than as a second absolute number —
 * one constant to keep in step instead of two — and why the test asserts the
 * timer does not fire inside a single keepalive period.
 */
const KEEPALIVE_MS = 15_000;

/**
 * Silence that long means the stream is dead.
 *
 * Three keepalive periods, so an ordinary hiccup — one dropped frame, a GC pause,
 * a laptop lid closing for a second — does not tear down a healthy stream, while
 * a genuinely dead one is caught well inside the 90 s an unrefreshed page would
 * otherwise sit there showing a stale export as live.
 */
const LIVENESS_TIMEOUT_MS = 3 * KEEPALIVE_MS;

export function openEventStream(handlers: StreamHandlers): () => void {
  let source: EventSource | null = null;
  let retryMs = 1_000;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let livenessTimer: ReturnType<typeof setTimeout> | undefined;

  const clearLivenessTimer = () => {
    if (livenessTimer === undefined) return;
    clearTimeout(livenessTimer);
    livenessTimer = undefined;
  };

  /**
   * Arm (or re-arm) the liveness timer. Called on open and on every frame.
   *
   * Re-arming rather than resetting is the same thing here — there is only ever
   * one live timer — but written this way so there is no way to end up with a
   * second one armed alongside the first, which would fire a reconnect for a
   * stream that is fine.
   */
  const armLivenessTimer = () => {
    clearLivenessTimer();
    livenessTimer = setTimeout(() => {
      // Nothing has arrived for LIVENESS_TIMEOUT_MS, so the stream is gone even
      // though nobody said so. `close()` does not fire `onerror` per the HTML
      // spec, so the reconnect is scheduled here rather than delegated.
      source?.close();
      source = null;
      if (closed) return;
      handlers.onState?.("replaying");
      timer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_BACKOFF_MS);
    }, LIVENESS_TIMEOUT_MS);
  };

  const connect = () => {
    if (closed) return;
    handlers.onState?.(retryMs === 1_000 ? "connecting" : "replaying");

    source = new EventSource(`${API_ORIGIN}/api/session/events`, {
      // Omitting this is the bug. See the note above.
      withCredentials: true,
    });

    source.onopen = () => {
      retryMs = 1_000;
      handlers.onState?.("open");
      // An open stream is not a live one until it has produced a frame, so the
      // clock starts here rather than at construction.
      armLivenessTimer();
    };

    /**
     * The one body behind both delivery paths.
     *
     * `EVENT_TYPES` contains `"error"`, and that is the one name in the contract
     * the browser has already claimed: `addEventListener("error", …)` on an
     * `EventSource` also receives the browser's own *transport* error — no
     * `data`, `type: "error"` — dispatched through the same listener registry.
     * The collision is invisible until it bites, because `App.tsx` clears
     * `listingPending` on an `error` event: without a guard, every reconnect or
     * 401 would tell the user a listing had failed and re-enable a button whose
     * request is still running.
     *
     * So a frame with no string `data` is dropped here, before the consumer is
     * reached. Today that same event was swallowed by accident, by
     * `JSON.parse(undefined)` throwing inside the `try`; this makes the swallow
     * the thing it was always meant to be. Pinned by a test that fires the
     * transport error through the registry.
     */
    const dispatch = (e: Event) => {
      // Any frame at all means the socket is alive, whatever it says. This runs
      // before the shape checks below on purpose: a malformed or unmodelled
      // frame still proves a round trip, and letting one of those kill the
      // stream would make the api's wire format load-bearing for liveness.
      armLivenessTimer();
      const frame = e as MessageEvent;
      if (typeof frame.data !== "string") return;
      let data: unknown;
      try {
        data = JSON.parse(frame.data);
      } catch {
        // A malformed frame is not worth tearing the stream down for.
        return;
      }
      // The api's own `keepalive`. Transport-level: it reset the timer above
      // and means nothing to the consumer, so forwarding it would be a React
      // re-render every 15 s for nothing.
      if (frame.type === "keepalive") return;
      handlers.onEvent(frame.lastEventId, frame.type, data);
    };

    /**
     * One listener per contract name, registered *inside* `connect()` because
     * that is where the source is built: every attempt makes a fresh
     * `EventSource`, and a listener registered on the previous one went with it.
     *
     * `onmessage` below stays as the unnamed fallback. The two paths are disjoint
     * by SSE semantics — a frame carrying an `event:` line never fires
     * `onmessage` — so this is a fallback, not a second delivery of everything.
     */
    for (const name of EVENT_TYPES) {
      source.addEventListener(name, dispatch);
    }

    source.onmessage = dispatch;

    // `onerror` also fires on a normal server-side close, so this cannot
    // distinguish "recoverable" from "gone". Reconnecting is correct in both
    // cases: the ring buffer replays what was missed (§7.2, §7.4).
    //
    // Clearing the liveness timer here is what keeps the two paths from
    // double-scheduling: whichever fires first owns the reconnect, and the other
    // is disarmed.
    source.onerror = () => {
      source?.close();
      source = null;
      clearLivenessTimer();
      if (closed) return;
      handlers.onState?.("replaying");
      timer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_BACKOFF_MS);
    };
  };

  connect();

  return () => {
    closed = true;
    // The listeners are not removed, because a real `EventSource` does not
    // remove them either: `close()` aborts the connection and the ready state
    // goes `CLOSED`, so nothing is delivered again. The test fake keeps the
    // registry to match, so a teardown that only worked because a mock forgot
    // its handlers would show up here.
    if (timer) clearTimeout(timer);
    // Otherwise the timer outlives the stream and fires a reconnect on a closed
    // page: one extra `EventSource` per unmount, for nothing.
    clearLivenessTimer();
    source?.close();
    source = null;
    handlers.onState?.("closed");
  };
}
