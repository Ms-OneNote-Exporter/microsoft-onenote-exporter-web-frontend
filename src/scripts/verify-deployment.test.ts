/**
 * The attestation script's logic, tested offline.
 *
 * The script's real job is comparison, and the comparisons that matter are the
 * ones that must **fail**. A verifier whose failure paths are untested is a
 * verifier that reports success until the day it does not — and this one's
 * failure mode is a tampered deployment, which is exactly the thing nobody is
 * looking for.
 *
 * Every "detects" test below asserts a failure is reported. That is the
 * assertion worth having here, not the passing case.
 */
import { describe, expect, it, vi } from "vitest";
import {
  parseManifest,
  referencedAssets,
  directive,
  verify,
} from "../../scripts/verify-deployment.mjs";
import { createHash } from "node:crypto";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const INDEX_HTML = `<!doctype html>
<html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'" />
<script type="module" src="/assets/index-ABC.js"></script>
<link rel="stylesheet" href="/assets/index-ABC.css">
</head><body><div id="root"></div></body></html>`;

const JS = "console.log('app');\n";
const CSS = ":root{--fg:#1a1a1a}\n";

const MANIFEST = new Map([
  ["index.html", sha256(INDEX_HTML)],
  ["assets/index-ABC.js", sha256(JS)],
  ["assets/index-ABC.css", sha256(CSS)],
]);

const CSP = "default-src 'self'; connect-src 'self' https://one-backend.phttp.com; form-action 'none'";

/** A fetch stub serving the given path→body map. */
function serving(
  bodyByPath: Record<string, string>,
  { csp = CSP, indexHtml = INDEX_HTML }: { csp?: string | null; indexHtml?: string } = {},
) {
  return vi.fn(async (url) => {
    const path = String(url).replace("https://host.test", "");
    if (path === "/index.html") {
      return new Response(indexHtml, {
        status: 200,
        headers: csp === null ? {} : { "content-security-policy": csp },
      });
    }
    const body = bodyByPath[path];
    if (body === undefined) return new Response("nope", { status: 404 });
    return new Response(body, { status: 200 });
  });
}

const GOOD = { "/assets/index-ABC.js": JS, "/assets/index-ABC.css": CSS };

describe("parseManifest", () => {
  it("reads sha256sum output", () => {
    const m = parseManifest(`${"a".repeat(64)}  assets/x.js\n${"b".repeat(64)}  index.html\n`);
    expect(m.get("assets/x.js")).toBe("a".repeat(64));
    expect(m.size).toBe(2);
  });

  it("ignores blank lines rather than counting them as assets", () => {
    expect(parseManifest("\n\n").size).toBe(0);
  });
});

describe("referencedAssets", () => {
  it("finds scripts and stylesheets", () => {
    const { scripts, styles } = referencedAssets(INDEX_HTML);
    expect(scripts).toEqual(["/assets/index-ABC.js"]);
    expect(styles).toEqual(["/assets/index-ABC.css"]);
  });

  it("ignores tags mentioned inside a comment", () => {
    // index.html's comment explains that it contains no external <script> or
    // <link>. A scanner that reads its own explanation reports a phantom asset.
    const withComment = `<html><head><!-- no <link> or <script> here -->
      <script src="/a.js"></script></head></html>`;
    expect(referencedAssets(withComment).scripts).toEqual(["/a.js"]);
    expect(referencedAssets(withComment).styles).toEqual([]);
  });
});

describe("directive", () => {
  it("reports a directive that is not there as undefined", () => {
    expect(directive("default-src 'self'", "connect-src")).toBeUndefined();
  });

  it("treats a valueless directive as absent, because it is", () => {
    // `connect-src` with no value is invalid CSP: the browser discards the
    // directive entirely. So it restricts exactly as much as not writing it, and
    // reporting it as absent is the accurate answer rather than a convenience —
    // both mean "nothing is restricted here".
    expect(directive("connect-src;", "connect-src")).toBeUndefined();
  });

  it("reads a real directive", () => {
    expect(directive(CSP, "connect-src")).toBe("'self' https://one-backend.phttp.com");
  });
});

describe("a matching deployment", () => {
  it("reports nothing", async () => {
    expect(await verify({ baseUrl: "https://host.test", manifest: MANIFEST, fetchImpl: serving(GOOD) })).toEqual([]);
  });

  it("tolerates a trailing slash on the base URL", async () => {
    expect(await verify({ baseUrl: "https://host.test/", manifest: MANIFEST, fetchImpl: serving(GOOD) })).toEqual([]);
  });
});

describe("detects a tampered deployment", () => {
  it("a modified asset", async () => {
    const fetchImpl = serving({ ...GOOD, "/assets/index-ABC.js": "console.log('evil');\n" });
    const failures = await verify({ baseUrl: "https://host.test", manifest: MANIFEST, fetchImpl });
    expect(failures.join()).toMatch(/assets\/index-ABC\.js differs/);
  });

  it("a modified index.html", async () => {
    const fetchImpl = serving(GOOD, { indexHtml: INDEX_HTML.replace("<div id=\"root\">", "<div id=\"root\" onclick=\"x()\">") });
    const failures = await verify({ baseUrl: "https://host.test", manifest: MANIFEST, fetchImpl });
    expect(failures.join()).toMatch(/index\.html differs/);
  });

  it("a missing asset", async () => {
    const fetchImpl = serving({ "/assets/index-ABC.css": CSS });
    const failures = await verify({ baseUrl: "https://host.test", manifest: MANIFEST, fetchImpl });
    expect(failures.join()).toMatch(/index-ABC\.js returned 404/);
  });

  it("an injected script the build never produced", async () => {
    // The other direction: a page made to load something unmanifested.
    const fetchImpl = serving(GOOD, { indexHtml: INDEX_HTML.replace("</head>", '<script src="/assets/evil.js"></script></head>') });
    const failures = await verify({ baseUrl: "https://host.test", manifest: MANIFEST, fetchImpl });
    expect(failures.join()).toMatch(/which the build did not produce/);
  });
});

describe("detects a lost CSP", () => {
  it("a missing header", async () => {
    const fetchImpl = serving(GOOD, { csp: null });
    const failures = await verify({ baseUrl: "https://host.test", manifest: MANIFEST, fetchImpl });
    expect(failures.join()).toMatch(/no Content-Security-Policy header/);
  });

  it("a wildcard connect-src, which restricts nothing", async () => {
    const fetchImpl = serving(GOOD, { csp: "default-src 'self'; connect-src *; form-action 'none'" });
    const failures = await verify({ baseUrl: "https://host.test", manifest: MANIFEST, fetchImpl });
    expect(failures.join()).toMatch(/contains a wildcard/);
  });

  it("an absent connect-src", async () => {
    const fetchImpl = serving(GOOD, { csp: "default-src 'self'; form-action 'none'" });
    const failures = await verify({ baseUrl: "https://host.test", manifest: MANIFEST, fetchImpl });
    expect(failures.join()).toMatch(/no connect-src/);
  });
});

describe("refuses to verify against nothing", () => {
  it("an empty manifest is a failure, not a pass", async () => {
    // The failure mode that matters most: an unparseable manifest makes every
    // asset look unknown, and a verifier that reports "unknown assets" on a
    // healthy deployment gets muted within a week.
    const failures = await verify({ baseUrl: "https://host.test", manifest: new Map(), fetchImpl: serving(GOOD) });
    expect(failures.join()).toMatch(/empty or unparseable/);
  });

  it("an unreachable host", async () => {
    const failures = await verify({
      baseUrl: "https://host.test",
      manifest: MANIFEST,
      fetchImpl: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    expect(failures.join()).toMatch(/could not fetch/);
  });

  it("a page referencing nothing is not a passing page", async () => {
    const fetchImpl = serving(GOOD, { indexHtml: "<html><body>hello</body></html>" });
    const failures = await verify({ baseUrl: "https://host.test", manifest: MANIFEST, fetchImpl });
    expect(failures.join()).toMatch(/references no assets/);
  });
});