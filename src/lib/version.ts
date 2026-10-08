/**
 * This build's own version, shown on the page.
 *
 * Substituted from `package.json` at build time, by `vite.config.ts` and
 * `vitest.config.ts` alike. The same shape as `__API_ORIGIN__` in
 * `protocol.ts`: a build-time constant in the bundle, never a runtime fetch and
 * never a value anything branches on.
 *
 * ## Why a build-time constant and not a fetched one
 *
 * The obvious alternative is to read it from the status route, which would make
 * it unspoofable and always current. It would also mean a page that has failed
 * to load its own JavaScript — or is looking at a stale cached bundle — cannot
 * say which version it is, which is the case where someone is actually asking.
 * A version that is only available when everything else works is available
 * exactly when it is least useful.
 *
 * ## Two versions, deliberately
 *
 * The backend answers `/api/public/version` with `protocol` and `build`, and
 * `build` is the commit its image was baked from. So "what is this?" and "can I
 * talk to it?" are two different fields from two different components, and the
 * header shows both. A mismatch screen that named only the protocol left the
 * reader to guess which side needed the fix — and a version-skew report that
 * carried only a protocol number carried nothing to compare against.
 */
declare const __APP_VERSION__: string;

export const FRONTEND_VERSION: string = __APP_VERSION__;