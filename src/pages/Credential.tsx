/**
 * The credential page. The Microsoft password is typed here and nowhere else.
 *
 * Nothing in this file alters the password. It is sent byte-for-byte as typed.
 *
 * That was not the original design, and the reason is worth recording. An
 * earlier version detected a trailing newline — the artefact a paste from a
 * terminal adds — showed the user the trimmed value and required a second
 * confirmation before sending. The backend does not trim, so a newline would
 * have arrived as part of the password and failed the sign-in.
 *
 * The feature is gone because it was unreachable. `<input type="password">` has
 * a value sanitization algorithm that strips newlines: the HTML spec requires
 * it, every browser implements it, and the value never reaches React state with
 * a CR or LF in it. So there is no paste artefact to detect, and a confirmation
 * step guarding an impossible case is a step that only makes the flow slower.
 *
 * Trimming was also the wrong instinct in the first place. A password with a
 * real trailing space is a valid password, and any "helpful" normalisation of
 * one risks corrupting it. Where the user's input is opaque, transmit it
 * unchanged and let the server reject it if it is genuinely wrong — a visible
 * failure is better than a silent corruption.
 */
import { useState } from "react";
import { ApiError } from "../lib/api";

export interface CredentialProps {
  onSubmitted: () => void;
  submit: (password: string) => Promise<void>;
}

export function Credential({ onSubmitted, submit }: CredentialProps) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || password.length === 0) return;

    setBusy(true);
    setError(null);
    try {
      await submit(password);
      // Cleared unconditionally: the password must not be left in the DOM once
      // it has been handed over, including in a later screenshot or DOM dump.
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
        Your password goes straight to the service over TLS and on to an isolated
        container for this session. It is not parsed, not logged and not written
        to disk.
      </p>

      <label className="field" htmlFor="password">
        Microsoft account password
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

      <button type="submit" disabled={busy || password.length === 0}>
        {busy ? "Sending…" : "Send password"}
      </button>

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
      return "The service rejected that password.";
    }
    if (err.status === 429) {
      return "Too many attempts from this address. Wait before trying again.";
    }
    if (err.status === 404) {
      return "The session is no longer valid. Start a new one.";
    }
    return `The service returned ${err.status}${
      err.code ? ` (${err.code})` : ""
    }.`;
  }
  return "The password could not be sent. The connection may have dropped.";
}