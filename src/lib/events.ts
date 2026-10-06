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
 */
import { API_ORIGIN } from "./protocol";

export type StreamState = "connecting" | "open" | "replaying" | "closed";

export interface StreamHandlers {
  onEvent: (id: string, event: string, data: unknown) => void;
  onState?: (state: StreamState) => void;
}

/** Backoff ceiling. The server's ring buffer covers the gap, not the clock. */
const MAX_BACKOFF_MS = 30_000;

export function openEventStream(handlers: StreamHandlers): () => void {
  let source: EventSource | null = null;
  let retryMs = 1_000;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

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
    };

    source.onmessage = (e: MessageEvent) => {
      let data: unknown;
      try {
        data = JSON.parse(e.data);
      } catch {
        // A malformed frame is not worth tearing the stream down for.
        return;
      }
      handlers.onEvent(e.lastEventId, e.type, data);
    };

    // `onerror` also fires on a normal server-side close, so this cannot
    // distinguish "recoverable" from "gone". Reconnecting is correct in both
    // cases: the ring buffer replays what was missed (§7.2, §7.4).
    source.onerror = () => {
      source?.close();
      source = null;
      if (closed) return;
      handlers.onState?.("replaying");
      timer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, MAX_BACKOFF_MS);
    };
  };

  connect();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    source?.close();
    source = null;
    handlers.onState?.("closed");
  };
}
