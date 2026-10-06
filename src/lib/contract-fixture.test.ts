/**
 * The real contract, captured from a live backend.
 *
 * This payload was fetched from `GET /api/session/status` on a real deployment
 * over real TLS, with a real session cookie. It is here because the previous
 * fixtures were transcriptions of the *source* — which is how three separate
 * interface guesses got through. A transcription of the source can still be
 * wrong about what the source actually emits.
 *
 * What this catches that nothing else did: every field my parser reads is
 * present and correctly shaped, so a rename or a moved field on the api side
 * fails here rather than on a user's screen.
 *
 * The values are from a throwaway session created for the capture, so nothing
 * here is a live credential.
 */
import { describe, expect, it } from "vitest";
import { parseSessionStatus } from "./session";

/** Verbatim from the live endpoint, with the volatile values left intact. */
const REAL_STATUS = {
  protocol: 3,
  serverTime: "2026-10-06T14:40:59.070Z",
  session: {
    state: "created",
    createdAt: "2026-10-06T14:40:49.017Z",
    expiresAt: "2026-10-07T02:40:49.017Z",
    idleExpiresAt: "2026-10-06T14:40:49.017Z",
  },
  auth: { state: "none", lastCheckedAt: null },
  notebooks: { state: "idle", items: [] },
  export: {
    state: "none",
    partialReason: null,
    error: null,
    id: null,
    notebook: null,
    progress: null,
    startedAt: null,
    finishedAt: null,
  },
  artifact: {
    available: false,
    partial: false,
    downloadUrl: null,
    fileName: null,
  },
  csrfToken: "YhACOr3pdXBsYurwbemI_EpYMor2GhMEjEWlLhsqDCk",
} as const;

describe("a real snapshot from a live backend", () => {
  it("parses without reporting a problem", () => {
    // The single assertion that matters. Three interface guesses were wrong in
    // three different ways, and all of them would have shown up here.
    const result = parseSessionStatus(REAL_STATUS);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`unparsed real snapshot: ${result.problems.join("; ")}`);
    }

    expect(result.value.hasSession).toBe(true);
    expect(result.value.sessionState).toBe("created");
    expect(result.value.authState).toBe("none");
    expect(result.value.signedIn).toBe(false);
    expect(result.value.notebooks).toEqual({ state: "idle", items: [] });
    expect(result.value.export).toBeNull();
    expect(result.value.csrfToken).toBe(REAL_STATUS.csrfToken);
  });

  it("reads export.error as present-and-null rather than missing", () => {
    // The api added this field after the first contract was agreed. Its presence
    // with a null value is the documented shape, and a parser that treated
    // "absent" and "present and null" as the same would hide a removal.
    const result = parseSessionStatus(REAL_STATUS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("error" in REAL_STATUS.export).toBe(true);
    expect(result.value.export).toBeNull();
  });
});