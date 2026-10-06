/**
 * Alias reconciliation in `session.ts`.
 *
 * The snapshot field names were never agreed between the two components, so
 * the parsers accept a list of spellings per field and report which one
 * satisfied it. These tests pin down both halves of that arrangement:
 *
 *  - every alias actually resolves, so a spelling we *think* the server might
 *    use is one we would actually read;
 *  - `matched` records the key, so the aliases can be deleted later and a test
 *    can prove the canonical name is the one in use.
 *
 * The failure this protects against is specific and quiet: the backend names a
 * field `signed_in`, we read `signedIn`, and the export page never shows progress
 * because there is nothing to show. A loud failure would have been better.
 */
import { describe, expect, it } from "vitest";
import { parseExport, parseSessionStatus } from "./session";

const FULL_SNAPSHOT = {
  authenticated: true,
  signedIn: true,
  notebooks: { state: "loaded", items: ["Personal"] },
  export: { exportId: "e1", notebook: "Personal", state: "running" },
};

describe("alias reconciliation", () => {
  it("reads the canonical names", () => {
    const status = parseSessionStatus(FULL_SNAPSHOT);
    expect(status.authenticated).toBe(true);
    expect(status.signedIn).toBe(true);
    expect(status.matched).toMatchObject({
      authenticated: "authenticated",
      signedIn: "signedIn",
      notebooks: "notebooks",
      export: "export",
    });
  });

  it("reads snake_case spellings", () => {
    const status = parseSessionStatus({
      session: true,
      signed_in: true,
      notebook_list: { state: "loaded", items: ["Personal"] },
      running_export: { exportId: "e1", notebook: "Personal", state: "running" },
    });

    expect(status.authenticated).toBe(true);
    expect(status.signedIn).toBe(true);
    expect(status.notebooks.items).toEqual(["Personal"]);
    expect(status.export?.exportId).toBe("e1");
    expect(status.matched.signedIn).toBe("signed_in");
    expect(status.matched.export).toBe("running_export");
  });

  it("reads the camelCase alternatives", () => {
    const status = parseSessionStatus({
      hasSession: true,
      isSignedIn: true,
      notebookList: { state: "loaded", items: ["Work"] },
      currentExport: { exportId: "e2", notebook: "Work", state: "done" },
    });

    expect(status.authenticated).toBe(true);
    expect(status.signedIn).toBe(true);
    expect(status.export?.exportId).toBe("e2");
  });

  it("reports no match rather than inventing one", () => {
    const status = parseSessionStatus({ somethingElse: true });

    // Undefined is the honest answer, and it is what makes a contract
    // mismatch visible to whoever reads `matched`.
    expect(status.matched.signedIn).toBeUndefined();
    expect(status.matched.export).toBeUndefined();
    expect(status.signedIn).toBe(false);
  });

  it("prefers the canonical name when both are present", () => {
    // Deliberate: if the server ever sends both during a rename, the canonical
    // spelling wins, so the alias can be deleted without a behaviour change.
    const status = parseSessionStatus({
      signedIn: true,
      signed_in: false,
    });
    expect(status.matched.signedIn).toBe("signedIn");
    expect(status.signedIn).toBe(true);
  });

  it("does not treat a string or number as signed in", () => {
    // The credential page is the one screen where reading "yes" when the answer
    // is "no" sends a user to type their password a second time.
    expect(parseSessionStatus({ signedIn: "true" }).signedIn).toBe(false);
    expect(parseSessionStatus({ signedIn: 1 }).signedIn).toBe(false);
    expect(parseSessionStatus({ authenticated: "yes" }).authenticated).toBe(false);
  });

  it("accepts an object session field", () => {
    // If the server answers "is there a session" with an object rather than a
    // boolean, its presence is the answer.
    expect(parseSessionStatus({ session: { guid: "g" } }).authenticated).toBe(true);
  });
});

describe("artifact URLs", () => {
  it("keeps a server-supplied url, so this component need not know the origin", () => {
    const exportState = parseExport({
      exportId: "e1",
      notebook: "Personal",
      state: "done",
      artifacts: [
        { artifactId: "a1", name: "vault.zip", bytes: 1024, url: "https://files.example/vault.zip" },
      ],
    });

    expect(exportState?.artifacts?.[0]?.url).toBe("https://files.example/vault.zip");
  });

  it("leaves url absent when the server omits it, so the caller falls back", () => {
    const exportState = parseExport({
      exportId: "e1",
      notebook: "Personal",
      state: "done",
      artifacts: [{ artifactId: "a1", name: "vault.zip" }],
    });

    // undefined, not "" — an empty string would render as a link to the page
    // itself, which is worse than falling back to the constructed path.
    expect(exportState?.artifacts?.[0]?.url).toBeUndefined();
  });

  it("falls back to the artifact id as the name", () => {
    const exportState = parseExport({
      exportId: "e1",
      notebook: "Personal",
      state: "done",
      artifacts: [{ artifactId: "a1" }],
    });

    expect(exportState?.artifacts?.[0]?.name).toBe("a1");
  });

  it("drops malformed artifacts instead of rendering empty links", () => {
    const exportState = parseExport({
      exportId: "e1",
      notebook: "Personal",
      state: "done",
      artifacts: [{ name: "no-id.zip" }, "nonsense", null, { artifactId: "ok.zip" }],
    });

    expect(exportState?.artifacts?.map((a) => a.artifactId)).toEqual(["ok.zip"]);
  });
});

describe("export parsing", () => {
  it("requires an export id, and tolerates a missing notebook", () => {
    expect(parseExport({ notebook: "Personal" })).toBeNull();
    expect(parseExport({ exportId: "e1" })?.notebook).toBe("");
  });

  it("defaults a missing state to running rather than done", () => {
    // Failing towards "still working" means a lost update shows a progress card
    // rather than a download list for an export that has not finished.
    expect(parseExport({ exportId: "e1" })?.state).toBe("running");
  });

  it("returns null for a non-object", () => {
    expect(parseExport(null)).toBeNull();
    expect(parseExport("done")).toBeNull();
  });
});