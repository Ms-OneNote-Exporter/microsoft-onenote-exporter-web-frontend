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
  it("reads the fields an MFA prompt carries", () => {
    // Deliberately not an auth state, and deliberately with its own expiry.
    const challenge = parseChallenge({
      id: "c1",
      kind: "approve a push notification",
      expiresAt: "2026-10-06T09:05:00.000Z",
    });
    expect(challenge).toEqual({
      id: "c1",
      kind: "approve a push notification",
      expiresAt: "2026-10-06T09:05:00.000Z",
    });
  });

  it("survives a partial payload rather than dropping the prompt", () => {
    // A user waiting on their phone must be told something. Returning null would
    // leave them looking at a spinner during a sign-in that is waiting on them.
    expect(parseChallenge({ id: "c1" })).toEqual({
      id: "c1",
      kind: "",
      expiresAt: null,
    });
  });

  it("returns null for a payload with nothing in it", () => {
    expect(parseChallenge({})).toBeNull();
    expect(parseChallenge(null)).toBeNull();
    expect(parseChallenge("challenge")).toBeNull();
  });

  it("ignores a non-string expiry rather than rendering Invalid Date", () => {
    expect(parseChallenge({ id: "c1", expiresAt: 12345 })?.expiresAt).toBeNull();
  });
});