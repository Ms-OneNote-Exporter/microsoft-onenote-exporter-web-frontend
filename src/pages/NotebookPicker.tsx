/**
 * The export page: choose a notebook, start the export, watch it, download it.
 *
 * The notebook list is the awkward part. Listing runs a CLI in the runner, so it
 * needs a trigger and the answer arrives asynchronously over SSE. That makes it
 * three states, not two — idle, listing, loaded — and a fourth for the failure
 * case. `notebookStatus()` in `session.ts` maps the server's raw `state` onto
 * those without assuming a closed union, so an unrecognised value shows as
 * "unknown" rather than as an empty chooser that looks like success.
 *
 * PLAN-v2 §9.2: names are clickable to fill the export block, greyed until the
 * credential has been accepted.
 */
import { useEffect, useRef, useState } from "react";
import type {
  ExportFailures,
  ExportProgress,
  ExportState,
  NotebookList,
  RunningExport,
} from "../lib/session";

/**
 * One line of the runner's own output.
 *
 * The shape is the frame's, not a rendering's: `level` is whatever the run said
 * (`listing-log` carries the package's level, `export-log` carries none), and
 * `id` is the frame's SSE id rather than anything in the payload — see the dedupe
 * in `App.tsx`, which is the only consumer of it.
 */
export interface LogLine {
  /** The frame's SSE `id:`. The replay key. Never rendered. */
  id: string;
  text: string;
  /** `INFO` unless the frame said otherwise. */
  level: string;
}

export interface NotebookPickerProps {
  notebooks: NotebookList;
  /** False until the credential has been accepted. */
  signedIn: boolean;
  export: RunningExport | null;
  streamState: "connecting" | "open" | "replaying" | "closed";
  /**
   * Why the last mutating call failed, or null.
   *
   * Rendered next to the button that was pressed, because a message on the far
   * side of the page is a message nobody connects to the click.
   */
  actionError: string | null;
  /**
   * A listing request is in flight.
   *
   * Not the same as `notebooks.state === "listing"`, which is the *snapshot's*
   * view and only catches up once a refresh lands. This is the local knowledge
   * that a POST is on the wire, which is what a second click would compound.
   */
  listingPending: boolean;
  /**
   * The runner's output, oldest first, or nothing.
   *
   * Optional rather than required, because the block is additive to a page whose
   * subject is the notebook chooser: a caller that has no stream has nothing to
   * pass and should not have to invent an empty array to satisfy a prop. The
   * default is the block's own empty state, which is what such a caller sees.
   */
  logLines?: LogLine[];
  /**
   * How many lines the cap took before these, or 0.
   *
   * Kept apart from `logLines` for the same reason the cap exists: the number the
   * user needs is the one they cannot see. `0` means nothing has been dropped,
   * which is the truth on every export short enough to fit.
   */
  droppedLogLines?: number;
  onList: () => void;
  onStart: (notebook: string) => void;
  onAbort: (exportId: string) => void;
}

export function NotebookPicker({
  notebooks,
  signedIn,
  export: running,
  streamState,
  actionError,
  listingPending,
  logLines = [],
  droppedLogLines = 0,
  onList,
  onStart,
  onAbort,
}: NotebookPickerProps) {
  const [selected, setSelected] = useState<string | null>(null);
  // A closed union transcribed from the api, so it is rendered directly rather
  // than normalised. The previous version mapped an unrecognised value to
  // `unknown`; that was a workaround for a guess, and the guess was wrong.
  const view = notebooks;

  // A **running** export wins over the chooser: during one there is nothing to
  // pick, and offering a second start is what produces a 409.
  //
  // The word is load-bearing. This used to read `if (running)`, which is true for
  // *every* export the snapshot knows about — including `done` — so a finished
  // export replaced the chooser too, and the user was left on a dead end: the
  // reference, the download link, and nothing to do with them.
  //
  // Observed on the deployed site, and it is what stopped the §0.8.1 re-proof:
  // a completed export could not be followed by a second one, so the only way
  // onward was to abandon the session and sign in again.
  //
  // The list needed for that second export is already here. It comes from the
  // snapshot's `notebooks`, which the api persists (bug #39), so re-listing
  // would claim a runner and spend ~20s in a container to return names the
  // client is already holding. **No "List my notebooks" button** for that reason.
  const inFlight = running !== null && !isTerminal(running.state);
  if (inFlight) {
    return (
      <>
        {/* Above the card, and in both branches, so the output keeps the same
            place on the page whether an export is running or not — a block that
            jumps when the view changes is a block nobody watches. */}
        <LogBlock lines={logLines} dropped={droppedLogLines} />
        <ExportProgress
          running={running}
          streamState={streamState}
          actionError={actionError}
          onAbort={onAbort}
        />
      </>
    );
  }

  return (
    <>
      <LogBlock lines={logLines} dropped={droppedLogLines} />

      {/* Kept above the chooser rather than replaced by it: the reference and the
          download link are the record of what just happened, and hiding them the
          moment a second export starts would lose them. */}
      {running && (
        <ExportProgress
          running={running}
          streamState={streamState}
          actionError={actionError}
          onAbort={onAbort}
        />
      )}

      <section className="card">
        <h2>Choose a notebook</h2>

        <p>
          Listing your notebooks runs a short listing command in the isolated
          container, so it takes a moment rather than appearing instantly.
        </p>

      {/*
        Disabled while the POST is on the wire as well as while the snapshot says
        `listing`. The two cover different windows: this one is the round trip,
        that one is the tens of seconds the listing then takes. A second click in
        either window earns a `503 busy` — the button refusing to be clicked
        twice is the whole fix for that half of the issue.

        And disabled while the session is not signed in, which was missing and is
        the case a user actually hits. The component already knew: `signedIn` gated
        the Export button two elements below, and the hint below that tells the
        reader to sign in first — but this button was live on a session with no
        Microsoft sign-in.

        The result was an action offered that could not succeed, answering with an
        error. Observed on the deployed site: signed in at 12:10:16, clicked at
        12:10:40, and got

            "Still signing in — the service is not ready to list notebooks yet.
             Try again in a moment."

        The backend was **right** — `auth.state` was `authenticating` and the login
        finished 24 seconds later. The message was accurate and the button was still
        a trap: it invited a click whose only possible outcome was a refusal, and
        made a normal part of signing in look like a failure.

        Not gated on `view.state` alone. The snapshot reports `auth.state`
        separately from `notebooks.state`, and the distinction is the whole thing:
        `notebooks.state === "idle"` is true both before signing in and after, so it
        cannot tell the user to wait.
      */}
      <button
        type="button"
        onClick={onList}
        disabled={!signedIn || listingPending || view.state === "listing"}
      >
        {!signedIn
          ? "Sign in to list"
          : listingPending
            ? "Asking the service…"
            : view.state === "listing"
              ? "Listing…"
              : "List my notebooks"}
      </button>

      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}

      <NotebookBody
        view={view}
        selected={selected}
        onSelect={setSelected}
        signedIn={signedIn}
      />

      <button
        type="button"
        disabled={!signedIn || !selected}
        onClick={() => {
          if (!selected) return;
          // Cleared as the export is handed off, not after it comes back. The
          // snapshot's `export` does not change until the POST resolves and a
          // refresh lands, so without this the button stays live and armed with
          // the notebook just exported — and a second click inside that window is
          // the `409` the guard at the top of this file exists to prevent.
          setSelected(null);
          onStart(selected);
        }}
      >
        Export {selected ? `“${selected}”` : ""}
      </button>

      {!signedIn && (
        <p className="fineprint">
          Exporting needs a signed-in session. Send your password on the
          previous step first.
        </p>
      )}
      </section>
    </>
  );
}

/**
 * Whether an export has finished, one way or another.
 *
 * `done`, `partial` and `failed` are all terminal: none of them will change again
 * on its own, so none of them justifies hiding the chooser. `partial` in
 * particular is not "stopped for now" — a user who stops an export will often
 * immediately want another, which is exactly what the chooser is for.
 *
 * `none` never arrives here: it is what a session with no export at all parses to,
 * and that is a null `running`, not a state.
 */
function isTerminal(state: ExportState): boolean {
  return state === "done" || state === "partial" || state === "failed";
}

/**
 * How far from the bottom still counts as "following the tail".
 *
 * A few pixels of slack, because browsers round `scrollTop` and `clientHeight` to
 * integers and a terminal that stops following because it was one pixel short
 * looks exactly like one that has lost the stream.
 */
const FOLLOW_SLACK_PX = 24;

/**
 * The block: what the runner printed, oldest at the top and newest at the bottom.
 *
 * ## Why it exists at all
 *
 * The listing's only terminal event is `notebooks-listed`, and it arrives after
 * the whole scrape — tens of seconds in which the page said nothing at all and a
 * user could not tell "working" from "stuck". Everything between the click and
 * that terminal is what this block shows.
 *
 * ## It follows the tail, but only while the reader has not taken over
 *
 * The convention every terminal has: a new line scrolls the view only if the
 * reader is already at the bottom. Someone who has scrolled up to read a warning
 * must not be dragged away by the next line, and the only way to know they did is
 * to have been watching.
 */
function LogBlock({ lines, dropped }: { lines: LogLine[]; dropped: number }) {
  const box = useRef<HTMLDivElement | null>(null);

  /**
   * Whether the view is pinned to the newest line.
   *
   * A ref and not state: it is written on every scroll event and read on every
   * append, and in state each of those would re-render a block holding up to 500
   * lines to change a boolean nothing renders.
   */
  const following = useRef(true);

  useEffect(() => {
    // A cleared block is a new run, and the new run starts following again: the
    // reader's position belonged to the previous listing.
    if (lines.length === 0) following.current = true;
    const el = box.current;
    if (el === null || !following.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const el = box.current;
    if (el === null) return;
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
  };

  return (
    <>
      {/*
        The bounded, scrolling box. `.notebooks` is the only rule in the
        stylesheet that provides one, and this change does not touch the
        stylesheet — which is not only tidiness: the page's policy is
        `style-src 'self'` with no `'unsafe-inline'`, so a `style` attribute is
        dropped by the browser outright and an inline-styled block would ship
        unstyled with nothing to say about it. The monospace comes from the
        `<pre>` inside, which is monospace without being told.
      */}
      <div
        className="notebooks"
        ref={box}
        onScroll={onScroll}
        // `role="log"` is the append-only pattern, so a screen reader is told
        // that new lines arrive here rather than only on navigation. It is
        // deliberately not `alert`: a listing that prints 500 lines must not
        // interrupt the reader 500 times.
        role="log"
        aria-label="Listing and export output"
        data-testid="log-block"
      >
        {lines.length === 0 ? (
          // Said rather than left blank. An empty box is indistinguishable from a
          // block that failed to render, and this whole component exists because
          // a silent page read as a stuck one.
          <p className="fineprint">Nothing has been logged yet.</p>
        ) : (
          // One text run, oldest first. `<pre>` preserves the newlines these
          // strings already carry, and rendering the marker *into the text* rather
          // than into an element is what makes it survive being copied out of the
          // page, printed in black and white, or read aloud — all three of which
          // lose a colour and two of which lose a border.
          <pre>{lines.map(renderLine).join("\n")}</pre>
        )}
      </div>

      {/* Outside the box, so it cannot scroll away: it is the one sentence that
          says the block above is not the whole of what was printed. */}
      {dropped > 0 && (
        <p className="fineprint" data-testid="log-dropped">
          Showing the last {lines.length} of {lines.length + dropped} lines.
        </p>
      )}
    </>
  );
}

/**
 * One rendered line: the marker, the level, then the text.
 *
 * **The severity is text, never colour** — and there is no colour here at all, so
 * the question does not arise. The glyph is what a reader scanning a fast block
 * finds, and the level word beside it is what still says what happened once the
 * block is copied, printed, or read by something that cannot see.
 *
 * The level is compared case-insensitively, and deliberately so: the package's
 * logger hands its sink the uppercase tag it formatted with (`'WARN'` into
 * `_formatMessage`), while the api's own fixture for this frame writes `"warn"`,
 * and `publish()` forwards the value verbatim. The page cannot know which
 * spelling a given run used, and a marker that fires on only one of them is a
 * marker that fails exactly when there is a warning to mark.
 *
 * An unrecognised level is shown as it arrived rather than folded into INFO: a
 * level this build has never seen is a fact about the run, and calling it INFO
 * would state something false about it.
 */
function renderLine(line: LogLine): string {
  const level = line.level.toUpperCase();
  if (level === "INFO") return line.text;
  if (level === "WARN") return `! WARN: ${line.text}`;
  if (level === "ERROR") return `× ERROR: ${line.text}`;
  return `${line.level}: ${line.text}`;
}

function NotebookBody({
  view,
  selected,
  onSelect,
  signedIn,
}: {
  view: NotebookList;
  selected: string | null;
  onSelect: (name: string) => void;
  signedIn: boolean;
}) {
  if (view.state === "listing") {
    return (
      <p className="fineprint" role="status">
        Listing notebooks…
      </p>
    );
  }

  if (view.state === "failed") {
    return (
      <p className="error" role="alert">
        The notebook listing failed. You can try again.
      </p>
    );
  }

  if (view.state === "idle") {
    return <p className="fineprint">No notebooks listed yet.</p>;
  }

  if (view.items.length === 0) {
    return (
      <p className="fineprint">
        The listing succeeded and found no notebooks in this account.
      </p>
    );
  }

  return (
    <ul className="notebooks">
      {view.items.map((name) => (
        <li key={name}>
          <label>
            <input
              type="radio"
              name="notebook"
              value={name}
              checked={selected === name}
              // Greyed until signed in: PLAN-v2 §9.2. Selectable but not
              // startable, so the page can show what is there without offering
              // an export the backend would refuse.
              disabled={!signedIn}
              onChange={() => onSelect(name)}
            />
            <span>{name}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

function ExportProgress({
  running,
  streamState,
  actionError,
  onAbort,
}: {
  running: RunningExport;
  streamState: NotebookPickerProps["streamState"];
  actionError: string | null;
  onAbort: (exportId: string) => void;
}) {
  const finished = running.state === "done";
  // `partial` is its own outcome and `partialReason` says which. Rendering all
  // three as "you stopped this" would be false for quota and disk, and would
  // send the user hunting for something they did not do.
  const stopped = running.state === "failed" || running.state === "partial";

  return (
    <section className="card">
      <h2>
        {finished
          ? "Export complete"
          : running.state === "partial"
            ? "Export stopped early"
            : running.state === "failed"
              ? "Export failed"
              : "Exporting"}
      </h2>

      <p>
        <strong>{running.notebook}</strong>
        {running.id && (
          <>
            {" "}
            — reference <code>{running.id}</code>
          </>
        )}
      </p>

      {/*
        The testid is not decoration: this is the only sentence on the card that
        moves, so the far-side run that proves the counts reach the snapshot
        samples it from outside the page — polling the surrounding card would
        read the notebook name and the reference, which do not change.
      */}
      <p aria-live="polite" data-testid="export-progress-line">
        {describeExport(running)}
      </p>

      {/* Placed above the button rather than in the page-level error slot: while
          an export runs the picker replaces the chooser, so a message rendered
          where the List button was would not be on screen at all. */}
      {actionError && (
        <p className="error" role="alert">
          {actionError}
        </p>
      )}

      {!finished && !stopped && (
        <button type="button" onClick={() => onAbort(running.id)}>
          Stop this export
        </button>
      )}

      {/* The stream is not a progress nicety: after a reconnect the server
          replays from its ring buffer, so progress stays correct without
          polling. Losing it silently would leave this card frozen. */}
      {streamState !== "open" && !finished && (
        <p className="fineprint" role="status">
          {streamState === "replaying"
            ? "Reconnecting — progress will catch up."
            : streamState === "connecting"
              ? "Connecting to live updates…"
              : "Live updates disconnected. The export continues on the server."}
        </p>
      )}

      {running.downloadUrl && (
        <ul className="artifacts">
          <li>
            {/*
              The URL comes from the snapshot's `artifact.downloadUrl`. This
              component does not construct a path and does not know whether Caddy
              or the api serves it — which is the point, and it retires a guess
              that used to live in this file.

              `download` is honoured same-origin only; cross-origin the browser
              navigates and `Content-Disposition` names the file instead. Setting
              it either way costs nothing.
            */}
            <a href={running.downloadUrl} download={running.fileName ?? undefined}>
              {running.fileName ?? "Download the vault"}
            </a>
            {running.artifactPartial && (
              <span className="fineprint">
                {" "}
                — this export is incomplete, so the vault is partial
              </span>
            )}
          </li>
        </ul>
      )}
    </section>
  );
}

/**
 * One sentence per outcome, and the partial case branches on the reason.
 *
 * This is the whole reason `partialReason` exists as a separate field: the
 * difference between "try again" and "free some space and try again" is what the
 * user needs to hear, and neutral wording gives them neither.
 */
function describeExport(running: RunningExport): string {
  switch (running.state) {
    case "queued":
      return "Queued.";
    case "running":
      return running.progress
        ? `${running.progress.pages} pages, ${running.progress.sections} sections, ${running.progress.assets} assets so far.`
        : "Working…";
    case "done":
      // The counts, because the sentence above them is a claim nobody can check.
      // The same walk run in the command-line package printed "29 pages, 8
      // assets, 1 page failed"; this card said only that everything was written,
      // and a vault missing a page read exactly like a complete one.
      return describeTerminal(
        running,
        "Everything has been written to the vault",
        (counted) => ` — ${counted}`,
      );
    case "failed":
      // The server's own text, appended. It is already safe to display per the
      // api, and a generic sentence alone leaves the user with no idea what to
      // do differently next time.
      return running.error
        ? `The export failed: ${running.error} Nothing was completed, so you can start again.`
        : "The export failed. Nothing was completed, so you can start again.";
    case "partial":
      switch (running.partialReason) {
        case "aborted":
          return "You stopped this export, so the vault is incomplete.";
        case "quota":
          return "The export stopped because a service quota was reached. The vault is incomplete — try again once the quota resets.";
        case "disk":
          return "The export stopped because the container ran out of disk space. The vault is incomplete — free space and try again.";
        default:
          // No reason, or one this build does not know — and **the common case
          // here is not a stop at all**. The walk the user measured reached the
          // end and came back one page short; "the export stopped before it
          // finished" is false of that, and `partial` is reached whenever
          // anything is lost, which is not the same as whenever something
          // interrupted. So the counts and the losses are said, and nothing is
          // claimed about the cause, which is genuinely unknown here.
          return describeTerminal(
            running,
            "The vault is incomplete",
            (counted) => ` — ${counted} were written`,
          );
      }
    default:
      return "";
  }
}

/**
 * A finished outcome: what was written, then what was lost.
 *
 * Both terminal branches are this, because they are the same fact — a vault that
 * does not contain everything the walk reported. `lead` is what the branch knows
 * for certain, and `written` is how the counts attach to it: the same counts
 * need a different tail after "Everything has been written to the vault" than
 * after "The vault is incomplete", because only the second is making a claim
 * about the walk having reached its end.
 *
 * A missing count is left out rather than rendered as a zero — this is the same
 * rule the parser follows, and for the same reason.
 */
function describeTerminal(
  running: RunningExport,
  lead: string,
  written: (counted: string) => string,
): string {
  const body = running.progress ? `${lead}${written(counts(running.progress))}` : lead;
  const lost = failures(running.failed);
  return lost ? `${body}, ${lost}.` : `${body}.`;
}

/**
 * "29 pages, 1 section and 8 assets" — the counts, in the vocabulary the api
 * already uses, from `export.progress`.
 */
function counts(progress: ExportProgress): string {
  return `${plural(progress.pages, "page")}, ${plural(progress.sections, "section")} and ${plural(
    progress.assets,
    "asset",
  )}`;
}

/**
 * "1 page failed", or "" when there is nothing to report.
 *
 * Empty for `null` — the walk recorded no failures, or the backend predates the
 * field — and empty for an all-zero block, which is a *measured* zero: nothing
 * was lost, and "0 pages failed" printed under a clean export is the sentence
 * this field was added to delete. Only the non-zero kinds are named, so a lost
 * page never drags two measured zeros into the sentence with it.
 */
function failures(failed: ExportFailures | null): string {
  if (!failed) return "";
  const lost: string[] = [];
  if (failed.pages > 0) lost.push(plural(failed.pages, "page"));
  if (failed.sections > 0) lost.push(plural(failed.sections, "section"));
  if (failed.groups > 0) lost.push(plural(failed.groups, "group"));
  return lost.length === 0 ? "" : `${joinAnd(lost)} failed`;
}

/**
 * One is the common case — a single-section notebook, a single lost page — and
 * "1 pages failed" is the sentence a user actually reads.
 */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "1 page", "2 pages and 3 sections", "1 page, 2 sections and 3 groups". */
function joinAnd(parts: string[]): string {
  const [last = ""] = parts.slice(-1);
  const head = parts.slice(0, -1);
  return head.length === 0 ? last : `${head.join(", ")} and ${last}`;
}
