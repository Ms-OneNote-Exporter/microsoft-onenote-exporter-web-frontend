/**
 * Emits the two build artefacts the deployment contract depends on.
 *
 * 1. `dist/ASSETS.sha256` — sorted `path + digest` for every emitted file.
 *    The hosting platform runs our `npm install` and our build script, and its
 *    users can write the deploy directory directly, so the served bytes are not
 *    guaranteed to be the reviewed bytes. A post-deploy job fetches the live
 *    `index.html` and every asset it references and compares digests
 *    (PLAN-v3 §7.1). That check runs on a *schedule*, not only at deploy time,
 *    precisely because a tampered bundle needs no code change.
 *
 * 2. `dist/CSP-HASHES.txt` — the `'sha256-…'` sources for every inline
 *    `<script>` in the emitted HTML, one per line.
 *
 * Why this exists at all: §1.5 ships `script-src 'self'` with no nonce support,
 * because this is static hosting. A strict CSP with no hashes breaks the page
 * the moment anything emits an inline script — and the common Vite templates
 * ship one, for theme-flash prevention. So the hashes are computed at build
 * time and written into the header policy.
 *
 * This is **detection and accommodation, not prevention.** A hostile bundle
 * would carry its own matching hash. The actual containment is `connect-src`
 * naming the API origin and nothing else, plus `form-action 'none'`: a
 * substituted script still cannot ship the credential anywhere else.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";
import { buildCsp, cspMetaTag, htaccess } from "./csp";

/** `<script>` with no `src` is inline. Anything with a src is `'self'`. */
const INLINE_SCRIPT = /<script(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;

/**
 * HTML comments, removed before scanning.
 *
 * A `<script>` mentioned inside a comment is not a script, and a scanner that
 * reports one is worse than no scanner: the hash list feeds a security header,
 * so a false positive puts a bogus `'sha256-…'` in the CSP and teaches everyone
 * to trust output that is not describing reality. The prose in this project's
 * own `index.html` discusses inline scripts and trips a naive regex.
 */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

function base64Sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("base64");
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Rollup exposes emitted text two different ways: an `OutputAsset` has
 * `source`, an `OutputChunk` has `code`. Normalise both to a Buffer so the
 * caller does not have to care which it got.
 */
function emittedBytes(
  output: { source?: string | Uint8Array; code?: string },
): Buffer {
  if (output.source !== undefined) {
    return typeof output.source === "string"
      ? Buffer.from(output.source, "utf8")
      : Buffer.from(output.source);
  }
  return Buffer.from(output.code ?? "", "utf8");
}

export function assetAttestation(apiOrigin: string): Plugin {
  let outDir = "dist";
  let root = process.cwd();
  /** Collected in writeBundle, consumed by transformIndexHtml. */
  const inlineHashes = new Set<string>();

  return {
    name: "msout:asset-attestation",
    apply: "build",

    configResolved(config) {
      outDir = config.build.outDir;
      root = config.root;
    },

    /**
     * Inject the policy into the served HTML.
     *
     * This is the half that does not depend on the host. `.htaccess` is the
     * better mechanism — it covers `frame-ancestors` — but it needs
     * `mod_headers`, and whether a hosting platform has it is something to
     * check on the host rather than assume in a comment. A meta tag is honoured
     * with no server cooperation, so it is the floor.
     *
     * Injected at the *top* of `<head>`, before the module script, so the policy
     * is in force before anything on the page executes.
     */
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const policy = buildCsp({
          apiOrigin,
          hashes: [...inlineHashes],
          // frame-ancestors is discarded by the HTML parser in a meta tag and
          // only produces a console warning, so it is left to the header.
          header: false,
        });
        return html.replace(/<head([^>]*)>/i, `<head$1>\n    ${cspMetaTag(policy)}`);
      },
    },

    async writeBundle(_options, bundle) {
      const outRoot = path.resolve(root, outDir);

      // --- digests of every emitted asset -------------------------------
      //
      // Both Rollup output kinds. A `.js` entry point is a `chunk`, not an
      // `asset`, so filtering on `type === "asset"` alone digests the CSS and
      // the HTML and silently skips the only file that actually executes —
      // which would make the whole attestation vacuous where it matters most.
      const digests: string[] = [];
      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== "asset" && output.type !== "chunk") continue;
        const bytes = emittedBytes(output);
        digests.push(
          `${createHash("sha256").update(bytes).digest("hex")}  ${toPosix(fileName)}`,
        );
      }
      // Sorted so the manifest is byte-stable across machines and runs: a
      // diff in CI means a diff in output, not in iteration order.
      digests.sort();

      // --- hashes for inline scripts in the emitted HTML ----------------
      const htmlNames = Object.keys(bundle).filter(
        (name) => name.endsWith(".html"),
      );
      const hashes = new Set<string>();
      for (const name of htmlNames) {
        const output = bundle[name];
        if (!output || (output.type !== "asset" && output.type !== "chunk")) {
          continue;
        }
        const html = emittedBytes(output).toString("utf8").replace(
          HTML_COMMENT,
          "",
        );
        for (const match of html.matchAll(INLINE_SCRIPT)) {
          const inline = match[1];
          if (inline === undefined) continue;
          hashes.add(`'sha256-${base64Sha256(inline)}'`);
        }
      }

      // The header variant carries `frame-ancestors`, which the meta tag cannot.
      const headerCsp = buildCsp({
        apiOrigin,
        hashes: [...hashes],
        header: true,
      });

      // Write after the bundle so these files are not themselves digested.
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(outRoot, { recursive: true });

      // `.htaccess`, carrying the same policy as a response header plus the
      // non-CSP security headers.
      //
      // Written here rather than committed to the repository because
      // `connect-src` has to name the API origin this particular bundle was
      // built against. A committed `.htaccess` would be a second copy of a
      // security-relevant value that nothing keeps in step with the bundle —
      // the exact drift that would silently unbind the password route.
      await writeFile(path.join(outRoot, ".htaccess"), htaccess(headerCsp), "utf8");
      await writeFile(
        path.join(outRoot, "ASSETS.sha256"),
        digests.join("\n") + (digests.length ? "\n" : ""),
        "utf8",
      );
      await writeFile(
        path.join(outRoot, "CSP-HASHES.txt"),
        [...hashes].sort().join("\n") + (hashes.size ? "\n" : ""),
        "utf8",
      );

      this.info?.(
        `attested ${digests.length} asset(s), ${hashes.size} inline script hash(es)`,
      );
    },
  };
}

/**
 * The policy itself lives in `vite/csp.ts`, along with the origin validation
 * and the `.htaccess` rendering. It is exported from there rather than from this
 * file so the header, the meta tag and the tests all read one definition.
 */

/** Reads back what a previous build emitted. Used by the CI header assertion. */
export async function readAttestation(outDir = "dist") {
  const [assets, csp] = await Promise.all([
    readFile(path.join(outDir, "ASSETS.sha256"), "utf8"),
    readFile(path.join(outDir, "CSP-HASHES.txt"), "utf8"),
  ]);
  return {
    assets: assets.split("\n").filter(Boolean),
    hashes: csp.split("\n").filter(Boolean),
  };
}
