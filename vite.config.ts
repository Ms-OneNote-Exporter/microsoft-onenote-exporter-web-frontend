import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { assetAttestation } from "./vite/asset-attestation";

/**
 * The API origin. Build-time configuration, validated at boot — see
 * `src/lib/env.ts`. There is deliberately no user-supplied base URL: that
 * would turn the operator's origin into an open proxy, and it would let a
 * hostile bundle pick where the credential goes.
 */
const API_ORIGIN = process.env.VITE_API_ORIGIN ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react(), assetAttestation()],
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
  define: { __API_ORIGIN__: JSON.stringify(API_ORIGIN) },
});
