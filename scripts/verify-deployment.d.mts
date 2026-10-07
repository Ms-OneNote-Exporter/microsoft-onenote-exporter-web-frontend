/**
 * Types for `scripts/verify-deployment.mjs`.
 *
 * The script is plain ESM JavaScript because it has to run under bare `node` in
 * a workflow step with no build step — adding a TypeScript build to a script that
 * exists precisely to check a build would be circular.
 *
 * This declaration exists so the TypeScript test beside it type-checks, which is
 * the point: the verification logic is asserted by tests that run in CI, and an
 * untyped script means those tests are asserting against `any`.
 */

export interface VerifyOptions {
  /** Absolute origin of the deployment, e.g. `https://example.phttp.com`. */
  baseUrl: string;
  /** path → sha256 hex, as parsed from `dist/ASSETS.sha256`. */
  manifest: Map<string, string>;
  /** Injected for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Run every check.
 *
 * @returns every failure found. Empty means the deployment matches the build.
 *   All failures are collected rather than thrown on the first, because a job
 *   that reports one problem at a time takes one run per problem.
 */
export function verify(options: VerifyOptions): Promise<string[]>;

/** Read `sha256sum` output into a path → digest map. */
export function parseManifest(contents: string): Map<string, string>;

/** Extract the same-origin assets a served HTML page references. */
export function referencedAssets(html: string): { scripts: string[]; styles: string[] };

/**
 * One directive's value.
 *
 * `undefined` when absent — **and also when written with no value**, because a
 * valueless directive is invalid CSP and the browser discards it, so it restricts
 * exactly as much as omitting it.
 */
export function directive(policy: string, name: string): string | undefined;

/** Read a manifest from disk and verify against `baseUrl`. */
export function verifyManifestFile(options: {
  baseUrl: string;
  manifestPath: string;
  fetchImpl?: typeof fetch;
}): Promise<string[]>;