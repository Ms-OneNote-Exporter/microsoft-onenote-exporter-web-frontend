import { useCallback, useEffect, useState } from "react";
import { ApiError, ProtocolMismatchError, api, assertProtocol } from "./lib/api";
import { EXPECTED_PROTOCOL } from "./lib/protocol";
import {
  parseExport,
  parseSessionStatus,
  type NotebookList,
  type SessionStatus,
} from "./lib/session";
import { useEventStream } from "./lib/useEventStream";
import { Consent } from "./pages/Consent";
import { Credential } from "./pages/Credential";
import { NotebookPicker } from "./pages/NotebookPicker";

type Boot =
  | { phase: "checking" }
  | { phase: "mismatch"; remote: number }
  | { phase: "unreachable"; detail: string }
  | { phase: "ready"; build: string };

/**
 * Which page to show. Derived from the session snapshot rather than held as
 * separate state, so a refresh lands on the right page instead of the landing
 * screen with a live session behind it.
 *
 * `guid` is the one exception: it is never read back from the server, so after
 * a refresh it is genuinely unknown and only the cookie can restore the session.
 * The UI does not claim otherwise — `needsGuid` shows the create page, which
 * explains it.
 */
type View = "consent" | "credential" | "export";

export function App() {
  const [boot, setBoot] = useState<Boot>({ phase: "checking" });
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [view, setView] = useState<View>("consent");

  // --- handshake ------------------------------------------------------------
  //
  // Runs first, before anything else, because a mismatched pair must say so.
  // Without it, a v3 frontend against a v2 backend produces a confusing 404 or
  // a silently missing SSE field, and the natural reaction is to debug the
  // wrong component (PLAN-v3 §7.2). A version-mismatch *screen* is the
  // requirement; a broken page is not acceptable behaviour for a known,
  // expected, self-inflicted condition (T-F5).
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

  const ready = boot.phase === "ready";

  // --- snapshot -------------------------------------------------------------
  const refreshStatus = useCallback(async () => {
    try {
      const raw = await api.status();
      setStatus(parseSessionStatus(raw));
      setStatusError(null);
    } catch (err) {
      // A status we cannot read is not the same as no session. Saying "no
      // session" here would invite the user to create a second one and lose
      // the first.
      setStatusError(
        err instanceof ApiError
          ? `The session state could not be read (${err.status}).`
          : "The session state could not be read.",
      );
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    void refreshStatus();
  }, [ready, refreshStatus]);

  // --- live updates ---------------------------------------------------------
  //
  // The stream is opened once a session exists. It carries the notebook list,
  // the export state and the signed-in flag, so polling is not needed and a
  // long export survives a reconnect via the server's ring buffer.
  const sessionExists = status?.authenticated === true;

  const onStreamEvent = useCallback(
    ({ event, data }: { event: string; data: unknown }) => {
      switch (event) {
        // A notebook listing completed. Merging rather than replacing keeps a
        // concurrent export state intact.
        case "notebooks-listed":
          setStatus((prev) =>
            prev
              ? {
                  ...prev,
                  notebooks: parseNotebooks(data),
                  matched: { ...prev.matched, notebooks: "notebooks" },
                }
              : prev,
          );
          break;

        case "export-started":
        case "export-progress":
          setStatus((prev) =>
            prev
              ? {
                  ...prev,
                  export: parseExport(data) ?? prev.export,
                }
              : prev,
          );
          break;

        case "export-ended":
          setStatus((prev) =>
            prev
              ? {
                  ...prev,
                  // The terminal payload carries the outcome. Clearing to
                  // undefined would discard `failed` and show the chooser
                  // again as though nothing had gone wrong.
                  export: parseExport(data) ?? undefined,
                }
              : prev,
          );
          void refreshStatus();
          break;

        case "signed-in":
          setStatus((prev) => (prev ? { ...prev, signedIn: true } : prev));
          break;

        case "session-ended":
          setStatus(null);
          setView("consent");
          break;

        default:
          // An event we do not model is not a reason to tear anything down.
          break;
      }
    },
    [refreshStatus],
  );

  const stream = useEventStream(sessionExists, onStreamEvent);

  // --- view selection -------------------------------------------------------
  //
  // Derived rather than stored, so it cannot drift out of step with the
  // snapshot. `view` is only ever forced to `create` by the user, or back to
  // `consent` by an erase.
  useEffect(() => {
    if (!status) return;
    if (!status.authenticated) {
      setView((v) => (v === "export" ? "export" : v));
      return;
    }
    if (!status.signedIn) {
      setView((v) => (v === "consent" ? "credential" : v));
      return;
    }
    setView("export");
  }, [status]);

  const onErase = useCallback(async () => {
    try {
      await api.erase();
    } finally {
      // The local view resets even if the server call failed. Leaving a
      // credential form on screen after the user asked to erase is the worse
      // of the two.
      setStatus(null);
      setView("consent");
      await refreshStatus();
    }
  }, [refreshStatus]);

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
        <main className="shell">
          <header>
            <h1>OneNote Exporter</h1>
            <p className="fineprint">Backend protocol {EXPECTED_PROTOCOL} confirmed.</p>
          </header>

          {statusError && (
            <p className="error" role="alert">
              {statusError}
            </p>
          )}

          {view === "consent" && (
            <Consent
              onStarted={() => {
                setView("credential");
                void refreshStatus();
              }}
            />
          )}

          {/*
            There is no separate "create" view. Session creation is rendered by
            `Consent`, directly beneath the disclosure the user has to read
            before they are anywhere near a password field. The earlier
            `view === "create"` branch was unreachable — nothing ever set it —
            so there was never a path that showed the form without the consent
            text above it.
          */}
          {view === "credential" && (
            <Credential
              onSubmitted={() => {
                setView("export");
                void refreshStatus();
              }}
              submit={(password) => api.submitCredential(password)}
            />
          )}

          {view === "export" && status && (
            <NotebookPicker
              notebooks={status.notebooks}
              signedIn={status.signedIn}
              export={status.export}
              streamState={stream.state}
              onList={() => {
                void api.listNotebooks();
              }}
              onStart={(notebook) => {
                void api.startExport(notebook).then(
                  ({ exportId }) => {
                    // Optimistic: the stream's export-started event will
                    // confirm, but showing the card immediately beats leaving
                    // the button live and risking a second POST.
                    setStatus((prev) =>
                      prev
                        ? {
                            ...prev,
                            export: {
                              exportId,
                              notebook,
                              state: "queued",
                            },
                          }
                        : prev,
                    );
                  },
                  () => {
                    /* 409 or otherwise: the stream will report the truth. */
                  },
                );
              }}
              onAbort={(exportId) => {
                void api.abort(exportId);
              }}
            />
          )}

          {status?.authenticated && (
            <footer>
              <button type="button" onClick={() => void onErase()}>
                Erase this session
              </button>
              <p className="fineprint">
                Removes the stored session and expires the cookie in both places.
              </p>
            </footer>
          )}
        </main>
      );
  }
}

function readStringArray(data: unknown, key: string): string[] {
  if (typeof data !== "object" || data === null) return [];
  const value = (data as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((n: unknown): n is string => typeof n === "string");
}

/**
 * Parse a `notebooks-listed` SSE payload.
 *
 * Defaults `state` to `loaded` because the event *is* the completed listing —
 * a payload with items but no state is a listing, not an idle server. Getting
 * this backwards would drop the user's notebooks into the "unrecognised state,
 * version problem" branch, which is a false alarm on the one screen where a
 * false alarm is most annoying.
 */
function parseNotebooks(data: unknown): NotebookList {
  if (typeof data !== "object" || data === null) {
    return { state: "loaded", items: [] };
  }
  const raw = data as Record<string, unknown>;
  return {
    state: typeof raw.state === "string" ? raw.state : "loaded",
    items: readStringArray(raw, "items"),
    error: typeof raw.error === "string" ? raw.error : undefined,
  };
}