import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";

/**
 * Test configuration.
 *
 * Kept separate from `vite.config.ts` on purpose. That config builds for
 * production and pulls in `asset-attestation`, which computes SHA-256 digests
 * of the emitted files; none of that has anything to say about whether the
 * credential invariant holds. The only thing the two must agree on is the
 * `__API_ORIGIN__` substitution, because `src/lib/api.ts` resolves every
 * request target from it — so it is declared in both places with the same
 * fallback, and `T-A1` asserts the shape of the value rather than the
 * literal, which keeps the test meaningful in CI where the origin differs.
 */
const API_ORIGIN = process.env.VITE_API_ORIGIN ?? "http://localhost:3000";

// `__APP_VERSION__` is declared unconditionally in `src/lib/version.ts`, so a
// test importing `App` throws a ReferenceError without it. The real value is
// read from package.json rather than faked, so a test can assert the page shows
// the version that is actually shipping.
export default defineConfig({
  plugins: [react()],
  define: {
    __API_ORIGIN__: JSON.stringify(API_ORIGIN),
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "vite/**/*.test.ts"],
    // The credential route and the SSE client are both network calls. Tests
    // stub `fetch` and `EventSource` explicitly rather than relying on
    // interception, so a test that forgets to stub fails loudly instead of
    // quietly reaching the network.
    restoreMocks: true,
  },
});