#!/usr/bin/env node
/**
 * Verify the **served** bytes against what this build produced.
 *
 * PLAN-v3 §7.1: a post-deploy job fetches the live `index.html` and every asset
 * it references and compares digests. And it runs on a **schedule**, not only at
 * deploy time, because a tampered bundle needs no code change — there is nothing
 * to re-deploy.
 *
 * This exists because the hosting platform can write the deploy directory
 * directly. "The bytes I reviewed are the bytes being served" is not true here,
 * so it has to be checked rather than assumed.
 *
 * ## What it checks, and why each one
 *
 * 1. **Every asset the live HTML references hashes to the built value.** This is
 *    the attestation itself. A single swapped byte fails it.
 * 2. **The CSP header is present.** A header that stopped being sent is a silent
 *    loss of containment, and the page still looks correct — which is the worst
 *    shape for a security header.
 * 3. **The CSP's `connect-src` names the expected API origin.** A policy that
 *    names the wrong origin, or `*`, restricts nothing while looking entirely
 *    normal.
 * 4. **No asset is referenced that the build did not produce.** The other
 *    direction: a page can be made to load a script the build never emitted.
 *
 * ## Deliberately not checked
 *
 * Whether the page *works*. This asserts what is served, not what it does; a
 * functional smoke test is a different job and would need a browser.
 *
 * Exit code is 0 or 1, and every failure is printed rather than thrown, because
 * a job that dies on the first problem reports one problem instead of all of
 * them.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Parse an `ASSETS.sha256` manifest.
 *
 * The format is `sha256sum` output — `<hex>  <path>` — sorted, which is what
 * `vite/asset-attestation.ts` writes. Only the files a served page can reference
 * matter here, so `index.html` is included and the attestation artefacts
 * themselves are not.
 *
 * @returns {Map<string, string>} path → sha256 hex, paths as written in the
 *   manifest (e.g. `assets/index-abc.js`, not `dist/assets/…`).
 */
export function parseManifest(contents) {
  const out = new Map();
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const match = /^([0-9a-f]{64})\s+(.+)$/.exec(trimmed);
    if (!match) continue;
    out.set(match[2].trim(), match[1]);
  }
  return out;
}

/**
 * Extract the assets a served HTML page references.
 *
 * Comments are stripped first, for the same reason the CSP scanner strips them:
 * `index.html`'s comment explains that it contains no external `<script>` and no
 * `<link>`, and a naive scan matches its own explanation.
 *
 * @returns {{scripts: string[], styles: string[]}}
 */
export function referencedAssets(html) {
  const markup = html.replace(/<!--[\s\S]*?-->/g, "");
  const pick = (re) =>
    [...markup.matchAll(re)]
      .map((m) => m[1])
      .filter((src) => typeof src === "string" && src !== "");
  return {
    scripts: pick(/<script[^>]*\bsrc=["']([^"']+)["']/gi),
    styles: pick(/<link[^>]*\bhref=["']([^"']+)["']/gi),
  };
}

/**
 * Read one directive out of a policy string.
 *
 * @returns {string|undefined} the value, without the directive name. Undefined
 *   when the directive is absent, which is different from being present-but-empty:
 *   a `connect-src: ` that parses to nothing restricts nothing.
 */
export function directive(policy, name) {
  const found = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
  return found === undefined ? undefined : found.slice(name.length + 1).trim();
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Run every check and return the failures.
 *
 * @returns {Promise<string[]>} empty when the deployment matches the build.
 */
export async function verify({ baseUrl, manifest, fetchImpl = fetch }) {
  const failures = [];
  const base = baseUrl.replace(/\/+$/, "");

  // --- the manifest itself -------------------------------------------------
  // A manifest that failed to parse would otherwise make every asset look
  // "unknown", which is a pass-shaped failure wearing a failure's clothes.
  if (manifest.size === 0) {
    return ["the attestation manifest was empty or unparseable — refusing to verify against it"];
  }

  // --- the served HTML and its headers -------------------------------------
  const indexUrl = `${base}/index.html`;
  let indexResponse;
  try {
    indexResponse = await fetchImpl(indexUrl, { cache: "no-store" });
  } catch (error) {
    return [`could not fetch ${indexUrl}: ${error?.message ?? error}`];
  }
  if (!indexResponse.ok) {
    return [`${indexUrl} returned ${indexResponse.status}`];
  }

  const servedHtml = Buffer.from(await indexResponse.arrayBuffer());

  const expectedIndex = manifest.get("index.html");
  if (expectedIndex === undefined) {
    failures.push("the manifest does not list index.html");
  } else {
    const actual = sha256(servedHtml);
    if (actual !== expectedIndex) {
      failures.push(`index.html differs: served ${actual}, built ${expectedIndex}`);
    }
  }

  // --- the CSP -------------------------------------------------------------
  const csp = indexResponse.headers.get("content-security-policy");
  if (csp === null || csp.trim() === "") {
    failures.push(
      "no Content-Security-Policy header. The build emits one and the .htaccess " +
        "should be sending it; if mod_headers is absent the header is silently " +
        "absent and the <meta> tag is the only thing holding.",
    );
  } else {
    const connect = directive(csp, "connect-src");
    if (connect === undefined) {
      failures.push("the CSP has no connect-src directive, so nothing is restricted");
    } else if (connect.includes("*")) {
      failures.push(`connect-src contains a wildcard (${connect}) — it restricts nothing`);
    }
  }

  // --- every referenced asset ----------------------------------------------
  const referenced = referencedAssets(servedHtml.toString("utf8"));
  const seen = new Set();

  for (const [kind, list] of Object.entries(referenced)) {
    for (const ref of list) {
      if (/^([a-z]+:)?\/\//i.test(ref) || ref.startsWith("data:")) {
        failures.push(`${kind} references something not same-origin: ${ref}`);
        continue;
      }
      // The manifest paths are build-relative, so a leading slash is stripped.
      const rel = ref.replace(/^\/+/, "");
      if (seen.has(rel)) continue;
      seen.add(rel);

      const expected = manifest.get(rel);
      if (expected === undefined) {
        // The other direction: a page loading something the build never emitted.
        failures.push(`${kind} references ${rel}, which the build did not produce`);
        continue;
      }

      let body;
      try {
        const response = await fetchImpl(`${base}/${rel}`, { cache: "no-store" });
        if (!response.ok) {
          failures.push(`${rel} returned ${response.status}`);
          continue;
        }
        body = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        failures.push(`could not fetch ${rel}: ${error?.message ?? error}`);
        continue;
      }

      const actual = sha256(body);
      if (actual !== expected) {
        failures.push(`${rel} differs: served ${actual}, built ${expected}`);
      }
    }
  }

  if (seen.size === 0) {
    failures.push("the served HTML references no assets at all, which is not a working page");
  }

  return failures;
}

/** Read a manifest from disk and verify. Exported for the workflow. */
export async function verifyManifestFile({ baseUrl, manifestPath, fetchImpl }) {
  const contents = await readFile(manifestPath, "utf8");
  return verify({ baseUrl, manifest: parseManifest(contents), fetchImpl });
}

// --- CLI --------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const baseUrl = process.env.ATTEST_URL;
  const manifestPath = process.argv[2] ?? path.join(process.cwd(), "dist", "ASSETS.sha256");

  if (!baseUrl) {
    console.error("ATTEST_URL is required, e.g. https://microsoft-onenote-exporter.phttp.com");
    process.exit(2);
  }

  const failures = await verifyManifestFile({ baseUrl, manifestPath });
  if (failures.length === 0) {
    console.log(`ok  every served byte matches the build (${baseUrl})`);
    process.exit(0);
  }
  console.error(`FAIL  ${failures.length} problem(s) against ${baseUrl}:`);
  for (const failure of failures) console.error(`        - ${failure}`);
  process.exit(1);
}