import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { assetAttestation } from "./vite/asset-attestation";
import { assertExactOrigin } from "./vite/csp";

/**
 * The API origin. Build-time configuration — see `src/lib/env.ts`.
 *
 * There is deliberately no user-supplied base URL: that would turn the
 * operator's origin into an open proxy, and it would let a hostile bundle pick
 * where the credential goes.
 *
 * **Required, with no default.** The earlier version defaulted to
 * `http://localhost:3000`, which is fine in development and actively dangerous
 * in production: a deploy that forgets to set the variable builds successfully
 * and emits a bundle pointing at localhost. Nothing about that failure looks
 * like a misconfiguration — the build is green, the page loads, and the
 * handshake fails in the browser with a network error. A build that refuses is
 * a build that cannot ship an unbounded `connect-src` by accident.
 */
const API_ORIGIN = process.env.VITE_API_ORIGIN;

if (API_ORIGIN === undefined || API_ORIGIN.trim() === "") {
  throw new Error(
    "VITE_API_ORIGIN is not set.\n\n" +
      "This build emits a Content-Security-Policy whose connect-src names the API origin,\n" +
      "and every request in src/lib/api.ts resolves its target from it. There is no\n" +
      "default, because a wrong default produces a bundle that looks fine and cannot\n" +
      "work, and a policy that names nothing.\n\n" +
      "  cp .env.example .env      and set it, or\n" +
      "  export VITE_API_ORIGIN=https://api.example.com\n\n" +
      "It must be an exact origin: no path, no trailing slash.",
  );
}

// Validated here so a malformed value fails at build time. A connect-src that
// does not parse is a connect-src that does not restrict anything, and the page
// still loads — which is the worst shape of failure for this particular header.
const API_ORIGIN_VALIDATED = assertExactOrigin(API_ORIGIN);

export default defineConfig({
  plugins: [react(), assetAttestation(API_ORIGIN_VALIDATED)],
  server: { port: 5173 },
  build: {
    outDir: "dist",
    // Deterministic names keep `dist/ASSETS.sha256` byte-stable across runs,
    // so a CI diff means a real output change.
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  // Surfaced for the CI header assertion; the deployed header must match.
  define: { __API_ORIGIN__: JSON.stringify(API_ORIGIN_VALIDATED) },
});