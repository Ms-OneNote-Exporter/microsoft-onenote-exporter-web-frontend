/**
 * The event names the backend emits.
 *
 * Transcribed from `EVENT_TYPES` in the api repository (`api/src/sse.ts`). That
 * array is the contract.
 *
 * ## The first version of this file invented names
 *
 * It listened for `export-ended`, `signed-in` and `session-ended`. **None of
 * those exists.** The backend sends `export-done` / `export-partial` /
 * `export-aborted`, `login-success`, and `auth-expired`. The visible consequence
 * was that a finished export left its progress card spinning forever, because
 * the event that would have ended it was delivered and ignored.
 *
 * Same root cause as the snapshot: guessing across a repository boundary
 * instead of reading the other side. Both are fixed by transcribing rather than
 * inferring.
 *
 * `keepalive` is listed for completeness but never arrives — the api sends it as
 * an SSE comment, which `EventSource` does not parse, so there is nothing to
 * handle. `snapshot` is the restore event and is a whole `SessionSnapshot`.
 */
export const EVENT_TYPES = [
  "session-status",
  "auth-state",
  "login-started",
  "challenge",
  "challenge-expired",
  "login-success",
  "login-failed",
  "auth-expired",
  "notebooks-listed",
  "export-queued",
  "export-started",
  "export-progress",
  "export-log",
  "export-aborted",
  "export-done",
  "export-partial",
  "error",
  "keepalive",
  "snapshot",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/**
 * An outstanding MFA challenge.
 *
 * **Not** an `auth.state`. The api is explicit that an MFA prompt arrives as
 * this event with its own payload and expiry, so a countdown must be driven from
 * `expiresAt` here rather than from the auth state — an auth state has no
 * deadline to count down from, and inferring one is how a user gets told to act
 * on a timer that belongs to a different thing.
 */
export interface Challenge {
  /** Server-defined identifier, echoed back on the challenge event. */
  id: string;
  /** What the user must do, e.g. approve a push or enter a code. */
  kind: string;
  expiresAt: string | null;
}

/**
 * Parse a `challenge` payload.
 *
 * Tolerant of the fields being absent, because the alternative is a user with a
 * pending MFA prompt who sees the app fall back to a generic failure — the one
 * moment where being specific matters most.
 */
export function parseChallenge(data: unknown): Challenge | null {
  if (typeof data !== "object" || data === null) return null;
  const raw = data as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : "";
  const kind = typeof raw.kind === "string" ? raw.kind : "";
  if (id === "" && kind === "") return null;
  return {
    id,
    kind,
    expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : null,
  };
}

/** True when an event ends an export, whatever the outcome. */
export function isTerminalExportEvent(type: string): boolean {
  return (
    type === "export-done" ||
    type === "export-partial" ||
    type === "export-aborted" ||
    type === "export-log"
  );
}