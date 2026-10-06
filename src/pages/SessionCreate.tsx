/**
 * Session creation. PLAN-v2 §9.1: "enter a GUID", "generate for me", and an
 * explicit warning that it cannot be recovered.
 *
 * The GUID is the session's identifier and it is unrecoverable by design — it
 * is the SQLite primary key server-side and nothing else can name the row. So
 * the warning is not decoration: a user who closes the tab has lost the handle
 * to their own session, and the only recovery is an erase.
 *
 * The secret is generated here and never displayed, never stored, never sent
 * anywhere but `POST /api/session`. It comes back only as an HttpOnly cookie.
 */
import { useState } from "react";
import { ApiError } from "../lib/api";
import {
  SECRET_LENGTH,
  generateSessionGuid,
  generateSessionSecret,
} from "../lib/session-secret";

export interface SessionCreateProps {
  onCreated: (guid: string) => void;
  create: (guid: string, secret: string) => Promise<void>;
}

export function SessionCreate({ onCreated, create }: SessionCreateProps) {
  const [guid, setGuid] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = guid.trim();
  const usable = trimmed.length > 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!usable || busy) return;
    setBusy(true);
    setError(null);
    try {
      await create(trimmed, generateSessionSecret());
      onCreated(trimmed);
    } catch (err) {
      setError(describe(err));
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>Start a session</h2>

      <p>
        A session needs an identifier. It is generated in your browser, sent once
        with the session secret, and never written down anywhere you can read it
        back.
      </p>

      <label className="field" htmlFor="guid">
        Session identifier
      </label>
      <input
        id="guid"
        name="guid"
        value={guid}
        onChange={(e) => setGuid(e.target.value)}
        placeholder="00000000-0000-0000-0000-000000000000"
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
      />

      <button
        type="button"
        className="link"
        onClick={() => setGuid(generateSessionGuid())}
        disabled={busy}
      >
        Generate one for me
      </button>

      <p className="warn">
        <strong>This identifier cannot be recovered.</strong> It is not an
        account and there is no reset link. If you lose it, the only way forward
        is to erase the session and start again.
      </p>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <button type="submit" disabled={!usable || busy}>
        {busy ? "Creating…" : "Create session"}
      </button>

      <p className="fineprint">
        A {SECRET_LENGTH}-character session secret is generated alongside it and
        used to authorise this session. It is stored only as a hash, and it is
        never displayed here.
      </p>
    </form>
  );
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return "That identifier is already in use.";
    if (err.status === 429) return "Too many attempts. Wait a moment.";
    return `The server refused the session (${err.status}${
      err.code ? `, ${err.code}` : ""
    }).`;
  }
  return "The session could not be created. Check the connection.";
}