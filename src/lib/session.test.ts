/**
 * Snapshot parsing, against the interface the backend actually defines.
 *
 * The fixture below is a transcription of `SessionSnapshot` in the api repository
 * (`api/src/auth.ts`). The previous version of these tests used flat booleans —
 * `authenticated`, `signedIn` — which **do not exist**, so the tests passed
 * against a shape the backend never sent. That is what let the whole mismatch
 * through, and it is why the tests now build from the real fields.
 *
 * The other thing these tests pin down is the *failure* behaviour. The old
 * parser defaulted every missing field and rendered a normal-looking page
 * showing nothing; the most valuable assertions here are the ones that a total
 * mismatch is reported rather than absorbed.
 */
import { describe, expect, it } from "vitest";
import { parseSessionStatus } from "./session";

/** A complete, well-formed snapshot. Override fields per test. */
function snapshot(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: 3,
    serverTime: "2026-10-06T09:00:00.000Z",
    session: {
      state: "created",
      createdAt: "2026-10-06T09:00:00.000Z",
      expiresAt: "2026-10-06T21:00:00.000Z",
      idleExpiresAt: null,
    },
    auth: { state: "none", lastCheckedAt: null },
    notebooks: { state: "idle", items: [] },
    export: {
      state: "none",
      partialReason: null,
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
    csrfToken: "a".repeat(43),
    ...over,
  };
}

/** Unwrap, failing loudly if the snapshot did not parse. */
function parse(over: Record<string, unknown> = {}) {
  const result = parseSessionStatus(snapshot(over));
  if (!result.ok) {
    throw new Error(`expected a clean parse, got: ${result.problems.join("; ")}`);
  }
  return result.value;
}

describe("session and auth state", () => {
  it("reads a real snapshot", () => {
    const status = parse();
    expect(status.sessionState).toBe("created");
    expect(status.authState).toBe("none");
    expect(status.hasSession).toBe(true);
    expect(status.signedIn).toBe(false);
  });

  it("derives signedIn from auth.state, which is how it is actually modelled", () => {
    // There is no `signedIn` boolean on the wire. Guessing that there was is what
    // broke every page.
    expect(parse({ auth: { state: "valid", lastCheckedAt: null } }).signedIn).toBe(true);
    expect(parse({ auth: { state: "authenticating" } }).signedIn).toBe(false);
    expect(parse({ auth: { state: "expired" } }).signedIn).toBe(false);
    expect(parse({ auth: { state: "failed" } }).signedIn).toBe(false);
  });

  it("treats expired and failed identically, because they are indistinguishable", () => {
    // Microsoft can invalidate a cookie server-side and a crashed OneNote tab
    // produces the same observable error. Both route back to the credential form.
    const expired = parse({ auth: { state: "expired" } });
    const failed = parse({ auth: { state: "failed" } });
    expect(expired.signedIn).toBe(false);
    expect(failed.signedIn).toBe(false);
  });

  it("counts an erasing or erased session as having no session", () => {
    // `erased` should never reach a snapshot -- the erase machine deletes the
    // row -- but if one does, the page must not offer to continue it.
    expect(parse({ session: { state: "erasing" } }).hasSession).toBe(false);
    expect(parse({ session: { state: "erased" } }).hasSession).toBe(false);
  });
});

describe("notebooks", () => {
  it("reads the listing states", () => {
    expect(parse({ notebooks: { state: "idle", items: [] } }).notebooks.state).toBe("idle");
    expect(parse({ notebooks: { state: "listing", items: [] } }).notebooks.state).toBe("listing");
    expect(
      parse({ notebooks: { state: "loaded", items: ["Personal", "Work"] } }).notebooks.items,
    ).toEqual(["Personal", "Work"]);
  });

  it("keeps a loaded-but-empty list distinct from idle", () => {
    const status = parse({ notebooks: { state: "loaded", items: [] } });
    expect(status.notebooks.state).toBe("loaded");
    expect(status.notebooks.items).toEqual([]);
  });

  it("drops non-string items rather than rendering objects", () => {
    const status = parse({ notebooks: { state: "loaded", items: ["A", 7, null] } });
    expect(status.notebooks.items).toEqual(["A"]);
  });
});

describe("export", () => {
  const running = (over: Record<string, unknown> = {}) =>
    parse({
      export: {
        state: "running",
        partialReason: null,
        id: "e1",
        notebook: "Personal",
        progress: { pages: 4, sections: 2, assets: 1 },
        startedAt: "2026-10-06T09:00:00.000Z",
        finishedAt: null,
        ...over,
      },
    }).export;

  it("reads export.id, which is not exportId", () => {
    expect(running()?.id).toBe("e1");
  });

  it("restores a running export so a refresh reattaches", () => {
    // If this were dropped, a refresh during an export would show the chooser
    // and invite a second POST that the backend answers with 409.
    expect(running()).not.toBeNull();
  });

  it("reads progress as counts, not a sentence", () => {
    expect(running()?.progress).toEqual({ pages: 4, sections: 2, assets: 1 });
  });

  it("reports no export when state is none", () => {
    expect(parse().export).toBeNull();
  });

  it("separates the three partial reasons", () => {
    // The whole reason this field exists: "you stopped this export" is false
    // when the disk filled up, and sends the user looking for something they
    // did not do.
    expect(running({ state: "partial", partialReason: "aborted" })?.partialReason).toBe("aborted");
    expect(running({ state: "partial", partialReason: "quota" })?.partialReason).toBe("quota");
    expect(running({ state: "partial", partialReason: "disk" })?.partialReason).toBe("disk");
  });

  it("refuses an unrecognised partial reason rather than rendering it", () => {
    // The api validates this on read, so it should never arrive. If the union
    // widens, this surfaces as a change rather than a blank.
    expect(running({ state: "partial", partialReason: "weather" })?.partialReason).toBeNull();
  });

  it("reads the download URL the server supplied", () => {
    const status = running({
      state: "done",
      id: "e1",
      progress: null,
    });
    expect(status?.id).toBe("e1");
  });

  it("carries downloadUrl from artifact, so no path is constructed here", () => {
    // This is what settled the /files/ question: the server tells us the URL, so
    // the frontend never has to know whether Caddy or the api serves it.
    const status = parse({
      export: {
        state: "done",
        partialReason: null,
        id: "e1",
        notebook: "Personal",
        progress: null,
        startedAt: null,
        finishedAt: null,
      },
      artifact: {
        available: true,
        partial: false,
        downloadUrl: "https://one-backend.phttp.com/files/a1",
        fileName: "vault.zip",
      },
    }).export;

    expect(status?.downloadUrl).toBe("https://one-backend.phttp.com/files/a1");
    expect(status?.fileName).toBe("vault.zip");
    expect(status?.artifactPartial).toBe(false);
  });
});

describe("mismatches are reported, not absorbed", () => {
  it("rejects a body that is not an object", () => {
    const result = parseSessionStatus("not json");
    expect(result.ok).toBe(false);
  });

  it("names every missing top-level section", () => {
    // The old parser defaulted all of these to "empty" and rendered a page that
    // looked normal while showing nothing at all.
    const result = parseSessionStatus({ csrfToken: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toEqual(
      expect.arrayContaining(["missing `session`", "missing `auth`", "missing `notebooks`"]),
    );
  });

  it("names a state value outside the union", () => {
    const result = parseSessionStatus(snapshot({ auth: { state: "signed_in" } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(" ")).toMatch(/auth\.state was "signed_in"/);
  });

  it("names a notebook state outside the union", () => {
    const result = parseSessionStatus(snapshot({ notebooks: { state: "listing_complete", items: [] } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join(" ")).toMatch(/notebooks\.state/);
  });

  it("rejects a snapshot whose items are not an array", () => {
    const result = parseSessionStatus(snapshot({ notebooks: { state: "loaded", items: "Personal" } }));
    expect(result.ok).toBe(false);
  });
});

describe("the CSRF token", () => {
  it("reads it, so a reload re-arms the header", () => {
    expect(parse().csrfToken).toBe("a".repeat(43));
  });

  it("reports null when absent, rather than sending an empty header", () => {
    const snap = snapshot();
    delete snap.csrfToken;
    expect(parseSessionStatus(snap).ok).toBe(true);
    const result = parseSessionStatus(snap);
    if (!result.ok) return;
    expect(result.value.csrfToken).toBeNull();
  });
});
describe("export.error, added after the first deployment", () => {
  const failing = (over: Record<string, unknown> = {}) =>
    parse({
      export: {
        state: "failed",
        partialReason: null,
        id: "e1",
        notebook: "Personal",
        progress: null,
        startedAt: null,
        finishedAt: null,
        ...over,
      },
    }).export;

  it("carries the server's own text", () => {
    // The api is explicit that it is short and already safe to display, so it is
    // rendered as-is. A generic sentence alone leaves the user with no idea what
    // to do differently next time.
    expect(failing({ error: "the container was killed" })?.error).toBe(
      "the container was killed",
    );
  });

  it("is null when absent, on a backend predating the field", () => {
    // Read opportunistically: a missing optional field is not a version
    // mismatch, and failing the whole parse over one would break every page for
    // a cosmetic gain.
    expect(failing()?.error).toBeNull();
  });

  it("is null when the server sends an empty string", () => {
    expect(failing({ error: "" })?.error).toBeNull();
  });
});
