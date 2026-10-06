/**
 * The credential page. The Microsoft account and its password are typed here and
 * nowhere else.
 *
 * **Neither value is altered by this file.** Both are sent exactly as typed.
 *
 * ## Why the account travels in a header and not in the body
 *
 * The obvious design is one body: account, newline, password. That was rejected,
 * and the reason is worth recording because it is the only argument that decides
 * it.
 *
 * Every guarantee this project has built about the credential is that the body is
 * byte-identical from here, through the api's forwarder, to the runner. A
 * delimiter is another place for a truncation bug — and that bug has shipped
 * **twice from opposite ends**: the body was JSON-encoded here (PR #1), and the
 * stream ended before it began there (PR #19). Both produced "wrong password",
 * a symptom that points at the user, at Microsoft, or at neither.
 *
 * The account is not a secret in the way the password is, so it rides in
 * `X-Microsoft-Account` and the body stays untouched. All 20 byte-equality cases
 * on both sides continue to mean exactly what they say.
 *
 * ## Why nothing is trimmed
 *
 * Not the password, and not the account. A password with a real trailing space is
 * a valid password, and any "helpful" normalisation of one risks corrupting it.
 * The backend passes the account through unmodified for the same reason: a trim
 * there would be invisible at every layer above and would break the login at the
 * far end.
 *
 * An earlier version of this file detected a trailing newline — a paste artefact
 * — and required confirmation before sending a trimmed value. That was
 * unreachable: `<input type="password">` has a value sanitization algorithm that
 * strips newlines, so the value never reaches React state with a CR or LF in it.
 *
 * Where the user's input is opaque, transmit it unchanged and let the server
 * reject it if it is genuinely wrong. A visible failure beats a silent
 * corruption.
 */
import { useState } from "react";
import { ApiError } from "../lib/api";
import { MfaLimitation } from "./MfaLimitation";

export interface CredentialProps {
  onSubmitted: () => void;
  submit: (account: string, password: string) => Promise<void>;
}

/**
 * RFC 5321 caps an address at 320 characters. Used only to enable the button
 * and to keep an accidental paste of an entire file from becoming a request.
 *
 * **Not validated as an email address**, deliberately: Microsoft accepts a
 * username, a phone number or an email at that field, and telling someone to
 * "enter your email" when their account is a username is a dead end with no
 * explanation. The backend applies the same bound and the same refusal to guess.
 */
const MAX_ACCOUNT_LENGTH = 320;

export function Credential({ onSubmitted, submit }: CredentialProps) {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accountReady = account.length > 0 && account.length <= MAX_ACCOUNT_LENGTH;
  const canSubmit = accountReady && password.length > 0 && !busy;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    setBusy(true);
    setError(null);
    try {
      await submit(account, password);
      // Cleared unconditionally: a credential must not be left in the DOM once it
      // has been handed over, including in a later screenshot or DOM dump.
      setAccount("");
      setPassword("");
      onSubmitted();
    } catch (err) {
      setError(describe(err));
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={onSubmit}>
      <h2>Sign in to Microsoft</h2>

      <p>
        Your account and password go straight to the service over TLS and on to an
        isolated container for this session. Neither is parsed, logged or written
        to disk.
      </p>

      <label className="field" htmlFor="account">
        Microsoft account
      </label>
      <input
        id="account"
        name="account"
        type="text"
        value={account}
        onChange={(e) => {
          setAccount(e.target.value);
          setError(null);
        }}
        autoComplete="username"
        spellCheck={false}
        autoCapitalize="none"
        disabled={busy}
      />
      <p className="fineprint">
        The email address, username or phone number you sign in to Microsoft
        with. Both this and your password are sent exactly as typed, including
        any spaces.
      </p>

      <label className="field" htmlFor="password">
        Password
      </label>
      <input
        id="password"
        name="password"
        type="password"
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          setError(null);
        }}
        autoComplete="off"
        disabled={busy}
      />

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <button type="submit" disabled={!canSubmit}>
        {busy ? "Sending…" : "Send sign-in details"}
      </button>

      {/* Stated here, before the user submits, rather than as a failure
          afterwards. A dead end with no explanation is what this avoids. */}
      <MfaLimitation />

      <p className="fineprint">
        One submission, one attempt. It is not retried automatically, because a
        retry that replayed your password would defeat the point of sending it
        once.
      </p>
    </form>
  );
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401 || err.status === 403) {
      return "The service rejected those sign-in details.";
    }
    if (err.status === 429) {
      return "Too many attempts from this address. Wait before trying again.";
    }
    if (err.status === 404) {
      return "The session is no longer valid. Start a new one.";
    }
    if (err.status === 400) {
      // The route refuses an absent account before forwarding anything, so a 400
      // here means the request was malformed rather than the sign-in failing.
      return "The service could not accept those sign-in details. Please try again.";
    }
    return `The service returned ${err.status}${
      err.code ? ` (${err.code})` : ""
    }.`;
  }
  return "The sign-in details could not be sent. The connection may have dropped.";
}