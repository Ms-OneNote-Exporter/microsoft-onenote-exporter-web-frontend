/**
 * The typed-code challenge: "enter the code Microsoft sent you".
 *
 * ## Why this page exists at all
 *
 * A `challenge` of kind `code` is the one MFA path that needs something from the
 * user, and this product had nothing to collect it with. The sign-in runs headlessly
 * in a container, so there is no Microsoft window on this screen to switch to — and
 * the api answered that prompt with `login-failed {reason:
 * "challenge-not-supported"}`, which told a user with a working password that their
 * credentials had been refused while the runner sat waiting for the code in their
 * hand.
 *
 * The chain that fixes it is four components long and none of them works alone:
 * `microsoft-webauth` asks for a code on **stdin**, which a container does not have,
 * so 0.1.12 added `answerChallenge`; the runner exposes it as `POST
 * /sessions/:guid/mfa`; this api exposes it as `POST /api/session/challenge/answer`;
 * and this page is where the code is typed.
 *
 * ## The countdown is the runner's deadline, not an auth state's
 *
 * `challenge.expiresAt` comes from the `challenge` event and nowhere else. An auth
 * state has no deadline to count down from, and inferring one is how a user gets told
 * to act on a timer that belongs to a different thing — a 15-minute
 * `TTL.loginInProgress` is not a 2-minute code window, and showing the larger number
 * would tell someone they have longer than they do.
 *
 * **A missing expiry shows no countdown at all**, rather than a fabricated one. The
 * runner sends `null` when it did not report a duration, and a countdown invented
 * from the default would be a measurement nobody made.
 *
 * ## The code is sent exactly as typed
 *
 * Not trimmed, not reformatted, not reformatted-to-digits-only. Same rule as the
 * password on this page: a transformation applied to a value the user cannot see
 * again once it is handed over is a place a typo becomes a login failure with no
 * explanation. The server refuses a blank and bounds the length; it does not alter
 * the value.
 *
 * A code is valid for minutes at most, so it is cleared from component state the
 * moment it is accepted — not on success, which is minutes away and might never
 * arrive.
 */
import { useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { isPhoneApproval, type Challenge } from "../lib/events-contract";

export interface ChallengeAnswerProps {
  /** The pending challenge, as the `challenge` event described it. */
  challenge: Challenge;
  /** Resolves once the code has been handed over — accepted, not verified. */
  submit: (code: string) => Promise<void>;
  /** Called once the code is accepted, so the caller can drop the prompt. */
  onAnswered: () => void;
}

/**
 * How long an MFA code may be.
 *
 * **The same number the server applies** (`MAX_CHALLENGE_CODE_CHARS` in
 * `api/src/routes.ts`). A client that accepted a longer string would let a user type
 * something the server refuses with a 400 whose message does not explain it.
 */
const MAX_CODE_LENGTH = 32;

/** How often the countdown redraws. A second is the finest granularity anyone acts on. */
const TICK_MS = 1000;

/**
 * secondsLeft is the whole seconds between now and an expiry, never negative.
 *
 * `null` for a missing or unparseable expiry — which renders as **no countdown**
 * rather than as a number nobody measured.
 */
function secondsLeft(expiresAt: string | null, now: number): number | null {
  if (expiresAt === null) return null;
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

export function ChallengeAnswer({ challenge, submit, onAnswered }: ChallengeAnswerProps) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(() =>
    secondsLeft(challenge.expiresAt, Date.now()),
  );

  // Ticked on an interval rather than derived once: the expiry is a wall-clock
  // instant, and a number computed at render is a number that does not move while a
  // user reads it. The interval is cleared on unmount because a timer that outlives
  // its component is a leak per challenge, and a prompt can be answered or expired
  // several times over a session.
  useEffect(() => {
    setRemaining(secondsLeft(challenge.expiresAt, Date.now()));
    if (challenge.expiresAt === null) return;
    const timer = setInterval(() => {
      setRemaining(secondsLeft(challenge.expiresAt, Date.now()));
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [challenge.expiresAt]);

  // A number-match challenge has nothing to type — the user approves it on their
  // phone — so this page is never rendered for one, and rendering it anyway would
  // ask for a code that does not exist.
  if (isPhoneApproval(challenge)) return null;

  const canSubmit = code.trim() !== "" && code.length <= MAX_CODE_LENGTH && !busy;
  const expired = remaining === 0;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    setBusy(true);
    setError(null);
    try {
      // As typed. See the header: this is not the password path, but the reason for
      // not altering a value applies exactly the same way.
      await submit(code);
      // Cleared before the callback, unconditionally: a code is valid for minutes, and
      // this page may stay mounted behind whatever the callback renders.
      setCode("");
      onAnswered();
    } catch (err) {
      setError(describe(err));
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={onSubmit}>
      <h2>Enter the code Microsoft sent you</h2>

      {/*
        What the backend actually saw on screen, when it said anything. Falls back to
        a sentence that is true for every code challenge rather than to nothing —
        this page is reached at the moment a sign-in is waiting on the user, and a
        blank is the one answer they cannot act on.
      */}
      {challenge.label !== "" && <p>{challenge.label}</p>}

      <label className="field" htmlFor="mfa-code">
        Sign-in code
      </label>
      <input
        id="mfa-code"
        name="mfa-code"
        type="text"
        value={code}
        onChange={(e) => {
          setCode(e.target.value);
          setError(null);
        }}
        autoComplete="one-time-code"
        autoCapitalize="none"
        spellCheck={false}
        inputMode="numeric"
        disabled={busy}
      />

      {/*
        The countdown, and only when there is a real one. `remaining === null` is a
        missing or unparseable expiry, and it renders nothing: a number invented from
        a default would be a deadline nobody measured, shown to somebody deciding
        whether they still have time.
      */}
      {remaining !== null && (
        <p className="fineprint" data-testid="mfa-countdown">
          {expired
            ? "This code has expired. Start signing in again to request a new one."
            : `This code expires in ${remaining} second${remaining === 1 ? "" : "s"}.`}
        </p>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <button type="submit" disabled={!canSubmit || expired}>
        {busy ? "Sending…" : "Send code"}
      </button>

      <p className="fineprint">
        The code goes straight to the sign-in running for this session. If it is
        wrong, the sign-in fails and you will be asked to try again.
      </p>
    </form>
  );
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    // 409 is the server saying nothing was waiting — the challenge expired, or it
    // was a push approval needing no code. It is a different situation from a wrong
    // code, and "sign-in failed" would not tell the user which they are in.
    if (err.status === 409) {
      return "Nothing is waiting for that code any more. The sign-in it belonged to has ended — start signing in again.";
    }
    if (err.status === 403) {
      return "This page cannot submit the code. Reload once; if it persists, the page and the service are out of step.";
    }
    if (err.status === 400) {
      return "The service would not accept that code. Check it and try again.";
    }
    if (err.status === 401) {
      return "This session is no longer valid. Start a new one.";
    }
    return `The code could not be sent (${err.status}${
      err.code ? ` ${err.code}` : ""
    }).`;
  }
  return "The code could not be sent. The connection may have dropped.";
}