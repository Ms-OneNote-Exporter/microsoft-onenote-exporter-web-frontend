import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";
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

/**
 * This build's version, from `package.json`, substituted into the bundle so the
 * page can say which one it is (`src/lib/version.ts`).
 *
 * Read here rather than in `src/` because the alternative is importing
 * `package.json` from application code, and esbuild would then inline the whole
 * file — the dependency list included — into a shipped bundle. The define
 * substitutes one string and nothing else.
 *
 * A missing or non-string `version` would render `undefined` on the page, which
 * is worse than useless: it looks like a value. So it is refused, on the same
 * principle as the missing `VITE_API_ORIGIN` above.
 */
const APP_VERSION = typeof pkg.version === "string" ? pkg.version.trim() : "";

if (APP_VERSION === "") {
  throw new Error(
    "package.json has no usable `version`.\n\n" +
      "The page prints its own version so a version-skew report carries something\n" +
      "to compare against, and `vite.config.ts` substitutes it into the bundle.\n" +
      "Add a `version` field to package.json and rebuild.",
  );
}

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
  define: {
    __API_ORIGIN__: JSON.stringify(API_ORIGIN_VALIDATED),
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
});