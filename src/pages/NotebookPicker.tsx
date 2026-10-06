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
import { useState } from "react";
import type { NotebookList, RunningExport } from "../lib/session";

export interface NotebookPickerProps {
  notebooks: NotebookList;
  /** False until the credential has been accepted. */
  signedIn: boolean;
  export: RunningExport | null;
  streamState: "connecting" | "open" | "replaying" | "closed";
  onList: () => void;
  onStart: (notebook: string) => void;
  onAbort: (exportId: string) => void;
}

export function NotebookPicker({
  notebooks,
  signedIn,
  export: running,
  streamState,
  onList,
  onStart,
  onAbort,
}: NotebookPickerProps) {
  const [selected, setSelected] = useState<string | null>(null);
  // A closed union transcribed from the api, so it is rendered directly rather
  // than normalised. The previous version mapped an unrecognised value to
  // `unknown`; that was a workaround for a guess, and the guess was wrong.
  const view = notebooks;

  // A running export wins over the chooser: during one there is nothing to
  // pick, and offering a second start is what produces a 409.
  if (running) {
    return <ExportProgress running={running} streamState={streamState} onAbort={onAbort} />;
  }

  return (
    <section className="card">
      <h2>Choose a notebook</h2>

      <p>
        Listing your notebooks runs a short listing command in the isolated
        container, so it takes a moment rather than appearing instantly.
      </p>

      <button type="button" onClick={onList} disabled={view.state === "listing"}>
        {view.state === "listing" ? "Listing…" : "List my notebooks"}
      </button>

      <NotebookBody
        view={view}
        selected={selected}
        onSelect={setSelected}
        signedIn={signedIn}
      />

      <button
        type="button"
        disabled={!signedIn || !selected}
        onClick={() => selected && onStart(selected)}
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
  );
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
  onAbort,
}: {
  running: RunningExport;
  streamState: NotebookPickerProps["streamState"];
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

      <p aria-live="polite">{describeExport(running)}</p>

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
      return "Everything has been written to the vault.";
    case "failed":
      return "The export failed. Nothing was completed, so you can start again.";
    case "partial":
      switch (running.partialReason) {
        case "aborted":
          return "You stopped this export, so the vault is incomplete.";
        case "quota":
          return "The export stopped because a service quota was reached. The vault is incomplete — try again once the quota resets.";
        case "disk":
          return "The export stopped because the container ran out of disk space. The vault is incomplete — free space and try again.";
        default:
          // No reason, or one this build does not know. Say what is true and
          // nothing more: the vault is incomplete, and we cannot say why.
          return "The export stopped before it finished, so the vault is incomplete.";
      }
    default:
      return "";
  }
}
