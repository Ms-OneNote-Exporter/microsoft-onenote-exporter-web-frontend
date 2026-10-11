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

function exportIn(
  state: ExportState,
  over: Partial<Pick<RunningExport, "progress" | "failed" | "partialReason">> = {},
): RunningExport {
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
    failed: null,
    ...over,
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

/**
 * What the card *says* about a walk that has ended.
 *
 * ## The card was true and useless
 *
 * A finished export rendered one sentence: *"Everything has been written to the
 * vault."* Nothing about how much. The same walk, run in the command-line
 * package, printed **29 pages, 8 assets, 1 page failed** — and the card could
 * render neither the totals nor the loss, so a vault missing a page read exactly
 * like a complete one.
 *
 * ## The worse one: a sentence that was false
 *
 * The `partial` branch with no `partialReason` said *"The export stopped before
 * it finished, so the vault is incomplete."* For the walk above that is false
 * in its first clause: nothing stopped, the walk reached the end and came back
 * short. And it is the **common** partial case — `partial` is reached whenever
 * anything is lost, which is not the same as whenever something interrupted.
 *
 * These tests assert the rendered text, not the branch taken: the counts, the
 * losses, and the absence of the false sentence.
 */
describe("the export card says what happened", () => {
  /** The walk the user measured: 29 pages, 1 section, 8 assets, 1 lost page. */
  const WALK = { pages: 29, sections: 1, assets: 8 };

  it("counts what was written, on an export that finished", () => {
    renderPicker(exportIn("done", { progress: WALK }));

    // "Everything has been written" is a claim nobody can check; the counts are
    // what make it checkable.
    expect(screen.getByText(/written to the vault/)).toBeDefined();
    expect(screen.getByText(/29 pages/)).toBeDefined();
    expect(screen.getByText(/1 section/)).toBeDefined();
    expect(screen.getByText(/8 assets/)).toBeDefined();
  });

  it("says what was lost, so a finished card does not read as a clean run", () => {
    renderPicker(exportIn("done", { progress: WALK, failed: { pages: 1, sections: 0, groups: 0 } }));

    expect(screen.getByText(/1 page failed/)).toBeDefined();
  });

  it("pluralises the losses, and names every kind that is non-zero", () => {
    // One is the common case, so "1 pages failed" would be the sentence a user
    // actually reads. `groups` is a real count on the wire, not a leftover.
    renderPicker(
      exportIn("done", { progress: WALK, failed: { pages: 2, sections: 1, groups: 3 } }),
    );
    expect(screen.getByText(/2 pages, 1 section and 3 groups failed/)).toBeDefined();
  });

  it("says nothing about failures when the walk reported none", () => {
    // `null` is absence and `{0, 0, 0}` is a *measured* zero. Both render as a
    // clean run: "0 pages failed" on every export is the noise this field was
    // added to delete.
    for (const failed of [null, { pages: 0, sections: 0, groups: 0 }] as const) {
      cleanup();
      renderPicker(exportIn("done", { progress: WALK, failed }));
      expect(screen.getByText(/written to the vault/)).toBeDefined();
      expect(screen.queryByText(/failed/)).toBeNull();
    }
  });

  it("does not claim the export stopped early when nothing stopped it", () => {
    // The false sentence, and the common case: the walk finished and lost a page.
    renderPicker(
      exportIn("partial", { progress: WALK, failed: { pages: 1, sections: 0, groups: 0 } }),
    );

    expect(screen.queryByText(/stopped before it finished/)).toBeNull();
    // What is true is still said: the vault is short.
    expect(screen.getByText(/incomplete/)).toBeDefined();
    expect(screen.getByText(/29 pages/)).toBeDefined();
    expect(screen.getByText(/1 page failed/)).toBeDefined();
  });

  it("still calls the vault incomplete when the losses were never counted", () => {
    // A backend predating `failed`, or a terminal write that recorded none. The
    // card cannot say how much is missing, so it says that it is — and not why.
    renderPicker(exportIn("partial", { progress: WALK }));

    expect(screen.queryByText(/stopped before it finished/)).toBeNull();
    expect(screen.getByText(/incomplete/)).toBeDefined();
    expect(screen.getByText(/29 pages/)).toBeDefined();
  });

  it("keeps the reason's own wording when there is a reason", () => {
    // The branches the counts must not have cost: an aborted export is still the
    // user's own doing, and quota and disk still say what to do about it.
    for (const [reason, text] of [
      ["aborted", /You stopped this export/],
      ["quota", /quota was reached/],
      ["disk", /ran out of disk space/],
    ] as const) {
      cleanup();
      renderPicker(exportIn("partial", { partialReason: reason, progress: WALK }));
      expect(screen.getByText(text)).toBeDefined();
    }
  });

  it("gives the far-side poller a stable handle on the line", () => {
    // The progress sentence is the only thing on the card that moves, and the
    // walk that proves the counts reach the snapshot samples it from outside the
    // page. A testid is what makes that sampling possible at all.
    renderPicker(exportIn("running", { progress: WALK }));

    const line = screen.getByTestId("export-progress-line");
    expect(line.textContent).toMatch(/29 pages/);
  });
});