/**
 * The consent block.
 *
 * Extracted from `App.tsx` into its own module for one reason: `T-F7` asserts
 * this copy against the *rendered* text, and a component that lives inside a
 * larger one can only be rendered by rendering all of it — which means booting
 * the protocol handshake, and then asserting against a boot screen.
 *
 * The wording is load-bearing and was previously understated. `microsoft-webauth`
 * auto-accepts updated Terms of Use and Microsoft consent pages by matching a
 * fixed set of button labels, and **accepting the Services Agreement is a real
 * change to the user's account** — not merely a dismissal of a dialog. Saying
 * only that it "accepts Terms of Use and security prompts" undersells that, and
 * underselling a change to someone's account is a disclosure failure.
 */
import { api } from "../lib/api";
import { SessionCreate } from "./SessionCreate";

export function Consent({ onStarted }: { onStarted: () => void }) {
  return (
    <section className="consent">
      <h2>Before you sign in</h2>
      <ul>
        <li>
          This is an <strong>unofficial</strong> service. It is not affiliated
          with or endorsed by Microsoft.
        </li>
        <li>
          You will type your <strong>Microsoft account and password</strong> into
          this page. They are sent over TLS directly to the service and forwarded
          to an isolated container for that session without being parsed, logged
          or written to disk. They are gone when you erase your session.
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

      {/*
        The create form sits below the consent block rather than behind a
        separate step, because the consent text is a disclosure the user has to
        read *before* they are anywhere near a password field — and there is no
        password field here. `onStarted` moves on once the session exists.
      */}
      <SessionCreate
        onCreated={onStarted}
        create={async (guid, secret) => {
          // The response carries the CSRF token, but the token is read from the
          // status snapshot that `onStarted` triggers anyway — one source, and
          // the same one that restores it after a reload.
          await api.createSession(guid, secret);
        }}
      />
    </section>
  );
}