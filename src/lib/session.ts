/**
 * Session and export state, as the backend reports it.
 *
 * These types describe PLAN-v2 §7.5's `/api/session/status` snapshot and the
 * SSE events that keep it current. They are **hand-written literals** for the
 * same reason `protocol.ts` is: the two repos deploy independently, so the
 * shape is a contract we both assert rather than a package we both import.
 *
 * What is deliberately *not* asserted here is the `state` union. zeus has been
 * asked what the non-`loaded` values are, and until that is answered every
 * consumer treats an unrecognised state as `unknown` rather than assuming it
 * is idle — see `notebookStatus()` below. Guessing a closed union wrong would
 * make the export page render an empty chooser instead of a progress state,
 * which is the kind of failure that looks like a working page.
 */

/** Progress of the notebook listing, which runs a CLI in the runner. */
export type NotebookState = "idle" | "listing" | "loaded" | "failed";

/**
 * Optional fields are declared `| undefined` rather than bare `?` because this
 * project compiles with `exactOptionalPropertyTypes`. Without the explicit
 * `undefined`, "this key is absent" and "this key is present and undefined"
 * become the same type, and building an object that sets `export: undefined` to
 * *clear* it stops typechecking. Clearing a field by setting it to undefined is
 * exactly what the SSE handlers do.
 */
export interface NotebookList {
  /** Raw value from the server, before normalisation. */
  state: string;
  items: string[];
  /** Present when `state` is `failed`. */
  error?: string | undefined;
}

export interface SessionStatus {
  /** True once the session exists and its cookie has been set. */
  authenticated: boolean;
  /** True once the Microsoft password has been accepted for this session. */
  signedIn: boolean;
  notebooks: NotebookList;
  /** The running export, if any. Drives refresh-restore during an export. */
  export?: RunningExport | undefined;
}

export type ExportState =
  | "queued"
  | "running"
  | "done"
  | "failed"
  | "aborted";

export interface RunningExport {
  exportId: string;
  notebook: string;
  state: ExportState;
  /** Server-assigned, opaque. Shown to the user for support, never parsed. */
  progress?: string | undefined;
  /** Populated when `state` is `failed`. */
  error?: string | undefined;
  /** Download links, populated when `state` is `done`. */
  artifacts?: Artifact[] | undefined;
}

export interface Artifact {
  artifactId: string;
  name: string;
  bytes?: number | undefined;
}

/**
 * Normalise the server's notebook state without assuming a closed union.
 *
 * The scaffold's own type was `unknown`, and an unrecognised value rendered as
 * an empty chooser is indistinguishable from "loaded, zero notebooks". Mapping
 * to `unknown` keeps those two cases visibly different in the UI, which is the
 * difference between a user reporting a bug and a user reporting nothing.
 */
export function notebookStatus(raw: unknown): NotebookStatusView {
  if (!isRecord(raw)) {
    return { kind: "unknown", items: [], rawState: "(not an object)" };
  }

  const state = typeof raw.state === "string" ? raw.state : "";
  const items = Array.isArray(raw.items)
    ? raw.items.filter((n): n is string => typeof n === "string")
    : [];

  switch (state) {
    case "idle":
      return { kind: "idle", items };
    case "listing":
      return { kind: "listing", items };
    case "loaded":
      return { kind: "loaded", items };
    case "failed":
      return {
        kind: "failed",
        items,
        error: typeof raw.error === "string" ? raw.error : "Listing failed",
      };
    default:
      return { kind: "unknown", items, rawState: state || "(absent)" };
  }
}

export type NotebookStatusView =
  | { kind: "idle"; items: string[] }
  | { kind: "listing"; items: string[] }
  | { kind: "loaded"; items: string[] }
  | { kind: "failed"; items: string[]; error: string }
  | { kind: "unknown"; items: string[]; rawState: string };

/**
 * Parse `/api/session/status` into a `SessionStatus`.
 *
 * Tolerant by construction: every field is checked, and a malformed body
 * becomes a status that reports nothing rather than a throw. A backend that is
 * mid-deploy or misconfigured should produce a page that says "cannot read the
 * session", not a blank screen.
 */
export function parseSessionStatus(raw: unknown): SessionStatus {
  const body = isRecord(raw) ? raw : {};
  // Narrowed separately rather than with `body.notebooks?.state`, because an
  // unknown value is not an object we may read arbitrary keys from.
  const notebooks = isRecord(body.notebooks) ? body.notebooks : {};
  const exportRaw = body.export;
  const items = Array.isArray(notebooks.items) ? notebooks.items : [];

  return {
    authenticated: body.authenticated === true,
    signedIn: body.signedIn === true,
    notebooks: {
      state: typeof notebooks.state === "string" ? notebooks.state : "",
      items: items.filter((n: unknown): n is string => typeof n === "string"),
      error: typeof notebooks.error === "string" ? notebooks.error : undefined,
    },
    export: isRunningExport(exportRaw) ? exportRaw : undefined,
  };
}

function isRunningExport(value: unknown): value is RunningExport {
  return (
    isRecord(value) &&
    typeof value.exportId === "string" &&
    typeof value.notebook === "string" &&
    typeof value.state === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}