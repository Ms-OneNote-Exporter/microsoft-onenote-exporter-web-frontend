/**
 * The SSE event contract.
 *
 * These names were previously invented. `export-ended`, `signed-in` and
 * `session-ended` **do not exist** in the backend — it sends `export-done` /
 * `export-partial` / `export-aborted`, `login-success` and `auth-expired`. The
 * visible consequence was a finished export whose progress card never stopped
 * spinning, because the event that would have ended it was delivered and
 * ignored.
 *
 * The names are now transcribed from `EVENT_TYPES` in the api repository. What
 * this file protects is transcription drift: if that array changes, the tests
 * below are what should fail, and they fail loudly rather than silently ignoring
 * an event again.
 */
import { describe, expect, it } from "vitest";
import {
  EVENT_TYPES,
  isTerminalExportEvent,
  isPhoneApproval,
  parseChallenge,
} from "./events-contract";

describe("the event names", () => {
  it("matches the backend's EVENT_TYPES exactly", () => {
    // The full list, in order. A name added or renamed on the other side breaks
    // this, which is the point — the previous failure was a list that was wrong
    // and nothing noticed.
    expect([...EVENT_TYPES]).toEqual([
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
    ]);
  });

  it("carries no name that the backend does not send", () => {
    // The specific regression: three names this client used for a long time.
    for (const invented of ["export-ended", "signed-in", "session-ended"]) {
      expect(EVENT_TYPES).not.toContain(invented);
    }
  });

  it("has no duplicates", () => {
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });
});

describe("terminal export events", () => {
  it("recognises every outcome that ends an export", () => {
    // There is no single `export-ended`; the outcome is the name. Missing one of
    // these is what left the progress card spinning forever.
    expect(isTerminalExportEvent("export-done")).toBe(true);
    expect(isTerminalExportEvent("export-partial")).toBe(true);
    expect(isTerminalExportEvent("export-aborted")).toBe(true);
  });

  it("does not treat progress as terminal", () => {
    expect(isTerminalExportEvent("export-progress")).toBe(false);
    expect(isTerminalExportEvent("export-started")).toBe(false);
    expect(isTerminalExportEvent("export-queued")).toBe(false);
  });
});

describe("parseChallenge", () => {
  it("reads the payload the api actually sends", () => {
    // Transcribed from `publish()` in the api's runner adapter, which is where the
    // runner's own event is translated into this service's vocabulary. The previous
    // version of this test used `{id, kind, expiresAt}` — fields the api does not
    // send — and passed, because the parser it exercised was the wrong one.
    const challenge = parseChallenge({
      kind: "phone-approval",
      label: "Tap approve in your phone",
      number: "42 918 337",
      expiresAt: "2026-10-06T09:05:00.000Z",
    });
    expect(challenge).toEqual({
      kind: "phone-approval",
      label: "Tap approve in your phone",
      number: "42 918 337",
      expiresAt: "2026-10-06T09:05:00.000Z",
    });
  });

  it("carries the number through, because there is no window to switch to", () => {
    // The number is the only way a user can match a challenge in this product: the
    // login runs headlessly in a container, so there is no Microsoft window on
    // this screen. A parser that dropped it produced a prompt nobody could act on.
    expect(parseChallenge({ kind: "phone-approval", number: "7" })?.number).toBe("7");
    expect(isPhoneApproval(parseChallenge({ kind: "phone-approval", number: "7" })!)).toBe(true);
  });

  it("keeps the number as printed rather than reformatting it", () => {
    // Microsoft prints the number with spacing and the user matches it by eye.
    // Parsing it into a number and re-rendering would change the digits they are
    // comparing, which is the failure this field exists to prevent.
    expect(parseChallenge({ number: "42 918 337" })?.number).toBe("42 918 337");
  });

  it("reads a code challenge, which carries no number", () => {
    const challenge = parseChallenge({ kind: "code", label: "Enter the code we sent you" });
    expect(challenge?.kind).toBe("code");
    expect(challenge?.number).toBeNull();
    expect(isPhoneApproval(challenge!)).toBe(false);
  });

  it("survives a partial payload rather than dropping the prompt", () => {
    // A user waiting on their phone must be told something. Returning null would
    // leave them looking at a spinner during a sign-in that is waiting on them.
    expect(parseChallenge({ kind: "phone-approval" })).toEqual({
      kind: "phone-approval",
      label: "",
      number: null,
      expiresAt: null,
    });
  });

  it("treats an empty number as no number rather than showing a blank", () => {
    // The runner sends `null` when there is nothing to read, and a hand-written
    // payload could send "". Both mean the same thing to the user.
    expect(parseChallenge({ kind: "phone-approval", number: "" })?.number).toBeNull();
  });

  it("returns null for a payload with nothing in it", () => {
    expect(parseChallenge({})).toBeNull();
    expect(parseChallenge(null)).toBeNull();
    expect(parseChallenge("challenge")).toBeNull();
    // The old shape: an `id` and nothing else. Nothing here is renderable, so
    // there is nothing to show.
    expect(parseChallenge({ id: "c1" })).toBeNull();
  });

  it("ignores a non-string expiry rather than rendering Invalid Date", () => {
    expect(parseChallenge({ kind: "code", expiresAt: 12345 })?.expiresAt).toBeNull();
  });

  it("ignores a non-string number rather than rendering a number", () => {
    expect(parseChallenge({ kind: "phone-approval", number: 42918337 })?.number).toBeNull();
  });
});