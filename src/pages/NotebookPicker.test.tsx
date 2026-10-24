/**
 * The List button was live on a session with no Microsoft sign-in.
 *
 * ## What a user did
 *
 * Started a session, typed their password, and pressed **List my notebooks** while the
 * sign-in was still running. The backend refused, correctly:
 *
 *     "Still signing in — the service is not ready to list notebooks yet. Try again in a moment."
 *
 * The message was **accurate**. `auth.state` was `authenticating`; the login completed 24
 * seconds later. Nothing was broken.
 *
 * That is the point. The button offered an action that could not succeed, and the only
 * possible outcome was a refusal — so a normal part of signing in looked like a failure,
 * and the user had no way to know that waiting was all that was needed.
 *
 * ## Why this was not caught
 *
 * The component already knew. `signedIn` gated the **Export** button two elements below,
 * and the hint below that told the reader to sign in first. The List button was gated on
 * `listingPending` and `view.state` — the two *listing* windows — and neither of them can
 * distinguish "not signed in yet" from "signed in, nothing listed", because
 * `notebooks.state === "idle"` is true in both cases.
 *
 * So the information was present and unused. These tests assert the gate on each state, so
 * the asymmetry with Export cannot come back.
 *
 * ## What each test pins
 *
 * That the button is **disabled** and says why when the session is not signed in, that it
 * is enabled once it is, and that the two listing windows still hold — the fix must not
 * have cost those.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { NotebookPicker } from "./NotebookPicker";
import type { AuthState, NotebookList } from "../lib/session";

afterEach(() => cleanup());

const IDLE: NotebookList = { state: "idle", items: [] };
const LOADED: NotebookList = { state: "loaded", items: ["Work"] };
const LISTING: NotebookList = { state: "listing", items: [] };

function renderPicker(
  overrides: Partial<{
    signedIn: boolean;
    authState: AuthState;
    notebooks: NotebookList;
    listingPending: boolean;
    challengeActive: boolean;
    onList: () => void;
  }> = {},
) {
  const onList = overrides.onList ?? vi.fn();
  render(
    <NotebookPicker
      notebooks={overrides.notebooks ?? IDLE}
      signedIn={overrides.signedIn ?? true}
      authState={overrides.authState ?? "none"}
      challengeActive={overrides.challengeActive ?? false}
      // `null`, not a stubbed object: a truthy `running` makes the component render
      // `ExportProgress` instead of the chooser, which is a silent way to write a test
      // that asserts on the wrong subtree.
      export={null}
      streamState="open"
      listingPending={overrides.listingPending ?? false}
      onList={onList}
      onStart={vi.fn()}
      onAbort={vi.fn()}
      actionError={null}
    />,
  );
  // Every label the button takes: "List my notebooks", "Sign in to list",
  // "Asking the service…", "Listing…", and "Signing in to Microsoft…"
  // when authState is "authenticating". Querying by one of them would make each test
  // depend on a label it is not testing, and fail on the states it is.
  // The regex now includes "signing in" to match the signing-in label.
  return {
    onList,
    button: screen.getByRole("button", { name: /list|signing in|sign in|asking/i }),
  };
}

/**
 * Whether the button refuses a click.
 *
 * The DOM property rather than `toBeDisabled`, because this project does not load
 * `@testing-library/jest-dom` and every other page test asserts through the DOM too.
 */
function isDisabled(button: HTMLElement): boolean {
  return (button as HTMLButtonElement).disabled;
}

describe("a session with no Microsoft sign-in", () => {
  it("cannot be asked to list, because listing cannot succeed", () => {
    // The bug. The button was live here, and its only possible outcome was a 409.
    const { button } = renderPicker({ signedIn: false });

    expect(isDisabled(button)).toBe(true);
  });

  it("says what would make it work, rather than just refusing", () => {
    // A disabled button with no explanation reads as broken. This one names the
    // precondition.
    const { button } = renderPicker({ signedIn: false });

    expect(button.textContent).toMatch(/sign in/i);
  });

  it("is disabled even while nothing has been listed", () => {
    // `notebooks.state === "idle"` is true both before signing in and after, so gating
    // on it cannot distinguish the two cases.
    const { button } = renderPicker({ signedIn: false, notebooks: IDLE });

    expect(isDisabled(button)).toBe(true);
  });

  it("is disabled even when a previous listing produced notebooks", () => {
    // The stale case: a list on screen from before a sign-in was invalidated.
    const { button } = renderPicker({ signedIn: false, notebooks: LOADED });

    expect(isDisabled(button)).toBe(true);
  });

  it("agrees with the Export button, which was already gated", () => {
    // The asymmetry that let this through: both are gated on `signedIn`, and they must
    // not disagree.
    renderPicker({ signedIn: false });

    const list = screen.getByRole("button", { name: /sign in to list/i });
    const exportButton = screen.getByRole("button", { name: /^export/i });
    expect(isDisabled(list)).toBe(true);
    expect(isDisabled(exportButton)).toBe(true);
  });
});

describe("a signed-in session", () => {
  it("can list", () => {
    const { button } = renderPicker({ signedIn: true, notebooks: IDLE });

    expect(isDisabled(button)).toBe(false);
    expect(button.textContent).toMatch(/list my notebooks/i);
  });

  it("is still disabled while the request is on the wire", () => {
    // The window this gate was originally added for, and it must survive.
    const { button } = renderPicker({ signedIn: true, listingPending: true });

    expect(isDisabled(button)).toBe(true);
  });

  it("is still disabled while the snapshot says a listing is running", () => {
    const { button } = renderPicker({ signedIn: true, notebooks: LISTING });

    expect(isDisabled(button)).toBe(true);
    expect(button.textContent).toMatch(/listing/i);
  });

  it("can list again once a listing has finished", () => {
    const { button } = renderPicker({ signedIn: true, notebooks: LOADED });

    expect(isDisabled(button)).toBe(false);
  });
});

/**
 * While a Microsoft sign-in is in progress (`authState: "authenticating"`), show a
 * visible notice so the user doesn't think the app is stuck.
 */
describe("while a sign-in is in progress", () => {
  it("shows a signing-in notice", () => {
    // authState: "authenticating", signedIn: false, challengeActive: false
    renderPicker({ authState: "authenticating", signedIn: false, challengeActive: false });

    const notice = screen.getByRole("status", { name: /signing in to microsoft/i });
    expect(notice).toBeDefined();
  });

  it("says on the button that the sign-in is running", () => {
    // The control states the truth rather than offering a click that cannot
    // succeed. The label is what the user reads while waiting.
    const { button } = renderPicker({
      authState: "authenticating",
      signedIn: false,
      challengeActive: false,
    });

    expect(button.textContent).toMatch(/signing in to microsoft/i);
  });

  it("still refuses the click, because listing cannot succeed yet", () => {
    // The 409 trap, closed.
    //
    // The button says "Signing in to Microsoft…" and stays **disabled**. A live
    // button here could only ever produce the refusal "Still signing in — the
    // service is not ready to list notebooks yet", so making it live during the
    // sign-in would re-open the trap the `!signedIn` gate exists to close.
    //
    // This is pinned separately from the label because the two were once changed
    // together by accident, and the label test stayed green while the button
    // became live.
    const { button } = renderPicker({
      authState: "authenticating",
      signedIn: false,
      challengeActive: false,
    });

    expect(isDisabled(button)).toBe(true);
  });

  it("does not show the misleading fineprint about sending password", () => {
    // In this state, the fineprint that says "Send your password on the
    // previous step first" should be hidden because the user is already in
    // the process of signing in.
    renderPicker({ authState: "authenticating", signedIn: false, challengeActive: false });

    expect(screen.queryByText(/send your password on the previous step/i)).toBeNull();
  });

  it("when signed in, the notice is absent", () => {
    // authState: "valid", signedIn: true — the user is already in
    renderPicker({ authState: "valid", signedIn: true });

    expect(screen.queryByRole("status", { name: /signing in to microsoft/i })).toBeNull();
  });

  it("when not signed in and not authenticating, the button label is 'Sign in to list' and the fineprint is present", () => {
    // authState: "none", signedIn: false — this is the plain pre-sign-in state
    const { button } = renderPicker({ authState: "none", signedIn: false, challengeActive: false });

    expect(button.textContent).toMatch(/sign in to list/i);
    expect(screen.getByText(/send your password on the previous step/i)).toBeDefined();
  });

  it("when a sign-in has failed, the stale 'send your password' copy is replaced", () => {
    // authState: "expired", signedIn: false — Microsoft refused the sign-in. The
    // old instruction to send a password is not actionable from here.
    renderPicker({ authState: "expired", signedIn: false, challengeActive: false });

    expect(screen.getByText(/microsoft refused the sign-in/i)).toBeDefined();
    expect(screen.queryByText(/send your password on the previous step/i)).toBeNull();
  });

  it("when a challenge is active, the generic notice is suppressed", () => {
    // An MFA challenge is outstanding — App.tsx shows the actionable phone-approval
    // notice itself, so the generic "hold this tab open" notice must be suppressed.
    renderPicker({ authState: "authenticating", signedIn: false, challengeActive: true });

    expect(screen.queryByRole("status", { name: /signing in to microsoft/i })).toBeNull();
  });
});
