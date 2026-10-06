/**
 * Session state, as the backend reports it.
 *
 * This mirrors `SessionSnapshot` in the api repository (`api/src/auth.ts`) and the
 * event names in `api/src/sse.ts`. Those two files are the contract; this is a
 * transcription of them, and where the two disagree, they are right and this is
 * wrong.
 *
 * ## An earlier version of this file guessed, and it was wrong
 *
 * This previously modelled the snapshot as flat booleans — `authenticated`,
 * `signedIn` — with an **alias table** accepting several spellings of each, on
 * the theory that being permissive would let the page degrade instead of
 * throwing. Both halves of that were mistakes:
 *
 * The real shape is nested enums. There is no `signedIn` boolean to alias;
 * `auth.state` is `"none" | "authenticating" | "valid" | "expired" | "failed"`.
 * And `export.id` is not `export.exportId`, `export.progress` is an object
 * rather than a string, and there is a single `artifact.downloadUrl` rather than
 * an array of artifacts.
 *
 * Worse, the alias table turned a loud failure into a quiet one — exactly the
 * risk it was written to avoid. With no `signedIn` key present, every lookup
 * missed, and the page rendered "no session, no export" indefinitely while
 * looking entirely normal. A user would not report that; they would conclude the
 * service was broken.
 *
 * So there is **no alias table here**, and an unrecognised value is surfaced
 * rather than absorbed. That is a deliberate reversal, not an oversight.
 */

/**
 * `SessionState` in the api. `erased` cannot reach a snapshot — the erase
 * machine deletes the row, so there is nothing to build one from.
 */
export type SessionState =
  | "created"
  | "authenticating"
  | "authenticated"
  | "exporting"
  | "erasing"
  | "erased";

/** `AuthState` in the api. Mirrored here; not re-derived. */
export type AuthState =
  | "none"
  | "authenticating"
  | "valid"
  | "expired"
  | "failed";

/** Progress of the notebook listing, which runs a CLI in the runner. */
export type NotebookState = "idle" | "listing" | "loaded" | "failed";

export type ExportState =
  | "none"
  | "queued"
  | "running"
  | "done"
  | "partial"
  | "failed";

/**
 * Why a partial export stopped.
 *
 * Carried separately from `state` because `partial` alone cannot be rendered
 * honestly: telling someone "you stopped this export" is factually false when the
 * quota or the disk filled up, and sends them looking for something they did not
 * do. The difference between "try again" and "free some space and try again" is
 * the entire point of telling them at all.
 */
export type PartialReason = "aborted" | "quota" | "disk";

/** `export.progress` — counts, not a sentence. */
export interface ExportProgress {
  pages: number;
  sections: number;
  assets: number;
}

export interface RunningExport {
  /** `export.id` in the api. Never called `exportId`. */
  id: string;
  notebook: string;
  state: ExportState;
  progress: ExportProgress | null;
  partialReason: PartialReason | null;
  /** `artifact.downloadUrl`, supplied by the server. */
  downloadUrl: string | null;
  fileName: string | null;
  /** The artifact is partial, so the download is incomplete. */
  artifactPartial: boolean;
}

export interface NotebookList {
  state: NotebookState;
  items: string[];
}

/**
 * A parsed snapshot, or the reason it could not be parsed.
 *
 * A failure is a value rather than a thrown error, because the user-facing
 * consequence of a mismatch is "this page is out of date", not a stack trace —
 * and because the alternative, degrading quietly, is what this file used to do.
 */
export type Snapshot =
  | { ok: true; value: SessionStatus }
  | { ok: false; problems: string[] };

export interface SessionStatus {
  /** True when the session exists and is usable. Derived, never sent. */
  hasSession: boolean;
  sessionState: SessionState;
  authState: AuthState;
  /**
   * True only for `auth.state === "valid"`.
   *
   * `expired` and `failed` are deliberately *not* distinguished in the UI:
   * Microsoft can invalidate a session cookie out from under the browser and a
   * crashed OneNote tab produces the same observable error, so the client cannot
   * honestly tell the user which happened. Sending them to the credential form
   * is right for both.
   */
  signedIn: boolean;
  notebooks: NotebookList;
  export: RunningExport | null;
  csrfToken: string | null;
}

/**
 * parseSessionStatus reads the snapshot, or explains why it could not.
 *
 * Strict on purpose. Every field is required by the interface, so a missing one
 * is a genuine mismatch and is reported rather than defaulted — the failure that
 * motivated this rewrite.
 */
export function parseSessionStatus(raw: unknown): Snapshot {
  const problems: string[] = [];
  if (!isRecord(raw)) {
    return { ok: false, problems: ["the session snapshot was not a JSON object"] };
  }

  const session = isRecord(raw.session) ? raw.session : null;
  if (session === null) problems.push("missing `session`");
  const auth = isRecord(raw.auth) ? raw.auth : null;
  if (auth === null) problems.push("missing `auth`");
  const notebooks = isRecord(raw.notebooks) ? raw.notebooks : null;
  if (notebooks === null) problems.push("missing `notebooks`");
  const exportRaw = isRecord(raw.export) ? raw.export : null;
  if (exportRaw === null) problems.push("missing `export`");
  const artifact = isRecord(raw.artifact) ? raw.artifact : null;
  if (artifact === null) problems.push("missing `artifact`");

  if (problems.length > 0) {
    return { ok: false, problems };
  }

  const sessionState = asEnum(session!.state, SESSION_STATES, "session.state", problems);
  const authState = asEnum(auth!.state, AUTH_STATES, "auth.state", problems);

  const notebookState = asEnum(
    notebooks!.state,
    NOTEBOOK_STATES,
    "notebooks.state",
    problems,
  );

  const exportState = asEnum(
    exportRaw!.state,
    EXPORT_STATES,
    "export.state",
    problems,
  );

  if (problems.length > 0) return { ok: false, problems };

  const items = Array.isArray(notebooks!.items) ? notebooks!.items : [];
  if (!Array.isArray(notebooks!.items)) {
    problems.push("`notebooks.items` was not an array");
  }

  // The api documents that only leaves are optional and an absent leaf is
  // `null`, so a null id genuinely means "no export" rather than "malformed".
  const id = exportRaw!.id;
  const hasExport =
    exportState !== "none" &&
    (typeof id === "string" || typeof exportRaw!.notebook === "string");

  const running: RunningExport | null = hasExport
    ? {
        id: typeof id === "string" ? id : "",
        notebook: str(exportRaw!.notebook),
        state: exportState as ExportState,
        progress: parseProgress(exportRaw!.progress),
        partialReason: asPartialReason(exportRaw!.partialReason),
        downloadUrl: str(artifact!.downloadUrl) || null,
        fileName: str(artifact!.fileName) || null,
        artifactPartial: artifact!.partial === true,
      }
    : null;

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    value: {
      hasSession: sessionState !== "erased" && sessionState !== "erasing",
      sessionState: sessionState as SessionState,
      authState: authState as AuthState,
      signedIn: authState === "valid",
      notebooks: {
        state: notebookState as NotebookState,
        items: items.filter((n: unknown): n is string => typeof n === "string"),
      },
      export: running,
      csrfToken:
        typeof raw.csrfToken === "string" && raw.csrfToken !== ""
          ? raw.csrfToken
          : null,
    },
  };
}

const SESSION_STATES = [
  "created",
  "authenticating",
  "authenticated",
  "exporting",
  "erasing",
  "erased",
] as const;

const AUTH_STATES = [
  "none",
  "authenticating",
  "valid",
  "expired",
  "failed",
] as const;

const NOTEBOOK_STATES = ["idle", "listing", "loaded", "failed"] as const;

const EXPORT_STATES = [
  "none",
  "queued",
  "running",
  "done",
  "partial",
  "failed",
] as const;

const PARTIAL_REASONS = ["aborted", "quota", "disk"] as const;

/**
 * An out-of-union value is a problem, not a value to pass through.
 *
 * The api validates `partialReason` on read and turns an out-of-union stored
 * value into `null`, so this should never fire. It is here so that a future
 * widening of either union shows up as a named mismatch on the page instead of a
 * component rendering a state it has no branch for.
 */
function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  problems: string[],
): T | "" {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  problems.push(`${label} was ${JSON.stringify(value)}, not one of ${allowed.join(" | ")}`);
  return "";
}

function asPartialReason(value: unknown): PartialReason | null {
  return typeof value === "string" && (PARTIAL_REASONS as readonly string[]).includes(value)
    ? (value as PartialReason)
    : null;
}

function parseProgress(value: unknown): ExportProgress | null {
  if (!isRecord(value)) return null;
  const num = (key: string) => (typeof value[key] === "number" ? value[key] : 0);
  return { pages: num("pages"), sections: num("sections"), assets: num("assets") };
}

/** null / undefined / "" all mean "absent"; anything else is coerced. */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}