import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, ProtocolMismatchError, api, assertProtocol } from "./lib/api";
import { EXPECTED_PROTOCOL } from "./lib/protocol";
import { FRONTEND_VERSION } from "./lib/version";
import {
  parseSessionStatus,
  reconcileNotebooks,
  type NotebookList,
  type RunningExport,
  type SessionStatus,
} from "./lib/session";
import { isPhoneApproval, parseChallenge, type Challenge } from "./lib/events-contract";
import { describeFailure } from "./lib/failures";
import { parseNotebooks, readAuthState } from "./lib/notebooks-event";
import { useEventStream } from "./lib/useEventStream";
import { Consent } from "./pages/Consent";
import { ChallengeAnswer } from "./pages/ChallengeAnswer";
import { Credential } from "./pages/Credential";
import { NotebookPicker, type LogLine } from "./pages/NotebookPicker";

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

/**
 * How many lines the block keeps.
 *
 * A listing is tens of seconds of progress and an export is tens of thousands of
 * lines, and this is a view for *watching*, not an archive: 500 lines is more
 * than the block can show, and the oldest go first so that what stays is what is
 * happening now. Nothing is dropped silently — `LogView.dropped` says how many,
 * and the view prints it — because a silently truncated block is the same
 * "everything looks fine" shape as the export card that used to say "written"
 * over a vault that was missing a page.
 */
const MAX_LOG_LINES = 500;

/**
 * How many frame ids the replay-dedupe set keeps.
 *
 * Derived, not picked: the api's SSE ring buffer is 500 events
 * (`api/src/config.ts`'s `sseBufferEvents`), and a reconnect replays from
 * `Last-Event-ID` — so a duplicate can only ever arrive from within that window.
 * Twice it is headroom; anything older cannot return because the ids are
 * monotonic within a session. The bound is what stops the set outliving every
 * line it guards, which on a long export is the difference between a fixed few
 * kilobytes and a slow leak for the session's life.
 */
const MAX_SEEN_FRAME_IDS = 1000;

/** The block: the lines kept, and how many the cap has taken off the top. */
interface LogView {
  lines: LogLine[];
  dropped: number;
}

export function App() {
  const [boot, setBoot] = useState<Boot>({ phase: "checking" });
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [view, setView] = useState<View>("consent");

  /**
   * The outcome of the last failed mutating call, or null.
   *
   * Separate from `statusError`, which means "the snapshot could not be read".
   * Merging them would be wrong in both directions: a snapshot read recovers on
   * its own, whereas this message is about an action the user just took and only
   * the next attempt clears it.
   */
  const [actionError, setActionError] = useState<string | null>(null);

  /**
   * True between asking for a listing and the request settling.
   *
   * A second click while the first POST is in flight is the compounding case: the
   * backend answers `503 busy`, so the second click cannot help and turns a
   * working button into a refusal. The listing itself takes tens of seconds, so
   * this window is long enough to be hit by accident.
   */
  const [listingPending, setListingPending] = useState(false);

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
  //
  // `notebooksSeq` counts revisions of the notebook list and `listingRef` records
  // that a listing is running. Neither is React state: both are read *inside* a
  // callback that must not re-create itself, and a re-created `refreshStatus`
  // would re-fire every effect that depends on it. The revision is read at the
  // moment the request goes out and again when it resolves — that difference is
  // the whole staleness test, and it is documented in `reconcileNotebooks`.
  const notebooksSeq = useRef(0);
  const listingRef = useRef(false);

  /**
   * The generation of the session this page's view state belongs to.
   *
   * Bumped at every session boundary, and read by `refreshStatus` to know
   * whether the answer it is holding is still about the session this page is
   * showing. Without it, a refresh that was in flight when the boundary
   * happened resolves afterwards and replaces the **new** session's snapshot
   * with the old one's — the same class of leak as the log block, one layer
   * down and quieter.
   */
  const sessionEpoch = useRef(0);

  /**
   * Forget everything that belonged to the previous session.
   *
   * The log block, the frame-id set, the listing flag, the outstanding
   * challenge, the last action error and the snapshot itself are all
   * **properties of one session**. They must not outlive it, and a new
   * session's frames must not be mistaken for the old session's replays.
   *
   * `seenFrameIds` is declared further down, with the log block it belongs to;
   * the reference is safe because this runs after the render that declared it.
   */
  const resetSessionState = useCallback(() => {
    sessionEpoch.current += 1;
    setLog({ lines: [], dropped: 0 });
    seenFrameIds.current.clear();
    listingRef.current = false;
    setChallenge(null);
    setActionError(null);
    setStatus(null);
    setStatusError(null);
  }, []);

  /**
   * Install the notebook list locally, counting the revision.
   *
   * Every write to `notebooks` goes through here. A write that bypasses it does
   * not increment the counter, and a refresh in flight at the time cannot tell
   * its own snapshot was overtaken — which is the failure this whole mechanism
   * exists to prevent, reintroduced through a second code path.
   */
  const setNotebooks = useCallback((notebooks: NotebookList) => {
    notebooksSeq.current += 1;
    setStatus((prev) => (prev ? { ...prev, notebooks } : prev));
  }, []);

  // --- live updates ---------------------------------------------------------
  //
  // The stream is opened once a session exists. It carries the notebook list,
  // the export state and the signed-in flag, so polling is not needed and a
  // long export survives a reconnect via the server's ring buffer.
  const sessionExists = status?.hasSession === true;

  const refreshStatus = useCallback(async () => {
    // Read *before* the await: this is what the request is about to be asked.
    const seqAtRequest = notebooksSeq.current;
    // The same, for the session generation. A response that arrives after the
    // session changed is about a session this page is no longer showing.
    const epochAtRequest = sessionEpoch.current;
    try {
      const parsed = parseSessionStatus(await api.status());
      if (epochAtRequest !== sessionEpoch.current) return;
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
      // A replace, with one exception: `notebooks` is reconciled rather than
      // overwritten. See `reconcileNotebooks` — a refresh must not replace a
      // field it does not know more about.
      setStatus((prev) =>
        prev
          ? {
              ...parsed.value,
              notebooks: reconcileNotebooks({
                current: prev.notebooks,
                incoming: parsed.value.notebooks,
                seqAtRequest,
                seqNow: notebooksSeq.current,
                listingInFlight: listingRef.current,
              }),
            }
          : parsed.value,
      );
      // The snapshot is the authority on whether a listing is still running, so
      // it is what clears the flag — not the local belief, which is only ever
      // right about the listing this tab asked for.
      if (parsed.value.notebooks.state !== "listing") listingRef.current = false;
      setStatusError(null);
    } catch (err) {
      // The same guard as above, for the failure path: a 401 for a session that
      // is no longer this page's must not reset the session that is.
      if (epochAtRequest !== sessionEpoch.current) return;
      // A 401 is an *answer*, not a failure: the service has told us this visitor
      // has no session, which is the expected state for anyone who has not
      // started one. Showing an error for it put a red alert on the landing page
      // of every first-time visitor, found by loading the real deployed site.
      //
      // It is also **the session boundary**, and the most reliable one. The api
      // announces a session's death with a `session-status` frame — and that
      // announcement is what triggers the refresh which observes the 401 here.
      // A tab that did not press Erase learns about it the same way.
      //
      // The reasoning that used to live here — "a status we cannot read is not
      // the same as no session, so do not claim there is no session" — is
      // correct for a 5xx and wrong for a 401. A 500 genuinely leaves the
      // question open, and claiming "no session" there could cost a user their
      // existing session. Reading it correctly twice in one place is not the
      // same as reading it once correctly.
      if (err instanceof ApiError && err.status === 401) {
        resetSessionState();
        return;
      }
      setStatusError(
        err instanceof ApiError
          ? `The session state could not be read (${err.status}).`
          : "The session state could not be read.",
      );
    }
  }, [resetSessionState]);

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

  // --- the runner's own output -----------------------------------------------
  //
  // Event-only state, and the reason is the one this file has already paid for
  // once: `refreshStatus` must never touch it. A refresh happens for reasons that
  // have nothing to do with the listing or the export — a `session-status` frame,
  // a reconnect, the read that follows a mutation — and the snapshot it returns
  // carries no log lines at all. A block rebuilt from the snapshot would therefore
  // be empty after every refresh, which is precisely the silence frontend #33
  // exists to remove: thirty seconds of a listing rendering nothing. So nothing
  // in the block below reads `status`, and `refreshStatus` above writes none of it.
  const [log, setLog] = useState<LogView>({ lines: [], dropped: 0 });

  /**
   * Frame ids already appended, so a frame delivered twice is shown once.
   *
   * Keyed on the frame's own SSE `id:` — the api hub's monotonic counter for the
   * life of the session (`SessionHub.nextId`, `api/src/sse.ts:109`) — and never on
   * the payload's `id`. On `export-log` that payload field is the **export** id:
   * the same value on every line of one run, so a set of payload ids would keep
   * the first line and silently throw the rest of the export's output away.
   *
   * A duplicate is an ordinary event, not an error. The runner replays its ring
   * from the pump's `since` cursor on every reconnect
   * (`runner/src/index.ts:232`), so a line the user has already seen can arrive
   * a second time, and a block that printed it twice reads as the work having
   * happened twice.
   *
   * **The set is cleared when a new session starts.** The api's frame ids are
   * monotonic **within** a session, and a new session's hub restarts at 1. An id
   * from a previous session therefore arrives as a "foreign" id and gets a fresh
   * entry in this set.
   */
  const seenFrameIds = useRef(new Set<string>());

  const appendLogLine = useCallback((frameId: string, text: string, level: string) => {
    // An empty id cannot be a key: every frame would be a duplicate of the first
    // one and the block would hold exactly one line forever. A frame without an
    // `id:` is kept and not deduplicated, which is the honest reading — it is
    // this client that cannot identify it, not proof that it is a replay.
    if (frameId !== "") {
      if (seenFrameIds.current.has(frameId)) return;
      seenFrameIds.current.add(frameId);
      // Bounded, because the set outlives every line it guards. Ids are monotonic
      // **within** a session, and a new session's hub restarts at 1. An id from
      // a previous session therefore arrives fresh and must not be in the dedupe
      // set. A replay is bounded by the api's ring buffer — `sseBufferEvents: 500`
      // frames, configurable in `api/src/config.ts`. Keeping twice that is
      // headroom, and evicting the oldest is safe because a Set iterates in
      // insertion order and the oldest id is the one furthest beyond any replay.
      // The cost of the bound being wrong is one line shown twice; the cost of
      // having no bound is a set that grows for the life of the session.
      while (seenFrameIds.current.size > MAX_SEEN_FRAME_IDS) {
        const oldest = seenFrameIds.current.values().next().value;
        if (oldest === undefined) break;
        seenFrameIds.current.delete(oldest);
      }
    }
    setLog((prev) => {
      const lines = [...prev.lines, { id: frameId, text, level }];
      if (lines.length <= MAX_LOG_LINES) return { lines, dropped: prev.dropped };
      const overflow = lines.length - MAX_LOG_LINES;
      return { lines: lines.slice(overflow), dropped: prev.dropped + overflow };
    });
  }, []);

  /**
   * A fresh block for a fresh run, which is what a terminal does when you start
   * a new command.
   *
   * `seenFrameIds` is cleared with it when a new session starts. The api's frame
   * ids are monotonic **within** a session, and a new session's hub restarts at
   * 1. An id from a previous session therefore arrives fresh and must not be in
   * the dedupe set.
   */
  const clearLog = useCallback(() => {
    setLog({ lines: [], dropped: 0 });
  }, []);

  const onStreamEvent = useCallback(
    ({ id, event, data }: { id: string; event: string; data: unknown }) => {
      switch (event) {
        // A notebook listing completed. Merging rather than replacing keeps a
        // concurrent export state intact.
        case "notebooks-listed":
          // The completed listing. Merged through `setNotebooks` so the revision
          // advances — which is what tells any refresh already in flight that its
          // snapshot predates this answer.
          setListingPending(false);
          listingRef.current = false;
          setNotebooks(parseNotebooks(data));
          break;

        // A listing that never completes. The api translates the runner's
        // `notebooks-failed` into this event, so it is the only signal that a
        // request accepted with 202 has ended without a result — and without
        // clearing the pending state the button would stay disabled forever with
        // no explanation.
        case "error":
          setListingPending(false);
          listingRef.current = false;
          break;

        case "export-queued":
          // A fresh block, before the refresh. The lines above the chooser belong
          // to the run that is starting now, and a reader who has the previous
          // export's output still on screen cannot tell where this one begins —
          // the absence of a gap is the whole reason a terminal clears its screen
          // on a new command.
          clearLog();
          void refreshStatus();
          break;

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

        case "export-log": {
          // This event has been arriving for the whole life of the product with no
          // case reading it: `EVENT_TYPES` carried the name, the transport
          // registered a listener for it, and nothing consumed it. An export ran
          // for tens of thousands of lines and the page showed a progress sentence.
          const line = logText(data, "line");
          if (line === null) break;
          // INFO because the frame says nothing else. `export-log`'s payload is
          // `{id, line}` — `{id}` being the export's, per `publish()` in the api's
          // `runner-adapter-http.ts` — and there is no level on it to forward. The
          // alternative, leaving the level unset, renders a line whose severity
          // the view has to guess at.
          appendLogLine(id, line, "INFO");
          break;
        }

        case "listing-log": {
          // `{line, level}` verbatim, as the api's `publish()` re-emits it, so
          // the level is the package's and not this page's judgement. That is the
          // point of the field: both warnings this listing can emit are ones it
          // continues past anyway, and without the level the frame says nothing
          // the reader could act on.
          const line = logText(data, "line");
          if (line === null) break;
          appendLogLine(id, line, logText(data, "level") ?? "INFO");
          break;
        }

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

        case "challenge-seen":
          // The prompt is answered — by this tab, or by another one sharing the
          // session. Dropping it is what stops a second tab sitting on an input for a
          // code that has already been used.
          //
          // **It says accepted, not correct.** Only the login can know whether the
          // code was the right one, and it says so on this same stream — as
          // `login-failed`, or `login-success`. So this does not touch the view: a
          // wrong code still has to come back as a failure rather than as silence.
          setChallenge(null);
          break;

        case "auth-state":
          // The api emits `auth-state: {state: "authenticating"}` immediately
          // before it starts a listing. Recorded rather than merely refreshed,
          // because it is the earliest signal that the snapshot's `notebooks` is
          // about to be wrong — and it arrives *before* the POST is even
          // answered, so it covers the window the POST response does not.
          if (readAuthState(data) === "authenticating") {
            listingRef.current = true;
          }
          void refreshStatus();
          break;

        case "session-status":
        case "snapshot":
          // These carry a whole snapshot. `refreshStatus` obtains the same
          // payload from the REST route, so there is one parser rather than two.
          void refreshStatus();
          break;

        default:
          // An event we do not model is not a reason to tear anything down.
          break;
      }
    },
    [refreshStatus, appendLogLine, clearLog],
  );

  // --- live updates ---------------------------------------------------------
  //
  // The stream is opened once a session exists. It carries the notebook list,
  // the export state and the signed-in flag, so polling is not needed and a
  // long export survives a reconnect via the server's ring buffer.
  const stream = useEventStream(sessionExists, onStreamEvent);

  /**
   * Refresh the snapshot when the SSE stream reconnects.
   *
   * A stream that dies and comes back (drop, network change, api restart)
   * enters the "replaying" state to catch up. A new session's hub restarts at
   * id 1, so any previous `Last-Event-ID` is foreign and the api sends a
   * snapshot. This hook triggers a `refreshStatus` on that reconnect so the
   * view sees a refreshed snapshot. A 200 response leaves everything untouched;
   * a 401 resets the per-session state.
   *
   * This is a *recovery* path: a stream that dies cannot strand a tab. The
   * refresh is not a reset: only a 401 empties the log block.
   */
  useEffect(() => {
    if (!ready) return;
    if (sessionExists && stream.state === "replaying") {
      void refreshStatus();
    }
  }, [ready, sessionExists, stream.state, refreshStatus]);

  // --- view selection -------------------------------------------------------
  //
  // Derived rather than stored, so it cannot drift out of step with the
  // snapshot. `view` is only ever forced to `create` by the user, or back to
  // `consent` by an erase.
  useEffect(() => {
    if (!status) {
      // The session is gone — erased, expired, or swept. The consent view is the
      // only thing left, and the only way to start again.
      setView("consent");
      return;
    }
    if (status.sessionState === "erasing") {
      // Being erased. Stay where you are: the erase's response is still in
      // flight, and it expires the cookie. A session created now would have
      // its cookie killed when that response lands, and the user would be left
      // with a session that exists and cannot be used.
      return;
    }
    if (!status.hasSession) {
      setChallenge(null);
      setView("consent");
      return;
    }
    if (status.authState === "authenticating") {
      // A reload mid-sign-in must land on the export view, where the signing-in
      // notice renders, rather than on the credential form — which is what a
      // fresh mount's "consent" default would otherwise produce. See #44.
      setView("export");
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
    } catch {
      // A failed erase is swallowed, and that is a decision rather than an
      // oversight.
      //
      // The session row is deleted and the cookie expired whether the server
      // managed the container or not — the api expires the cookie in both
      // branches, and the machine deletes the row last either way. So from the
      // user's side the session **was** erased, and what is left over is
      // server-side data the api has already logged. A visible message would
      // say "the erase failed" about an erase that succeeded, which is the
      // worse of the two.
      //
      // It is caught rather than left to escape: `api.erase` rejects on a
      // non-2xx, and this promise is fired with `void`, so an escaping
      // rejection would be an unhandled promise rejection in the console for
      // every erase of a session that never signed in.
    } finally {
      // The local view resets even if the server call failed. Leaving a
      // credential form on screen after the user asked to erase is the worse
      // of the two.
      resetSessionState();
      setView("consent");
      await refreshStatus();
    }
  }, [resetSessionState, refreshStatus, csrfToken]);

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
            {/* Both versions, and both from a different place than each other.
                `boot.build` came from the handshake, which is the only component
                that knows what the backend is running — it was fetched, held in
                state and never rendered. A version-skew report that carried only
                the protocol number carried nothing to compare against, so the
                number to compare had to be fetched and thrown away. */}
            <p className="fineprint" data-testid="versions">
              Frontend {FRONTEND_VERSION} · backend {boot.build}
            </p>
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

            ## The number is the actionable part, and it is shown

            The old copy said "finish it in the Microsoft sign-in window". **There
            is no such window here.** The login runs headlessly in a container on
            the server, so nothing renders on this page for the user to switch to.
            For a push-approval challenge the only thing that helps is the number
            they match against the one in their Authenticator app.

            `parseChallenge` used to read `{id, kind, expiresAt}` while the api
            sends `{kind, label, number, expiresAt}`, so the number arrived as
            nothing and this notice was advice the user could not act on.

            ## A `code` challenge gets an input, not a notice

            **This notice is the whole of what a typed code used to be given**, and
            the code they were holding was never asked for: the notice said "follow
            the prompt on your phone", the api answered the challenge with
            `login-failed {reason: "challenge-not-supported"}`, and an account with
            a perfectly good password was told it did not work.

            So a `code` challenge renders `ChallengeAnswer` above instead — an input,
            a countdown from the challenge's own expiry, and the submit that reaches
            `POST /api/session/challenge/answer`. A phone-approval challenge keeps
            this notice, because there is nothing to type: the user acts on their own
            device and the only thing this page owes them is the number.
          */}
          {challenge &&
            view !== "credential" &&
            (challenge.kind === "code" ? (
              <ChallengeAnswer
                challenge={challenge}
                submit={(code) => api.answerChallenge(code, csrfToken ?? "")}
                onAnswered={() => setChallenge(null)}
              />
            ) : (
              <section className="notice" role="status" aria-live="polite">
                <p>
                  <strong>Your account needs another check.</strong>{" "}
                  {isPhoneApproval(challenge) ? (
                    <>
                      Approve the prompt in your phone, and check it matches this
                      number:
                    </>
                  ) : challenge.label ? (
                    challenge.label
                  ) : (
                    "Follow the prompt on your phone to finish signing in."
                  )}
                </p>
                {isPhoneApproval(challenge) && (
                  // The digits as printed. Rendered verbatim and never reformatted,
                  // because the user is comparing them by eye against their phone.
                  <p className="mfa-number" aria-label="number to match">
                    {challenge.number}
                  </p>
                )}
                <p className="fineprint">
                  This page cannot approve it for you, and the request expires on its
                  own. Leave this tab open until it does.
                </p>
              </section>
            ))}

          {view === "consent" && (
            <Consent
              onStarted={() => {
                // A new session exists, so everything that belonged to the old
                // one is stale — including the log block, which would otherwise
                // greet the new session with the old one's output.
                resetSessionState();
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
              submit={(account, password) =>
                api.submitCredential(account, password, csrfToken ?? "")
              }
            />
          )}

          {view === "export" && status && (
            <NotebookPicker
              notebooks={status.notebooks}
              signedIn={status.signedIn}
              authState={status.authState}
              challengeActive={challenge !== null}
              export={status.export}
              streamState={stream.state}
              // One slot for the message, cleared on the next attempt rather
              // than on any refresh: a refresh is not the user retrying, and
              // silently dropping the explanation would leave them with a button
              // that did nothing and no reason why.
              actionError={actionError}
              listingPending={listingPending}
              // Event-only, so it is passed separately from everything above:
              // nothing in the snapshot has a word to say about what the runner
              // printed, and merging it into `status` would put it exactly one
              // `setStatus` away from being wiped by the next refresh.
              logLines={log.lines}
              droppedLogLines={log.dropped}
              onList={() => {
                setActionError(null);
                setListingPending(true);
                // The block clears on the click rather than on the first
                // `listing-log` frame: a listing takes tens of seconds to produce
                // its first line, and a block holding the last run's output
                // through that silence reads as the new listing already having
                // produced it.
                clearLog();
                // Set before the request, not in its `.then`. The backend answers
                // 202 and then emits `session-status`, so the refresh that event
                // triggers is already in flight by the time the response is
                // handled — and setting the flag afterwards would be too late to
                // protect the request it caused.
                listingRef.current = true;
                // `.catch`, not `void`. The rejection was previously discarded,
                // so a failed listing produced an unhandled promise rejection
                // and no state change — nothing could be shown, because nothing
                // was ever set.
                void api
                  .listNotebooks(csrfToken ?? "")
                  .catch((err: unknown) => {
                    setListingPending(false);
                    // Cleared: nothing is running, and leaving it set would
                    // suppress every future empty snapshot for this session.
                    listingRef.current = false;
                    setActionError(describeFailure(err, "list"));
                  });
              }}
              onStart={(notebook) => {
                setActionError(null);
                void api
                  .startExport(notebook, csrfToken ?? "")
                  .then(({ exportId }) => {
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
                              // Nothing has run yet, so nothing can have been
                              // lost. Null rather than zeros for the same reason
                              // the parser uses: a zero would be a claim.
                              failed: null,
                              partialReason: null,
                              error: null,
                              downloadUrl: null,
                              fileName: null,
                              artifactPartial: false,
                            } satisfies RunningExport,
                          }
                        : prev,
                    );
                  })
                  .catch((err: unknown) => {
                    // Previously an empty rejection handler reading "the stream
                    // will report the truth". It usually would — but when the
                    // export never starts there is no event to come, and the
                    // button just sits there having done nothing.
                    setActionError(describeFailure(err, "start"));
                  });
              }}
              onAbort={(exportId) => {
                setActionError(null);
                void api.abort(exportId, csrfToken ?? "").catch((err: unknown) => {
                  setActionError(describeFailure(err, "abort"));
                });
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

// `parseNotebooks` and `readAuthState` now live in `lib/notebooks-event.ts`.
// They were private functions here, and both are decisions with failure modes
// worth asserting away from a component: an unrecognised state, a missing field,
// a payload that is not an object.

/**
 * One string field of a log frame, or null.
 *
 * Null for `""` as well as for a missing or non-string field, because an empty
 * line is not output: rendering one adds a blank row that the reader has to work
 * out is not a line, and the api drops an empty id for the same reason it does.
 *
 * The field names are transcribed from `publish()` in the api's
 * `runner-adapter-http.ts`: `listing-log` carries `{line, level}`, `export-log`
 * carries `{id, line}` and no level.
 */
function logText(data: unknown, key: string): string | null {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : null;
}
