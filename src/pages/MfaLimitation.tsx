/**
 * Build limitations, stated before the user hits them.
 *
 * `microsoft-webauth`'s `dismissFidoPage()` clicks **Cancel** on an
 * authenticator approval screen. That makes number-match MFA — the variant where
 * Authenticator shows a two-digit number and you type it in — impossible to
 * bridge from outside the package: it needs to show a number and wait passively,
 * which is a different code path rather than a flag.
 *
 * The decision was to decline it rather than half-build it. A partial
 * implementation would work for the push-approval case and silently mis-handle
 * number-match, and the user would be shown a number that is not the number —
 * which is worse than not supporting it, because they would act on it.
 *
 * So it is stated here instead, **before** the user reaches the screen rather
 * than as a failure afterwards. A dead end with no explanation is the outcome
 * this avoids.
 *
 * Code-based MFA — the emailed or texted one-time code — works, and is a
 * different path entirely.
 */
export function MfaLimitation() {
  return (
    <aside className="notice" aria-label="Known limitation">
      <p>
        <strong>One kind of two-factor sign-in cannot be completed here.</strong>{" "}
        If Microsoft Authenticator asks you to <em>approve a sign-in request on
        your phone</em>, that works. If it instead shows you a{" "}
        <strong>number to type in</strong> (number matching), this build cannot
        complete it.
      </p>
      <p className="fineprint">
        Known limitation, not a fault with your account. If you hit it, use the
        code Microsoft emails or texts you instead, or use the{" "}
        <code>microsoft-onenote-exporter</code> command-line tool, which has no
        such limit.
      </p>
    </aside>
  );
}