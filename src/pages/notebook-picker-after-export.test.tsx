/**
 * A finished export must not strand the user.
 *
 * ## What a user did
 *
 * Exported a notebook, watched it complete, downloaded the vault — and then found there
 * was no way to export a second notebook. The page offered the reference, the download
 * link, and **Erase this session**. Nothing else.
 *
 *     Export complete
 *     MS is great — reference k6gbuvNHBOJKGkQHozCtzGfLJmKJBcgVPGzM1534zmw
 *     Everything has been written to the vault.
 *       • Download the vault
 *     [Erase this session]
 *
 * The only way onward was to abandon the session and sign in again. That is what stopped
 * the §0.8.1 re-proof, and it is §0.6.6's shape exactly: the interface offered no next
 * step, so the backend's capability went unused.
 *
 * ## Why the chooser is not re-listed, and why there is no second List button
 *
 * The alternative considered was adding a "List my notebooks" button above the finished
 * card. It is the wrong fix, and the reason is on the server: the api persists the list
 * (bug #39) and the snapshot carries it, so the client already holds the names. Clicking
 * that button would claim a runner and spend ~20s in a container to be told what is
 * already on screen. `sessions.notebooks` was verified on the deployed host:
 *
 *     notebooks: ["The Complete Notebook","MS is great","MyFirstNotebook"]
 *
 * ## What these tests assert
 *
 * What the user can **do**, not which branch was taken. Each one asks whether a control
 * is present and, where it matters, whether pressing it works. A test asserting the
 * chooser "renders" would pass against a component that rendered it behind a disabled
 * button, which is the state §0.6.6 was about.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { NotebookPicker } from "./NotebookPicker";
import type { ExportState, NotebookList, RunningExport } from "../lib/session";

afterEach(() => cleanup());

const LOADED: NotebookList = {
  state: "loaded",
  items: ["The Complete Notebook", "MS is great", "MyFirstNotebook"],
};

function exportIn(state: ExportState): RunningExport {
  return {
    id: "k6gbuvNHBOJKGkQHozCtzGfLJmKJBcgVPGzM1534zmw",
    notebook: "MS is great",
    state,
    progress: null,
    partialReason: null,
    error: null,
    downloadUrl: state === "done" ? "https://one-backend.example/files/x/vault.zip" : null,
    fileName: state === "done" ? "vault.zip" : null,
    artifactPartial: false,
  };
}

function renderPicker(
  running: RunningExport | null,
  overrides: { signedIn?: boolean; notebooks?: NotebookList; onStart?: (n: string) => void } = {},
) {
  const onStart = overrides.onStart ?? vi.fn();
  render(
    <NotebookPicker
      notebooks={overrides.notebooks ?? LOADED}
      signedIn={overrides.signedIn ?? true}
      export={running}
      streamState="open"
      listingPending={false}
      onList={vi.fn()}
      onStart={onStart}
      onAbort={vi.fn()}
      actionError={null}
    />,
  );
  return { onStart };
}

/**
 * The radio for one notebook, found by role rather than by its text.
 *
 * By text is ambiguous, and that was the first thing to fail here: the finished
 * export card also renders `<strong>{running.notebook}</strong>`, so "MS is great"
 * appears once in the record of the export that just finished and once in the
 * chooser. Both are correct; only the radio is the control.
 */
function radio(name: string): HTMLElement {
  return screen.getByRole("radio", { name });
}

describe("after an export finishes, the user can export another notebook", () => {
  it("still offers the chooser once the export is done", () => {
    renderPicker(exportIn("done"));

    // The notebook the user already exported is selectable again, so they are not
    // asked to create a session to reach a notebook they have already used.
    expect(radio("MyFirstNotebook")).toBeDefined();
    expect(radio("MS is great")).toBeDefined();
  });

  it("keeps the finished export's reference and download link on screen", () => {
    renderPicker(exportIn("done"));

    // The record of what just happened is kept above the chooser. Hiding it the
    // moment a second export starts would lose the reference and the link, which is
    // the only way back to the archive the user already downloaded.
    expect(screen.getByText(/Export complete/)).toBeDefined();
    const link = screen.getByRole("link", { name: /vault\.zip/i }) as HTMLAnchorElement;
    expect(link.href).toContain("/files/");
  });

  it("actually starts a second export when a different notebook is picked", () => {
    // The load-bearing one. Rendering the chooser is not enough: the button must be
    // live and must hand the new notebook to the caller.
    const onStart = vi.fn();
    renderPicker(exportIn("done"), { onStart });

    fireEvent.click(radio("MyFirstNotebook"));
    const button = screen.getByRole("button", { name: /export/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    expect(onStart).toHaveBeenCalledWith("MyFirstNotebook");
  });

  it("offers the chooser again after a stopped or failed export too", () => {
    // `partial` is not "paused". A user who presses Stop almost always wants to try
    // something else, and before this fix Stop was a one-way door as well.
    for (const state of ["partial", "failed"] as const) {
      cleanup();
      renderPicker(exportIn(state));
      expect(radio("MyFirstNotebook")).toBeDefined();
    }
  });

  it("clears the selection as the export is handed off", () => {
    // Otherwise the button stays armed with the notebook just exported, and a
    // second click inside the window before the snapshot refreshes re-runs the same
    // export — which the backend answers 409.
    const onStart = vi.fn();
    renderPicker(exportIn("done"), { onStart });

    fireEvent.click(radio("MS is great"));
    const button = screen.getByRole("button", { name: /export/i }) as HTMLButtonElement;
    fireEvent.click(button);

    expect(onStart).toHaveBeenCalledWith("MS is great");
    // Disabled again, because nothing is selected any more.
    expect(button.disabled).toBe(true);
  });

  it("still hides the chooser while an export is actually running", () => {
    // The guard this change must not have cost. Offering a second start during a run
    // is what produces the 409, and the fix above is only correct if it is applied
    // to *in-flight* exports and nothing else.
    for (const state of ["queued", "running"] as const) {
      cleanup();
      renderPicker(exportIn(state));
      expect(screen.queryByRole("radio", { name: "MyFirstNotebook" })).toBeNull();
      expect(screen.getByText(/Exporting/)).toBeDefined();
    }
  });

  it("offers the chooser when there is no export at all", () => {
    // The ordinary case the fix must leave exactly as it was.
    renderPicker(null);
    expect(radio("MyFirstNotebook")).toBeDefined();
  });
});