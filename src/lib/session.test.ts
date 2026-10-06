/**
 * `session.ts` parsing.
 *
 * The behaviour under test is tolerance. A backend that is mid-deploy, returning
 * a shape we do not recognise, must produce a page that says so rather than an
 * empty chooser or a thrown error. The worst outcome for a user here is a
 * chooser that looks empty when the listing actually failed, because they would
 * conclude their account has no notebooks and stop.
 */
import { describe, expect, it } from "vitest";
import { notebookStatus, parseSessionStatus } from "./session";

describe("notebookStatus", () => {
  it("maps the four documented states", () => {
    expect(notebookStatus({ state: "idle", items: [] }).kind).toBe("idle");
    expect(notebookStatus({ state: "listing", items: [] }).kind).toBe("listing");
    expect(notebookStatus({ state: "loaded", items: ["A"] }).kind).toBe("loaded");
    expect(notebookStatus({ state: "failed", error: "boom" }).kind).toBe("failed");
  });

  it("reports an unrecognised state as unknown rather than as idle", () => {
    // This is the whole reason the union is not closed. Treating an unknown
    // value as `idle` renders "No notebooks listed yet" — indistinguishable
    // from a working empty account, and nothing anyone would report.
    const view = notebookStatus({ state: "listing_complete", items: [] });
    expect(view.kind).toBe("unknown");
    expect(view).toMatchObject({ rawState: "listing_complete" });
  });

  it("reports an absent state as unknown", () => {
    expect(notebookStatus({ items: ["A"] })).toMatchObject({
      kind: "unknown",
      rawState: "(absent)",
    });
  });

  it("reports a non-object as unknown rather than throwing", () => {
    expect(notebookStatus(null)).toMatchObject({ kind: "unknown" });
    expect(notebookStatus("loaded")).toMatchObject({ kind: "unknown" });
    expect(notebookStatus(42)).toMatchObject({ kind: "unknown" });
  });

  it("keeps a loaded-but-empty list distinct from idle", () => {
    const view = notebookStatus({ state: "loaded", items: [] });
    expect(view.kind).toBe("loaded");
    expect(view.items).toEqual([]);
  });

  it("drops non-string items instead of rendering objects", () => {
    const view = notebookStatus({ state: "loaded", items: ["A", 7, null, { b: 1 }, "B"] });
    expect(view.items).toEqual(["A", "B"]);
  });

  it("preserves the error text on a failed listing", () => {
    expect(notebookStatus({ state: "failed", error: "auth expired" })).toMatchObject({
      kind: "failed",
      error: "auth expired",
    });
  });
});

describe("parseSessionStatus", () => {
  it("reads a full snapshot", () => {
    const status = parseSessionStatus({
      authenticated: true,
      signedIn: true,
      notebooks: { state: "loaded", items: ["Personal", "Work"] },
      export: { exportId: "e1", notebook: "Personal", state: "running", progress: "40%" },
    });

    expect(status.authenticated).toBe(true);
    expect(status.signedIn).toBe(true);
    expect(status.notebooks.items).toEqual(["Personal", "Work"]);
    expect(status.export).toMatchObject({ exportId: "e1", state: "running" });
  });

  it("restores a running export, so a refresh reattaches rather than offering a second", () => {
    const status = parseSessionStatus({
      authenticated: true,
      signedIn: true,
      notebooks: { state: "loaded", items: ["Personal"] },
      export: { exportId: "e1", notebook: "Personal", state: "running" },
    });

    expect(status.export).toBeDefined();
    // If this were dropped, refresh during an export would show the chooser and
    // invite a POST that the backend answers with 409.
    expect(status.export?.exportId).toBe("e1");
  });

  it("treats a malformed export object as no export", () => {
    // Better than a half-populated RunningExport that would render a progress
    // card for something that does not exist.
    expect(
      parseSessionStatus({ authenticated: true, export: { notebook: "Personal" } }).export,
    ).toBeUndefined();
  });

  it("does not treat truthy non-booleans as authenticated", () => {
    const status = parseSessionStatus({ authenticated: "yes", signedIn: 1 });
    expect(status.authenticated).toBe(false);
    expect(status.signedIn).toBe(false);
  });

  it("survives a wholly unexpected body", () => {
    const status = parseSessionStatus("not json at all");
    expect(status.authenticated).toBe(false);
    expect(status.notebooks).toMatchObject({ state: "", items: [] });
  });

  it("reads a notebook list that is not an object", () => {
    expect(parseSessionStatus({ notebooks: "loaded" }).notebooks.items).toEqual([]);
  });
});