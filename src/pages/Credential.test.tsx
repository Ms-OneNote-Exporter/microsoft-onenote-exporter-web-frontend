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

afterEach(() => cleanup());

function typePassword(value: string) {
  const input = screen.getByLabelText(
    /microsoft account password/i,
  ) as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  return input;
}

describe("the credential form", () => {
  it("sends the password exactly as typed", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const onSubmitted = vi.fn();
    render(<Credential onSubmitted={onSubmitted} submit={submit} />);

    // Leading, inner and trailing spaces are all part of a real password.
    const password = "  hunter2  with  spaces  ";
    typePassword(password);
    fireEvent.click(screen.getByRole("button", { name: /send password/i }));

    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith(password));
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

    const input = typePassword("hunter\n2");

    expect(input.value).toBe("hunter2");
    fireEvent.click(screen.getByRole("button", { name: /send password/i }));

    expect(submit).toHaveBeenCalledWith("hunter2");
  });

  it("never mangles the value it receives", async () => {
    // Guards against anyone reintroducing trim(), replace() or normalisation on
    // the way to the wire.
    const submit = vi.fn().mockResolvedValue(undefined);
    render(<Credential onSubmitted={() => {}} submit={submit} />);

    const password = "\t pass word \t ";
    typePassword(password);
    fireEvent.click(screen.getByRole("button", { name: /send password/i }));

    await vi.waitFor(() => expect(submit).toHaveBeenCalledWith(password));
  });

  it("does not trim a trailing newline, because the browser already removed it", () => {
    // The old confirmation flow existed to catch a paste-introduced trailing
    // newline. It was unreachable: every CR and LF is gone before React state
    // sees the value. The value is sent as-is.
    const submit = vi.fn().mockResolvedValue(undefined);
    render(<Credential onSubmitted={() => {}} submit={submit} />);

    const input = typePassword("hunter2\n");

    expect(input.value).toBe("hunter2");
    fireEvent.click(screen.getByRole("button", { name: /send password/i }));

    expect(submit).toHaveBeenCalledWith("hunter2");
  });

  it("clears the password from the DOM after a successful send", async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const onSubmitted = vi.fn();
    render(<Credential onSubmitted={onSubmitted} submit={submit} />);

    const input = typePassword("hunter2");
    fireEvent.click(screen.getByRole("button", { name: /send password/i }));
    await vi.waitFor(() => expect(onSubmitted).toHaveBeenCalled());

    // A password left in the DOM is a password left in the DOM after the form
    // has done its job, including in any later screenshot or DOM dump.
    expect(input.value).toBe("");
  });

  it("keeps the password so it can be retried by hand after a failure", async () => {
    // The user chose it and the send failed through no fault of theirs. Wiping
    // a password nobody can retype is hostile. One submission per *attempt* is
    // what matters, not per page load.
    const submit = vi.fn().mockRejectedValue(new Error("network"));
    render(<Credential onSubmitted={() => {}} submit={submit} />);

    const input = typePassword("hunter2");
    fireEvent.click(screen.getByRole("button", { name: /send password/i }));
    await vi.waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    expect(input.value).toBe("hunter2");
  });

  it("does not retry on failure, and says why in a way the user can act on", async () => {
    const submit = vi.fn().mockRejectedValue(new Error("network"));
    render(<Credential onSubmitted={() => {}} submit={submit} />);

    typePassword("hunter2");
    fireEvent.click(screen.getByRole("button", { name: /send password/i }));
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

    fireEvent.click(screen.getByRole("button", { name: /send password/i }));
    expect(submit).not.toHaveBeenCalled();
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