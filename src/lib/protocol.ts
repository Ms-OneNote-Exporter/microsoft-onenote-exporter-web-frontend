/**
 * The contract between this repository and the backend.
 *
 * The two deploy independently — hPanel builds this on push, the backend
 * deploys on `compose pull && up` — so version skew is a fact of the
 * deployment, not a mistake (PLAN-v3 §7.2, §7.3). A monorepo would not change
 * that, so the handshake is required either way.
 *
 * This is a hand-written literal on purpose. A shared package would be a third
 * thing to release and version for a contract this small, and it would put
 * backend source back on a host we do not control. If the contract ever grows
 * enough to drift, publish a types-only `@msout/protocol` from the backend
 * repo and consume it from npm — that is not one of the four `@msout`
 * browser-automation packages, so §1.6 is unaffected.
 */

/** Bumped only for a breaking change to the routes or SSE contract. */
export const EXPECTED_PROTOCOL = 3;

export const API_ORIGIN = __API_ORIGIN__;

declare const __API_ORIGIN__: string;
