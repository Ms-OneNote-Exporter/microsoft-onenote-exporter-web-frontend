/**
 * What to tell the user when a mutating call fails.
 *
 * ## Why this is a module and not three `if` statements in a component
 *
 * Because **a failure that renders nothing is indistinguishable from a button
 * that does nothing**, and that is the bug these messages exist to close. Three
 * call sites discarded their promise with `void`:
 *
 * ```tsx
 * void api.listNotebooks(csrfToken ?? "");
 * ```
 *
 * `listNotebooks` rejects on a non-2xx, nothing caught it, and the rejection
 * escaped as an unhandled promise rejection — real, visible in devtools, and
 * completely invisible to the person using the product. No state was touched, so
 * no message could appear even in principle.
 *
 * A 409 from `/api/session/notebooks` is not an edge case. It is the designed
 * answer to "clicked too early", and a user pressing the button will hit it
 * routinely. Observed on a live host:
 *
 * ```
 * OPTIONS 204 → POST 409 → OPTIONS 204 → POST 409 → OPTIONS 204 → POST 202 → … → POST 502
 * ```
 *
 * So the likely outcome of pressing the button, at the moment the user most wants
 * it to work, was silence.
 *
 * ## The three cases are kept apart
 *
 * They share a status code or nearly share one, and they are different user
 * instructions:
 *
 * | what the server said | what the user is told |
 * |---|---|
 * | `409`, no `retryable` — the route's own guard, a sign-in still in progress | still signing in; try again in a moment |
 * | `409` with `retryable: false` — the runner lost its cookie jar | sign in again; retrying cannot help |
 * | `503` with `retryable: true` — a listing is already running | a listing is already running; wait for it |
 *
 * Collapsing them into "something went wrong" is the failure mode this file
 * avoids. The backend already distinguishes them (`runnerFailure` in
 * `api/src/routes.ts`, backend #40) and it grew those fields *because* "retry"
 * was the wrong advice for `no_auth`. Passing that distinction through in one
 * direction and dropping it in the other would undo work done for this reason.
 *
 * ## `retryable: undefined` is not `false`
 *
 * A field the server did not send means it did not rule retrying out. Treating
 * absence as `false` would send a user back to the password form when all they
 * needed to do was wait three seconds.
 */
import { ApiError } from "./api";

/** Which call failed. The wording differs per action; the causes do not. */
export type MutatingAction = "list" | "start" | "abort";

/**
 * A failure worth showing, in words the user can act on.
 *
 * The server's own `code` is included where it is a token rather than a
 * sentence, because a status code in a support report is worth having. Where it
 * *is* a sentence the message already says the same thing, so it is not
 * duplicated.
 */
export function describeFailure(err: unknown, action: MutatingAction): string {
  if (!(err instanceof ApiError)) {
    // A network-level failure: no status, no body, nothing to be specific about.
    return action === "abort"
      ? "The export could not be stopped. It may still be running on the server."
      : "The service could not be reached. Nothing was changed — try again.";
  }

  const { status, code, reason, retryable } = err;

  // 401: the session is gone or was never usable. A distinct case from the
  // 409s because the *page* will move to the credential form on the next
  // refresh, and saying "try again" would send the user back to the button.
  if (status === 401) {
    return "This session is no longer valid. Erase it and sign in again.";
  }

  // The server said retrying cannot help. Named first because it is the only
  // case where the answer is *not* "wait", and collapsing it into a generic
  // message is what sends a user round in circles.
  if (retryable === false) {
    return reason === "no_auth"
      ? "The signed-in session was lost on the server, so this cannot run. Sign in again — trying again will not help."
      : "The server cannot complete this, and retrying will not help.";
  }

  if (status === 503) {
    return "Another notebook listing is already running. Wait for it to finish, then try again.";
  }

  if (status === 409) {
    // `no runner bound` and `not authenticated` are both the sign-in still being
    // established. Same instruction, so they are not separated: a user cannot
    // act on the difference between them.
    if (action === "abort") {
      return "This export is not in a state that can be stopped right now.";
    }
    if (action === "start") {
      return code === "an export is already running"
        ? "An export is already running for this session. Wait for it to finish."
        : "The session is not ready to start an export yet. Try again in a moment.";
    }
    return "Still signing in — the service is not ready to list notebooks yet. Try again in a moment.";
  }

  if (status === 429) {
    return "Too many attempts. Wait a moment before trying again.";
  }

  if (status === 501) {
    return "This is not available on the deployed backend yet.";
  }

  if (status === 502) {
    return action === "abort"
      ? "The server could not reach the export it was asked to stop. It may still be running."
      : "The service could not be reached to start this. Try again in a moment.";
  }

  // Anything else, with the status named. A bare "something went wrong" is the
  // thing this file exists to replace, and a number is more use in a bug report
  // than a shrug.
  const detail = code && !/\s/.test(code) ? ` (${status}, ${code})` : ` (${status})`;
  return `The service refused the request${detail}.`;
}