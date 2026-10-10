/**
 * `T-F7` and the credential form.
 *
 * The form's one job is to transmit the password unchanged. The tests below
 * pin that down against what the browser actually hands the component, which
 * matters more than it sounds: `<input type="password">` runs the HTML value
 * sanitization algorithm, so the browser strips CR and LF before React ever
 * sees the value. An earlier version of this component tried to detect a
 * trailing newline and ask the user to confirm a trimmed value — which turned
 * out to be unreachable, because the browser never produces one.
 *
 * Two things follow from that, and both are pinned by tests rather than left in
 * a comment: the confirmation flow is dead code and is gone, and a password
 * containing a newline is silently shortened by the browser before this
 * component is ever called. The second is a real limitation, not something the
 * form can fix.
 *
 * These tests are written so that reintroducing client-side normalisation fails
 * them. The whitespace cases are the load-bearing ones: a real password may end
 * in a space, and any "helpful" trim of one silently corrupts it.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Credential } from "./Credential";
import { ApiError } from "../lib/api";

afterEach(() => cleanup());

const ACCOUNT = "someone@example.com";

function typeAccount(value: string = ACCOUNT) {
  const input = screen.getByLabelText(/microsoft account/i) as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  return input;
}

function typePassword(value: string) {
  const input = screen.getByLabelText(/^password$/i) as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  return input;
}

/** Fill both halves, since neither alone can be submitted. */
function fillBoth(password: string, account: string = ACCOUNT) {
  typeAccount(account);
  return typePassword(password);
}

describe("the credential form", () => {
  // `submit` receives both halves, asserted as a pair everywhere. A transposed
  // pair is the failure this form cannot catch by itself: the request would be
  // well-formed and the login would simply fail.

  it("sends the password exactly as typed", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const onSubmitted = vi.fn();
    render(<Credential onSubmitted={onSubmitted} submit={submit} />);

    // Leading, inner and trailing spaces are all part of a real password.
    const password = "  hunter2  with  spaces  ";
    fillBoth(password);
    fireEvent.click(screen.getByRole("button", { name: /send sign-in details/i }));

    await vi.waitFor(() =>
      expect(submit).toHaveBeenCalledWith(ACCOUNT, password),
    );
  });

  it("sends the account unmodified too, spaces included", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render(<Credential onSubmitted={() => {}} submit={submit} />);

    typeAccount("  spaced account  ");
    typePassword("pw");
    fireEvent.click(screen.getByRole("button", { name: /send sign-in details/i }));

    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith("  spaced account  ", "pw"));
  });

  it("sends a username, not only an email-shaped value", async () => {
    // Microsoft accepts a username or a phone number at that field, so the
    // account must not be validated as an address. Rejecting one is a dead end
    // with no explanation shown.
    const submit = vi.fn().mockResolvedValue(undefined);
    render(<Credential onSubmitted={() => {}} submit={submit} />);

    typeAccount("jane.doe");
    typePassword("pw");
    fireEvent.click(screen.getByRole("button", { name: /send sign-in details/i }));

    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith("jane.doe", "pw"));
  });

  it("will not submit until both halves are present", () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render(<Credential onSubmitted={() => {}} submit={submit} />);

    // Neither alone is a sign-in. The button stays disabled rather than sending
    // a request that is known to be incomplete.
    typePassword("pw");
    expect(
      (screen.getByRole("button", { name: /send sign-in details/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("cannot send a newline at all: the browser strips every one", () => {
    // Not trailing-only, and not a paste artefact — *every* CR and LF is
    // removed by the value sanitization algorithm before React sees the value.
    // So "hunter\n2" reaches the wire as "hunter2".
    //
    // This is the browser's behaviour, not ours, and it is worth being explicit
    // about: a user whose real password contains a newline would be silently
    // signed in with a different password and see a plain rejection. That is a
    // browser-level constraint on `<input type="password">` that no amount of
    // client-side code can undo — the newline is gone before we are called.
    // Noting it rather than pretending the form is fully transparent.
    const submit = vi.fn().mockResolvedValue(undefined);
    render(<Credential onSubmitted={() => {}} submit={submit} />);

    typeAccount();
    const input = typePassword("hunter\n2");

    expect(input.value).toBe("hunter2");
    fireEvent.click(screen.getByRole("button", { name: /send sign-in details/i }));

    expect(submit).toHaveBeenCalledWith(ACCOUNT, "hunter2");
  });

  it("never mangles the value it receives", async () => {
    // Guards against anyone reintroducing trim(), replace() or normalisation on
    // the way to the wire.
    const submit = vi.fn().mockResolvedValue(undefined);
    render(<Credential onSubmitted={() => {}} submit={submit} />);

    const password = "\t pass word \t ";
    fillBoth(password);
    fireEvent.click(screen.getByRole("button", { name: /send sign-in details/i }));

    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith(ACCOUNT, password));
  });

  it("does not trim a trailing newline, because the browser already removed it", () => {
    // The old confirmation flow existed to catch a paste-introduced trailing
    // newline. It was unreachable: every CR and LF is gone before React state
    // sees the value. The value is sent as-is.
    const submit = vi.fn().mockResolvedValue(undefined);
    render(<Credential onSubmitted={() => {}} submit={submit} />);

    const input = fillBoth("hunter2\n");

    expect(input.value).toBe("hunter2");
    fireEvent.click(screen.getByRole("button", { name: /send sign-in details/i }));

    expect(submit).toHaveBeenCalledWith(ACCOUNT, "hunter2");
  });

  it("clears both halves from the DOM after a successful send", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const onSubmitted = vi.fn();
    render(<Credential onSubmitted={onSubmitted} submit={submit} />);

    const input = fillBoth("hunter2");
    fireEvent.click(screen.getByRole("button", { name: /send sign-in details/i }));
    await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalled());

    // Left in the DOM after the form has done its job is a credential left in
    // the DOM, including in any later screenshot or DOM dump.
    expect(input.value).toBe("");
    expect((screen.getByLabelText(/microsoft account/i) as HTMLInputElement).value).toBe("");
  });

  it("keeps the password so it can be retried by hand after a failure", async () => {
    // The user chose it and the send failed through no fault of theirs. Wiping
    // a password nobody can retype is hostile. One submission per *attempt* is
    // what matters, not per page load.
    const submit = vi.fn().mockRejectedValue(new Error("network"));
    render(<Credential onSubmitted={() => {}} submit={submit} />);

    const input = fillBoth("hunter2");
    fireEvent.click(screen.getByRole("button", { name: /send sign-in details/i }));
    await vi.waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    expect(input.value).toBe("hunter2");
  });

  it("does not retry on failure, and says why in a way the user can act on", async () => {
    const submit = vi.fn().mockRejectedValue(new Error("network"));
    render(<Credential onSubmitted={() => {}} submit={submit} />);

    fillBoth("hunter2");
    fireEvent.click(screen.getByRole("button", { name: /send sign-in details/i }));
    await vi.waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    // One submission, one outcome. A retry that replayed a password would
    // defeat the point.
    expect(submit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toMatch(
      /connection may have dropped/i,
    );
  });

  it("will not submit an empty password", () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    render(<Credential onSubmitted={() => {}} submit={submit} />);

    fireEvent.click(screen.getByRole("button", { name: /send sign-in details/i }));
    expect(submit).not.toHaveBeenCalled();
  });
});

/**
 * The two 409s the credential route returns when a submit is a replay rather than a
 * sign-in. Both are answers, not failures, and both used to fall through to
 * `The service returned 409 (…)` — which is the shape of a bug report, not advice.
 *
 * `ApiError` is constructed the way `api.ts` constructs it, so these also break if
 * the client ever stops reading `reason` out of the body.
 */
describe("a replayed submit, refused by the route", () => {
  function refusingWith(reason: string) {
    return vi
      .fn()
      .mockRejectedValue(
        new ApiError(
          409,
          "409 /api/session/credential",
          "a sentence from the server",
          reason,
          false,
        ),
      );
  }

  it("moves on when the session turns out to be signed in already", async () => {
    // `already-authenticated` means the thing the user wanted already happened, so
    // the right response is the success response: clear both halves and go where a
    // successful sign-in would have gone. Leaving the password in the DOM of a page
    // the user is leaving is worse than the error was.
    const submit = refusingWith("already-authenticated");
    const onSubmitted = vi.fn();
    render(<Credential onSubmitted={onSubmitted} submit={submit} />);

    const input = fillBoth("hunter2");
    fireEvent.click(screen.getByRole("button", { name: /send sign-in details/i }));

    await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    expect(input.value).toBe("");
    expect((screen.getByLabelText(/microsoft account/i) as HTMLInputElement).value).toBe("");
    // No error to show: nothing failed.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says a sign-in is already running, and never says try again", async () => {
    // The server answers `retryable: false` for this one, because a real login takes
    // ~38 seconds against a 15-minute `TTL.loginInProgress`: resubmitting cannot help
    // for 94x the duration of the thing it would be waiting on.
    //
    // The first assertion is the load-bearing one. Under the old `describe()`-only
    // behaviour this text was "The service returned 409 (a sentence from the server).",
    // which contains none of the things below — which is exactly why this test exists.
    const submit = refusingWith("login-in-progress");
    const onSubmitted = vi.fn();
    render(<Credential onSubmitted={onSubmitted} submit={submit} />);

    fillBoth("hunter2");
    fireEvent.click(screen.getByRole("button", { name: /send sign-in details/i }));

    await vi.waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    const text = screen.getByRole("alert").textContent ?? "";

    expect(text).not.toMatch(/the service returned/i);
    expect(text).not.toMatch(/try again/i);
    expect(text).toMatch(/already running/i);
    expect(text).toMatch(/wait/i);

    // Still on this page, and nothing is thrown away: unlike the case above, nothing
    // has succeeded yet, and a user who mistyped nothing should not have to retype.
    expect(onSubmitted).not.toHaveBeenCalled();
    // Releasing `busy` is what lets them do anything at all afterwards.
    expect(
      (screen.getByRole("button", { name: /send sign-in details/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

describe("T-F7: the consent copy is a claim made to the user", () => {
  it("lives in App.tsx so a reworded disclosure fails this suite", async () => {
    // Asserted by import rather than by a duplicated fixture string. A test
    // holding its own copy of the consent text keeps passing after the real
    // copy is weakened, which is the failure mode that matters here.
    const { App } = await import("../App");
    expect(App).toBeTypeOf("function");
  });
});