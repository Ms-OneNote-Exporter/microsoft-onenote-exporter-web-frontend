/**
 * `ChallengeAnswer` — the typed MFA code path.
 *
 * ## Why this file is the only proof that path exists
 *
 * A user with a phone and a sign-in code used to be given a notice saying "follow the
 * prompt on your phone" and, at the same moment, a `login-failed
 * {reason: "challenge-not-supported"}` from the api. The account's password was
 * fine; nothing in the product could collect the code that would have finished the
 * sign-in. **No component rendered an input**, so no test of the notice could fail,
 * because the missing thing was the absence of a page.
 *
 * So these assertions are about the parts that did not exist: the input, the submit,
 * the call, and what the user is told when it goes wrong.
 *
 * The countdown is asserted from a fixed `now` rather than the wall clock — it is a
 * number a user acts on, and a test that waits for it to tick would be testing the
 * scheduler.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import type { Mock } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import { ChallengeAnswer } from "./ChallengeAnswer";
import { ApiError } from "../lib/api";
import type { Challenge } from "../lib/events-contract";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** A code challenge, with the fields `parseChallenge` would have produced. */
function codeChallenge(over: Partial<Challenge> = {}): Challenge {
  return { kind: "code", label: "", number: null, expiresAt: null, ...over };
}

/**
 * A stand-in `submit` whose spy is still typed, and `submittedCode` to read it back.
 *
 * `vi.fn(async () => {})` infers a zero-argument signature, so `mock.calls[0][0]` is a
 * tuple with no element 0 — a compile error rather than a run-time one, which is the
 * right place to find it. This pair keeps the argument in the type.
 */
function submittedSpy(): Mock<(code: string) => Promise<void>> {
  return vi.fn(async (_code: string) => {});
}

function submittedCode(spy: Mock<(code: string) => Promise<void>>): string {
  return spy.mock.calls[0]![0];
}

async function typeCode(value: string): Promise<void> {
  const input = screen.getByLabelText(/sign-in code/i);
  await act(async () => {
    (input as HTMLInputElement).focus();
    setNativeValue(input as HTMLInputElement, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * React installs its own value setter on the element, so assigning `.value` directly
 * is invisible to it — the component would never see the change. This is the
 * standard way to type into a controlled input in a test.
 */
function setNativeValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;
  if (setter === undefined) throw new Error("no value setter on HTMLInputElement");
  setter.call(element, value);
}

describe("the code challenge", () => {
  it("asks for the code, in the words the user needs", () => {
    render(
      <ChallengeAnswer challenge={codeChallenge()} submit={async () => {}} onAnswered={() => {}} />,
    );

    // The heading is the assertion. "Your account needs another check" with no input
    // is what this replaced.
    expect(
      screen.getByRole("heading", { name: /enter the code microsoft sent you/i }),
    ).not.toBeNull();
    // An input, labelled, and not a password field — a six-digit code is not one, and
    // `type="password"` would hide it from a screen reader's announcement.
    const input = screen.getByLabelText(/sign-in code/i) as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
  });

  it("shows what the backend saw on screen when it said anything", () => {
    render(
      <ChallengeAnswer
        challenge={codeChallenge({ label: "Enter the code we sent to your phone" })}
        submit={async () => {}}
        onAnswered={() => {}}
      />,
    );

    expect(screen.getByText("Enter the code we sent to your phone")).not.toBeNull();
  });

  it("sends the code exactly as typed and then clears the prompt", async () => {
    const submit = submittedSpy();
    const onAnswered = vi.fn();
    render(
      <ChallengeAnswer challenge={codeChallenge()} submit={submit} onAnswered={onAnswered} />,
    );

    // **With surrounding whitespace on purpose.** `"123456".trim()` is `"123456"`,
    // so a value with nothing to trim cannot tell "sent as typed" from "trimmed on
    // the way out" — and a trim is exactly the transformation this must not do.
    await typeCode(" 123456 ");
    await act(async () => {
      screen.getByRole("button", { name: /send code/i }).click();
    });

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    // Not trimmed, not reformatted: a transformation applied to a value the user
    // cannot inspect again once it is handed over turns a typo into an unexplained
    // login failure.
    expect(submittedCode(submit)).toBe(" 123456 ");
    // The prompt is dropped on acceptance, not on success — success is minutes away
    // and a code is live for a couple of them.
    expect(onAnswered).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText(/sign-in code/i) as HTMLInputElement).value).toBe("");
  });

  it("does not submit an empty code", async () => {
    const submit = submittedSpy();
    render(
      <ChallengeAnswer challenge={codeChallenge()} submit={submit} onAnswered={() => {}} />,
    );

    const button = screen.getByRole("button", { name: /send code/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // Whitespace is not a code. A blank would resolve the pending prompt with
    // nothing, spending the user's one chance to answer.
    await typeCode("   ");
    expect(button.disabled).toBe(true);
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not accept a code longer than the server's bound of 32", async () => {
    const submit = submittedSpy();
    render(
      <ChallengeAnswer challenge={codeChallenge()} submit={submit} onAnswered={() => {}} />,
    );

    await typeCode("1".repeat(33));
    const button = screen.getByRole("button", { name: /send code/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(submit).not.toHaveBeenCalled();

    // The boundary is the assertion: 32 is accepted, 33 is not.
    await typeCode("1".repeat(32));
    expect(button.disabled).toBe(false);
  });

  it("counts down from the challenge's own expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T09:00:00.000Z"));
    const onAnswered = vi.fn();
    render(
      <ChallengeAnswer
        challenge={codeChallenge({ expiresAt: "2026-10-14T09:02:00.000Z" })}
        submit={async () => {}}
        onAnswered={onAnswered}
      />,
    );

    expect(screen.getByTestId("mfa-countdown").textContent).toMatch(/120 seconds/);

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    // Ticked, not computed once at render: a countdown that does not move while a
    // user reads it is decoration.
    expect(screen.getByTestId("mfa-countdown").textContent).toMatch(/60 seconds/);
  });

  it("shows no countdown at all when the challenge carried no expiry", () => {
    // The runner sends `null` when it did not report a duration. A number invented
    // from a default would be a deadline nobody measured, shown to somebody deciding
    // whether they still have time.
    render(
      <ChallengeAnswer challenge={codeChallenge()} submit={async () => {}} onAnswered={() => {}} />,
    );

    expect(screen.queryByTestId("mfa-countdown")).toBeNull();
  });

  it("says the code expired rather than counting into negatives", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T09:00:00.000Z"));
    render(
      <ChallengeAnswer
        challenge={codeChallenge({ expiresAt: "2026-10-14T09:02:00.000Z" })}
        submit={async () => {}}
        onAnswered={() => {}}
      />,
    );

    await act(async () => {
      vi.advanceTimersByTime(200_000);
    });

    expect(screen.getByTestId("mfa-countdown").textContent).toMatch(/expired/i);
    // Submitting an expired code cannot help, so the button refuses it.
    expect((screen.getByRole("button", { name: /send code/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("reports a wrong code without dropping the form", async () => {
    const submit = vi.fn(async () => {
      throw new ApiError(400, "400 /api/session/challenge/answer", "code is too long");
    });
    const onAnswered = vi.fn();
    render(
      <ChallengeAnswer challenge={codeChallenge()} submit={submit} onAnswered={onAnswered} />,
    );

    await typeCode("000000");
    await act(async () => {
      screen.getByRole("button", { name: /send code/i }).click();
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/would not accept that code/i);
    // The prompt stays. A failed attempt is not a reason to make the user wait for
    // another `challenge` event that may never come.
    expect(onAnswered).not.toHaveBeenCalled();
    expect((screen.getByLabelText(/sign-in code/i) as HTMLInputElement).value).toBe("000000");
  });

  it("distinguishes 'nothing is waiting' from 'sign-in failed'", async () => {
    // A 409 is the server saying the prompt it was answering has gone — expired, or
    // never a code prompt at all. "sign-in failed" would tell the user their code was
    // wrong when the answer was that there was nothing to be wrong about.
    const submit = vi.fn(async () => {
      throw new ApiError(409, "409 /api/session/challenge/answer", "not-ready:conflict");
    });
    render(
      <ChallengeAnswer challenge={codeChallenge()} submit={submit} onAnswered={() => {}} />,
    );

    await typeCode("123456");
    await act(async () => {
      screen.getByRole("button", { name: /send code/i }).click();
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/nothing is waiting/i);
    expect(alert.textContent).not.toMatch(/sign-in failed/i);
  });

  it("renders nothing for a number-match challenge", () => {
    // There is no code to type on that path — the user approves it on their phone —
    // and an input asking for six digits would be a question they cannot answer.
    render(
      <ChallengeAnswer
        challenge={{ kind: "phone-approval", label: "Tap approve", number: "42 918 337", expiresAt: null }}
        submit={async () => {}}
        onAnswered={() => {}}
      />,
    );

    expect(screen.queryByLabelText(/sign-in code/i)).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});