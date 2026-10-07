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
  /** What the user must do, e.g. `phone-approval` or `code`. */
  kind: string;
  /** The number to match on the phone, or null when there is nothing to read. */
  number: string | null;
  /** What the backend observed on screen, in words. Empty when absent. */
  label: string;
  expiresAt: string | null;
}

/**
 * Parse a `challenge` payload.
 *
 * ## The fields are transcribed from the api, and the first version was wrong
 *
 * This used to read `{id, kind, expiresAt}` while the api sends
 * `{kind, label, number, expiresAt}`. Only `kind` overlapped, so `id` was always
 * `""` and the number never arrived.
 *
 * That number is the whole point of the number-match path. The login runs
 * headlessly in a container: there is no Microsoft window on this screen for the
 * user to switch to, so the only way they can match the challenge is by being
 * shown the number. Dropping it meant a user with push-approval MFA was told to
 * "finish it in the Microsoft sign-in window" and had no way to do it.
 *
 * The shape comes from `publish()` in the api's `runner-adapter-http.ts`, which is
 * where the runner's own event is translated. It is transcribed, not inferred —
 * the same rule this file already records for `EVENT_TYPES`, and the failure it
 * records there was this file inventing `export-ended` and `signed-in`.
 *
 * Tolerant of the fields being absent, because the alternative is a user with a
 * pending MFA prompt who sees the app fall back to a generic failure — the one
 * moment where being specific matters most.
 */
export function parseChallenge(data: unknown): Challenge | null {
  if (typeof data !== "object" || data === null) return null;
  const raw = data as Record<string, unknown>;
  const kind = typeof raw.kind === "string" ? raw.kind : "";
  const label = typeof raw.label === "string" ? raw.label : "";
  // A number arrives as a string from the runner, because it is read off a screen
  // and may carry the spacing Microsoft printed. Not parsed into a number: it is
  // displayed, and a parse would reformat digits a user is matching by eye.
  const challengeNumber = typeof raw.number === "string" && raw.number !== "" ? raw.number : null;
  if (kind === "" && label === "" && challengeNumber === null) return null;
  return {
    kind,
    label,
    number: challengeNumber,
    expiresAt: typeof raw.expiresAt === "string" ? raw.expiresAt : null,
  };
}

/** True when this challenge is one the user matches against a phone. */
export function isPhoneApproval(challenge: Challenge): boolean {
  return challenge.number !== null;
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