import { useCallback, useEffect, useState } from "react";
import { ApiError, ProtocolMismatchError, api, assertProtocol } from "./lib/api";
import { EXPECTED_PROTOCOL } from "./lib/protocol";
import {
  parseSessionStatus,
  type NotebookList,
  type RunningExport,
  type SessionStatus,
} from "./lib/session";
import { parseChallenge, type Challenge } from "./lib/events-contract";
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
  const [challenge, setChallenge] = useState<Challenge | null>(null);
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
      const parsed = parseSessionStatus(await api.status());
      if (!parsed.ok) {
        // Surfaced, not absorbed. The previous parser defaulted every missing
        // field, so a total mismatch rendered a page that looked entirely normal
        // while showing no session and no export -- the quietest possible
        // failure, and one nobody reports.
        setStatus(null);
        setStatusError(
          `This page cannot read the session the service returned (${parsed.problems.join(
            "; ",
          )}). That is a version mismatch, not something to retry.`,
        );
        return;
      }
      setStatus(parsed.value);
      setStatusError(null);
    } catch (err) {
      // A 401 is an *answer*, not a failure: the service has told us this visitor
      // has no session, which is the expected state for anyone who has not
      // started one. Showing an error for it put a red alert on the landing page
      // of every first-time visitor, found by loading the real deployed site.
      //
      // The reasoning that used to live here — "a status we cannot read is not
      // the same as no session, so do not claim there is no session" — is
      // correct for a 5xx and wrong for a 401. A 500 genuinely leaves the
      // question open, and claiming "no session" there could cost a user their
      // existing session. Reading it correctly twice in one place is not the
      // same as reading it once correctly.
      if (err instanceof ApiError && err.status === 401) {
        setStatus(null);
        setStatusError(null);
        return;
      }
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

  /**
   * The CSRF token, taken from the snapshot.
   *
   * `status.csrfToken` is the single source: it is set from the session-creation
   * response and then re-read on every load, so a refresh recovers it without a
   * second round trip.
   *
   * The `?? ""` at the call sites below is a deliberate last resort that should
   * never be reached, and `missingToken` is what makes it visible if it is. An
   * empty header produces a bare `forbidden` from the backend, which is exactly
   * the failure mode this change exists to remove — so it gets a named cause
   * rather than a silent empty string.
   */
  const csrfToken = status?.csrfToken ?? null;
  const missingToken = status?.hasSession === true && csrfToken === null;

  // --- live updates ---------------------------------------------------------
  //
  // The stream is opened once a session exists. It carries the notebook list,
  // the export state and the signed-in flag, so polling is not needed and a
  // long export survives a reconnect via the server's ring buffer.
  const sessionExists = status?.hasSession === true;

  const onStreamEvent = useCallback(
    ({ event, data }: { event: string; data: unknown }) => {
      switch (event) {
        // A notebook listing completed. Merging rather than replacing keeps a
        // concurrent export state intact.
        case "notebooks-listed":
          setStatus((prev) =>
            prev
              ? { ...prev, notebooks: parseNotebooks(data) }
              : prev,
          );
          break;

        case "export-queued":
        case "export-started":
        case "export-progress":
        case "export-done":
        case "export-partial":
        case "export-aborted":
          // Terminal events included, deliberately. The outcome lives in the
          // *event name* -- there is no `export-ended` -- and the payload
          // carries counts rather than a whole export. The snapshot is the
          // authority for shape, so re-reading it is what makes the card correct
          // rather than approximately correct.
          void refreshStatus();
          break;

        case "login-success":
          // The credential was accepted. The status read that follows is what
          // moves the view; nothing is inferred from the event itself.
          void refreshStatus();
          break;

        case "login-failed":
        case "auth-expired":
          // `expired` and `failed` are rendered identically on purpose. A
          // Microsoft-side cookie invalidation and a crashed OneNote tab produce
          // the same observable error, so the client cannot honestly tell them
          // apart -- and guessing would be worse than saying "sign in again".
          setStatus((prev) =>
            prev ? { ...prev, signedIn: false, authState: "expired" } : prev,
          );
          void refreshStatus();
          break;

        case "challenge":
          // An outstanding MFA prompt. Surfaced rather than dropped: the
          // alternative is a user staring at a spinner during a sign-in that is
          // waiting on them, which reads as a hung app.
          setChallenge(parseChallenge(data));
          break;

        case "challenge-expired":
          setChallenge(null);
          break;

        case "session-status":
        case "auth-state":
        case "snapshot":
          // These carry a whole snapshot. `refreshStatus` obtains the same
          // payload from the REST route, so there is one parser rather than two.
          void refreshStatus();
          break;
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
    if (!status.hasSession) {
      setChallenge(null);
      setView("consent");
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
      await api.erase(csrfToken ?? "");
    } finally {
      // The local view resets even if the server call failed. Leaving a
      // credential form on screen after the user asked to erase is the worse
      // of the two.
      setStatus(null);
      setView("consent");
      await refreshStatus();
    }
  }, [refreshStatus, csrfToken]);

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

          {missingToken && (
            <p className="error" role="alert">
              This session is missing its security token, so nothing can be
              submitted. This is a version mismatch between the page and the
              service, not something you can retry — reload once, and if it
              persists please report it.
            </p>
          )}

          {/*
            An outstanding MFA prompt. Previously absent entirely — `challenge` was
            an event name I had never heard of, so a user waiting on their phone
            for an approval saw a spinner with no explanation. The expiry comes
            from this event and not from `auth.state`, which is what the api is
            explicit about: an auth state has no deadline to count down from.
          */}
          {challenge && view !== "credential" && (
            <section className="notice" role="status" aria-live="polite">
              <p>
                <strong>Your account needs another check.</strong>{" "}
                {challenge.kind
                  ? `Finish it in the Microsoft sign-in window: ${challenge.kind}.`
                  : "Finish it in the Microsoft sign-in window."}
              </p>
              <p className="fineprint">
                This page cannot approve it for you, and the request expires on its
                own. Leave this tab open until it does.
              </p>
            </section>
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
          {/* Without a token every mutating call below would be refused with a bare
              `forbidden`, so the pages are withheld rather than offered and
              then broken. */}
          {view === "credential" && !missingToken && (
            <Credential
              onSubmitted={() => {
                setView("export");
                void refreshStatus();
              }}
              submit={(password) =>
                api.submitCredential(password, csrfToken ?? "")
              }
            />
          )}

          {view === "export" && status && (
            <NotebookPicker
              notebooks={status.notebooks}
              signedIn={status.signedIn}
              export={status.export}
              streamState={stream.state}
              onList={() => {
                void api.listNotebooks(csrfToken ?? "");
              }}
              onStart={(notebook) => {
                void api.startExport(notebook, csrfToken ?? "").then(
                  ({ exportId }) => {
                    // Optimistic: the stream's export-started event will
                    // confirm, but showing the card immediately beats leaving
                    // the button live and risking a second POST.
                    setStatus((prev) =>
                      prev
                        ? {
                            ...prev,
                            export: {
                              id: exportId,
                              notebook,
                              state: "queued",
                              progress: null,
                              partialReason: null,
                              error: null,
                              downloadUrl: null,
                              fileName: null,
                              artifactPartial: false,
                            } satisfies RunningExport,
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
                void api.abort(exportId, csrfToken ?? "");
              }}
            />
          )}

          {status?.hasSession && (
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
/**
 * Parse a `notebooks-listed` SSE payload.
 *
 * Defaults `state` to `loaded` because the event *is* the completed listing — a
 * payload with items but no state is a listing, not an idle server. Getting this
 * backwards would drop the user's notebooks into a wrong branch, which is a false
 * alarm on the one screen where a false alarm is most annoying.
 *
 * An unrecognised state is mapped to `failed` rather than passed through: the
 * union is closed and transcribed from the api, so a value outside it is a
 * mismatch, and showing the listing as failed is the honest reading where
 * showing an empty chooser would not be.
 */
function parseNotebooks(data: unknown): NotebookList {
  if (typeof data !== "object" || data === null) {
    return { state: "loaded", items: [] };
  }
  const raw = data as Record<string, unknown>;
  const state = raw.state;
  return {
    state:
      state === "idle" || state === "listing" || state === "loaded" || state === "failed"
        ? state
        : "loaded",
    items: readStringArray(raw, "items"),
  };
}
