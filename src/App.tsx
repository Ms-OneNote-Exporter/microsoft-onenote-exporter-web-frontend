import { useEffect, useState } from "react";
import { ApiError, ProtocolMismatchError, assertProtocol } from "./lib/api";
import { EXPECTED_PROTOCOL } from "./lib/protocol";

type Boot =
  | { phase: "checking" }
  | { phase: "mismatch"; remote: number }
  | { phase: "unreachable"; detail: string }
  | { phase: "ready"; build: string };

/**
 * Boot shell.
 *
 * The handshake runs first, before anything else, because a mismatched pair
 * must say so. Without it, this frontend against a v2 backend produces a
 * confusing 404 or a silently missing SSE field, and the natural reaction is to
 * debug the wrong component (PLAN-v3 §7.2). A version-mismatch *screen* is the
 * requirement; a broken page is not acceptable behaviour for a known,
 * expected, self-inflicted condition (T-F5).
 *
 * The pages themselves — landing, session, export flow, refresh restore — are
 * §12 step 12 and are not built yet.
 */
export function App() {
  const [boot, setBoot] = useState<Boot>({ phase: "checking" });

  useEffect(() => {
    let cancelled = false;
    assertProtocol(EXPECTED_PROTOCOL)
      .then(({ build }) => {
        if (!cancelled) setBoot({ phase: "ready", build });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ProtocolMismatchError) {
          setBoot({ phase: "mismatch", remote: err.remote });
        } else {
          setBoot({
            phase: "unreachable",
            detail: err instanceof ApiError ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  switch (boot.phase) {
    case "checking":
      return <main className="boot">Checking backend…</main>;

    case "mismatch":
      return (
        <main className="boot">
          <h1>This page is out of date</h1>
          <p>
            The frontend expects protocol {EXPECTED_PROTOCOL} but the backend
            speaks {boot.remote}. Reload to pick up the current version.
          </p>
          <button onClick={() => location.reload()}>Reload</button>
        </main>
      );

    case "unreachable":
      return (
        <main className="boot">
          <h1>Cannot reach the service</h1>
          <p>{boot.detail}</p>
          <p>
            This page is served independently of the backend, so it can load
            while the service is down. Nothing is lost — try again shortly.
          </p>
        </main>
      );

    case "ready":
      return (
        <main className="boot">
          <h1>OneNote Exporter</h1>
          <p>Backend protocol {EXPECTED_PROTOCOL} confirmed.</p>
          <Consent />
        </main>
      );
  }
}

/**
 * The consent block. Asserted against the rendered string rather than against
 * a mechanism, because this is a claim made to the user (T-F7).
 *
 * The wording is load-bearing and was previously understated. `microsoft-webauth`
 * auto-accepts updated Terms of Use and Microsoft consent pages by matching a
 * fixed set of button labels, and **accepting the Services Agreement is a real
 * change to the user's account** — not merely a dismissal of a dialog. Saying
 * only that it "accepts Terms of Use and security prompts" undersells that.
 */
function Consent() {
  return (
    <section className="consent">
      <h2>Before you sign in</h2>
      <ul>
        <li>
          This is an <strong>unofficial</strong> service. It is not affiliated
          with or endorsed by Microsoft.
        </li>
        <li>
          You will type your <strong>Microsoft account password</strong> into
          this page. It is sent over TLS directly to the service and forwarded
          to an isolated container for that session without being parsed, logged
          or written to disk. It is gone when you erase your session.
        </li>
        <li>
          Signing in runs an automated browser session, and{" "}
          <strong>
            accepting Microsoft consent and updated-terms prompts changes your
            account
          </strong>{" "}
          — it can update the terms you are bound by and your security-info
          settings. It will not add or remove a sign-in method.
        </li>
        <li>
          If you would rather not hand a Microsoft password to a web service,{" "}
          <strong>use the local exporter instead</strong>:{" "}
          <code>microsoft-onenote-exporter</code> produces the same vault on your
          own machine and no password leaves it.
        </li>
      </ul>
    </section>
  );
}
