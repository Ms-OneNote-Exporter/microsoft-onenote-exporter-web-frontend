/**
 * Session and export state, as the backend reports it.
 *
 * These types describe PLAN-v2 §7.5's `/api/session/status` snapshot and the
 * SSE events that keep it current. They are **hand-written literals** for the
 * same reason `protocol.ts` is: the two repos deploy independently, so the shape
 * is a contract we both assert rather than a package we both import.
 *
 * ## Why the parsers are alias-tolerant
 *
 * The field names below were a guess. They are still a guess — the contract
 * discussion with Component B has not settled them — so rather than hard-code
 * one spelling and be silently wrong if the other side picked a different one,
 * each field is resolved through a list of accepted aliases.
 *
 * The cost is real and worth stating: a typo in the *server* now produces a
 * "signed in as false" page instead of a loud parse failure. That is why
 * `parseSessionStatus` also returns `matched` — the alias table records which key
 * actually satisfied each field. When the two implementations agree, every entry
 * is either the canonical name or an alias that is never used, and the aliases
 * can be deleted in a follow-up with a test proving the canonical name is the
 * one in use. Until then, `matched` is the diagnostic and guessing wrong costs a
 * broken page rather than a silent data-corruption bug.
 *
 * The alternative was opening the pages against names nobody had agreed to and
 * discovering the mismatch during an export.
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
  /** Which alias satisfied each field. Diagnostic; see the note above. */
  matched: MatchedAliases;
}

export interface MatchedAliases {
  authenticated?: string | undefined;
  signedIn?: string | undefined;
  notebooks?: string | undefined;
  export?: string | undefined;
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
  /**
   * An absolute or origin-relative URL supplied by the server.
   *
   * Preferred over constructing `/files/<id>` here, because whether
   * `GET /files/:artifactId` is served by the static host (Caddy plus
   * `forward_auth`) or by the API origin was still undecided when this was
   * written, and the two produce a different href. When the server supplies the
   * URL, this component never has to be right about it.
   */
  url?: string | undefined;
}

/**
 * Canonical name first, then accepted aliases. First match wins.
 *
 * Keeping the canonical spelling at index 0 means that once the server settles
 * on one name, the `matched` map will show it and the rest can be deleted.
 */
const ALIASES = {
  authenticated: ["authenticated", "session", "hasSession", "session_exists"],
  signedIn: ["signedIn", "signed_in", "isSignedIn", "credential_accepted"],
  notebooks: ["notebooks", "notebookList", "notebook_list"],
  export: ["export", "runningExport", "running_export", "currentExport", "job"],
} as const satisfies Record<keyof MatchedAliases, readonly string[]>;

function readAlias(
  body: Record<string, unknown>,
  field: keyof typeof ALIASES,
): { key: string | undefined; value: unknown } {
  for (const key of ALIASES[field]) {
    if (key in body) return { key, value: body[key] };
  }
  return { key: undefined, value: undefined };
}

/**
 * Normalise the server's notebook state without assuming a closed union.
 *
 * The union was never agreed, and treating an unknown value as `idle` renders
 * "No notebooks listed yet" — indistinguishable from a working empty account,
 * which is the kind of failure nobody reports. Mapping to `unknown` keeps an
 * empty listing and an unrecognised state visibly different, and names the raw
 * value so a user can report something specific.
 */
export function notebookStatus(raw: unknown): NotebookStatusView {
  if (!isRecord(raw)) {
    return { kind: "unknown", items: [], rawState: "(not an object)" };
  }

  const state = typeof raw.state === "string" ? raw.state : "";
  const items = Array.isArray(raw.items)
    ? raw.items.filter((n: unknown): n is string => typeof n === "string")
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
 * Tolerant by construction: every field is checked, and a malformed body becomes
 * a status that reports nothing rather than a throw. A backend that is
 * mid-deploy or misconfigured should produce a page that says "cannot read the
 * session", not a blank screen.
 */
export function parseSessionStatus(raw: unknown): SessionStatus {
  const body = isRecord(raw) ? raw : {};
  const matched: MatchedAliases = {};

  const auth = readAlias(body, "authenticated");
  matched.authenticated = auth.key;

  const signedIn = readAlias(body, "signedIn");
  matched.signedIn = signedIn.key;

  const notebooksRaw = readAlias(body, "notebooks");
  matched.notebooks = notebooksRaw.key;

  const exportRaw = readAlias(body, "export");
  matched.export = exportRaw.key;

  const notebooks = isRecord(notebooksRaw.value) ? notebooksRaw.value : {};
  const items = Array.isArray(notebooks.items) ? notebooks.items : [];

  return {
    authenticated: truthy(auth.value),
    signedIn: truthy(signedIn.value),
    notebooks: {
      state: typeof notebooks.state === "string" ? notebooks.state : "",
      items: items.filter((n: unknown): n is string => typeof n === "string"),
      error:
        typeof notebooks.error === "string" ? notebooks.error : undefined,
    },
    export: parseExport(exportRaw.value) ?? undefined,
    matched,
  };
}

/**
 * Only a real `true` counts as true.
 *
 * Not truthiness: a backend that serialises `"true"` or `1` would otherwise be
 * read as signed in, and the credential page is the one screen where being wrong
 * in that direction sends a user to type their password again.
 */
function truthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (isRecord(value)) return true;
  return false;
}

/** Parse an export from a status snapshot or an SSE payload. Shared. */
export function parseExport(raw: unknown): RunningExport | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.exportId !== "string") return null;

  const notebook = typeof raw.notebook === "string" ? raw.notebook : "";

  return {
    exportId: raw.exportId,
    notebook,
    state: (typeof raw.state === "string" ? raw.state : "running") as ExportState,
    progress: typeof raw.progress === "string" ? raw.progress : undefined,
    error: typeof raw.error === "string" ? raw.error : undefined,
    artifacts: parseArtifacts(raw.artifacts),
  };
}

function parseArtifacts(value: unknown): Artifact[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Artifact[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item.artifactId !== "string") continue;
    out.push({
      artifactId: item.artifactId,
      name: typeof item.name === "string" ? item.name : item.artifactId,
      bytes: typeof item.bytes === "number" ? item.bytes : undefined,
      url: typeof item.url === "string" ? item.url : undefined,
    });
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}