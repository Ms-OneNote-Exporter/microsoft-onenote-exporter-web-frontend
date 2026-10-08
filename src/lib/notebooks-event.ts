/**
 * Parsers for the two SSE payloads the notebook list depends on.
 *
 * These lived in `App.tsx` as private functions. They are here because both are
 * decisions with failure modes worth asserting on their own: an unrecognised
 * state, a missing field, a payload that is not an object. All three used to be
 * absorbed into the component where they were written, which is where a
 * transcription error is least likely to be noticed.
 *
 * Both are transcribed from the api, not inferred. `notebooks-listed` carries
 * `{state, items}` from `publish()` in `api/src/runner-adapter-http.ts`; the
 * `auth-state` event carries `{state}` and the api emits
 * `{state: "authenticating"}` immediately before it starts a listing
 * (`api/src/routes.ts`).
 */
import type { NotebookList } from "./session";

/**
 * Parse a `notebooks-listed` payload.
 *
 * Defaults `state` to `loaded` because the event *is* the completed listing — a
 * payload with items but no state is a listing, not an idle server. Getting this
 * backwards would drop the user's notebooks into the wrong branch.
 *
 * An unrecognised state is mapped to `loaded` rather than passed through or
 * mapped to `failed`: the union is closed and transcribed from the api, so a
 * value outside it is a mismatch, and rendering a list the user can see is the
 * honest reading where showing an empty chooser would not be.
 */
export function parseNotebooks(data: unknown): NotebookList {
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

/**
 * The `state` of an `auth-state` event payload, or null.
 *
 * Read defensively and strictly, because the only thing that reads it compares
 * against the single literal `"authenticating"`. A default of `"authenticating"`
 * would mark a listing as in flight on every malformed event and then suppress
 * empty snapshots for the rest of the session — a quiet misbehaviour that looks
 * exactly like the bug it was added to fix.
 */
export function readAuthState(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const state = (data as Record<string, unknown>).state;
  return typeof state === "string" ? state : null;
}

function readStringArray(data: unknown, key: string): string[] {
  if (typeof data !== "object" || data === null) return [];
  const value = (data as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((n: unknown): n is string => typeof n === "string");
}