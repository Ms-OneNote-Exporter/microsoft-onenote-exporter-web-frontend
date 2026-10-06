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
import {
  notebookStatus,
  type NotebookList,
  type RunningExport,
} from "../lib/session";

export interface NotebookPickerProps {
  notebooks: NotebookList;
  /** False until the credential has been accepted. */
  signedIn: boolean;
  export: RunningExport | undefined;
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
  const view = notebookStatus(notebooks);

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

      <button type="button" onClick={onList} disabled={view.kind === "listing"}>
        {view.kind === "listing" ? "Listing…" : "List my notebooks"}
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
  view: ReturnType<typeof notebookStatus>;
  selected: string | null;
  onSelect: (name: string) => void;
  signedIn: boolean;
}) {
  if (view.kind === "listing") {
    return (
      <p className="fineprint" role="status">
        Listing notebooks…
      </p>
    );
  }

  if (view.kind === "failed") {
    return (
      <p className="error" role="alert">
        The notebook listing failed: {view.error}. You can try again.
      </p>
    );
  }

  if (view.kind === "unknown") {
    // Deliberately not "no notebooks". An empty list after a successful
    // listing is a real, reportable state; a state we do not recognise is a
    // contract mismatch, and conflating the two hides it.
    return (
      <p className="error" role="alert">
        The service reported an unrecognised notebook state (
        <code>{view.rawState}</code>). This is a version problem, not an empty
        account — please report it.
      </p>
    );
  }

  if (view.kind === "idle") {
    return (
      <p className="fineprint">No notebooks listed yet.</p>
    );
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
  const stopped = running.state === "failed" || running.state === "aborted";

  return (
    <section className="card">
      <h2>
        {finished ? "Export complete" : stopped ? "Export stopped" : "Exporting"}
      </h2>

      <p>
        <strong>{running.notebook}</strong>
        {running.exportId && (
          <>
            {" "}
            — reference <code>{running.exportId}</code>
          </>
        )}
      </p>

      <p aria-live="polite">
        {running.state === "queued" && "Queued."}
        {running.state === "running" && (running.progress ?? "Working…")}
        {finished && "Everything has been written to the vault."}
        {running.state === "aborted" && "You stopped this export."}
        {running.state === "failed" &&
          `It failed${running.error ? `: ${running.error}` : "."}`}
      </p>

      {!finished && !stopped && (
        <button type="button" onClick={() => onAbort(running.exportId)}>
          Stop this export
        </button>
      )}

      {/* The stream is not just a progress nicety: after a reconnect the server
          replays from its ring buffer, so progress continues to be correct
          without polling. Losing it silently would leave this card frozen on
          whatever it last saw. */}
      {streamState !== "open" && !finished && (
        <p className="fineprint" role="status">
          {streamState === "replaying"
            ? "Reconnecting — progress will catch up."
            : streamState === "connecting"
              ? "Connecting to live updates…"
              : "Live updates disconnected. The export continues on the server."}
        </p>
      )}

      {finished && running.artifacts && running.artifacts.length > 0 && (
        <ul className="artifacts">
          {running.artifacts.map((a) => (
            <li key={a.artifactId}>
              {/*
                A server-supplied `url` wins over the constructed path. Whether
                `GET /files/:artifactId` lives on the static host (Caddy plus
                `forward_auth`) or on the API origin was undecided when this was
                written, and the two produce different hrefs. When the server
                tells us where the artifact is, this component is not responsible
                for being right about it.

                `download` is only honoured same-origin, so the fallback keeps
                it and lets the server's `Content-Disposition` name the file
                when the href turns out to be cross-origin. Nothing is lost by
                setting it either way.
              */}
              <a
                href={a.url ?? `/files/${encodeURIComponent(a.artifactId)}`}
                download={a.name}
              >
                {a.name}
              </a>
              {typeof a.bytes === "number" && (
                <span className="fineprint"> ({formatBytes(a.bytes)})</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}