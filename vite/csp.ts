/**
 * The Content-Security-Policy, and how it reaches the browser.
 *
 * §1.5's `connect-src` is the single load-bearing directive in this whole design:
 * it names the API origin and nothing else, and that is what makes a static host
 * safe to type a Microsoft password into. Without it, an attacker who can inject
 * a script here exfiltrates the credential to any host of their choosing, and
 * the split between the two repositories buys nothing.
 *
 * So the policy cannot be a hand-maintained header somewhere in a hosting panel
 * that nobody reviews. It is emitted here, from the same `VITE_API_ORIGIN` that
 * the bundle itself is built against, so the two cannot drift.
 *
 * ## Why both a header and a meta tag
 *
 * The deployment target is static hosting on a platform whose header support is
 * not verified. `.htaccess` needs `mod_headers`; whether it is present is
 * something to check on the host, not to assume. If the header silently fails
 * to apply, a CSP that exists only as a header is a CSP that is not there.
 *
 * A `<meta http-equiv="Content-Security-Policy">` is honoured by the browser
 * with no server cooperation at all, so it is emitted as a floor. Multiple
 * policies are enforced as an intersection rather than a last-one-wins merge,
 * so shipping both is strictly safer than shipping either — it cannot be
 * weakened by one of them failing.
 *
 * The one directive a meta tag cannot express is `frame-ancestors`: the HTML
 * parsing rules discard it, and browsers log a console warning when they see
 * it. It is therefore in the header variant only, which means clickjacking
 * protection depends on the host honouring `.htaccess`. That is stated rather
 * than papered over — it is the one part of §1.5 that the meta floor does not
 * cover.
 *
 * ## What this is and is not
 *
 * **Containment, not prevention.** A hostile bundle carries its own matching
 * hash and its own meta tag, so this does not stop a substituted build. The
 * build attestation (`ASSETS.sha256`) is the detection half.
 */

/** The directives that only a header can express. */
const HEADER_ONLY_DIRECTIVES = new Set(["frame-ancestors"]);

export interface CspOptions {
  /**
   * The API origin. Must be an exact origin — scheme, host, optional port, no
   * path, no trailing slash.
   */
  apiOrigin: string;
  /** `'sha256-…'` sources for inline scripts, already quoted. */
  hashes?: readonly string[];
  /**
   * Build the header variant, which may include `frame-ancestors`.
   *
   * Defaults to true. Pass false for the meta variant, where the directive is
   * discarded by the parser and only produces a console warning.
   */
  header?: boolean;
}

/**
 * An exact origin, or throw.
 *
 * This runs at build time rather than being left to the browser, because a
 * malformed value fails *open* in the worst possible way: a `connect-src` that
 * does not parse is a `connect-src` that does not restrict anything, and the
 * page still loads and looks fine. A build that refuses is a build that cannot
 * ship an unbounded policy by accident.
 *
 * Deliberately strict — no trailing slash, no path, no wildcard. A wildcard
 * would allowlist every host, which is the same as having no policy.
 */
export function assertExactOrigin(value: string): string {
  const trimmed = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `API origin is not a valid URL: ${JSON.stringify(value)}. ` +
        `Expected an exact origin such as https://api.example.com — no path, no trailing slash.`,
    );
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `API origin must be http: or https:, got ${JSON.stringify(parsed.protocol)}. ` +
        `A data: or blob: origin in connect-src would allowlist the page itself.`,
    );
  }

  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(
      `API origin must have no path, got ${JSON.stringify(parsed.pathname)}. ` +
        `A path in connect-src does not name an origin, so the directive would not restrict what it claims to.`,
    );
  }

  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error(
      "API origin must have no query string or fragment. " +
        "It is spliced into connect-src and a query would silently change the policy.",
    );
  }

  if (parsed.hostname.includes("*")) {
    throw new Error(
      "API origin must not contain a wildcard. A wildcard in connect-src " +
        "allowlists every host, which is the same as having no policy at all.",
    );
  }

  // Normalised, so the emitted policy cannot differ from what the code compares
  // against by differing in a trailing slash.
  return parsed.origin;
}

/**
 * buildCsp returns the §1.5 policy.
 *
 * `connect-src` is `'self'` plus the API origin — `'self'` because nothing in
 * this bundle fetches its own origin, but it costs nothing and keeps the
 * directive honest if that ever changes. `form-action 'none'` removes the
 * form-based exfiltration route, which is the one an attacker reaches without
 * needing script execution at all.
 */
export function buildCsp(options: CspOptions): string {
  const apiOrigin = assertExactOrigin(options.apiOrigin);
  const header = options.header ?? true;
  const hashes = options.hashes ?? [];

  const directives: [string, string][] = [
    ["default-src", "'self'"],
    ["script-src", ["'self'", ...hashes].join(" ")],
    ["style-src", "'self'"],
    ["img-src", "'self' data: blob:"],
    ["connect-src", `'self' ${apiOrigin}`],
    ["form-action", "'none'"],
    ["object-src", "'none'"],
    ["base-uri", "'none'"],
    ...(header ? ([["frame-ancestors", "'none'"]] as [string, string][]) : []),
  ];

  return directives
    .filter(([name]) => header || !HEADER_ONLY_DIRECTIVES.has(name))
    .map(([name, value]) => `${name} ${value}`)
    .join("; ");
}

/**
 * The remaining §1.5 response headers, which are not CSP directives.
 *
 * Kept together with the policy because they are the same argument: a page that
 * takes a password should not be embeddable, sniffable, or referrer-leaking.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  // HSTS is only meaningful over TLS and only if the host does not already send
  // it. Emitting it from a meta tag is impossible, so this one is header-only.
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
});

/**
 * htaccess returns the file, with the policy inline.
 *
 * `Header always set` rather than `Header set`, because `always` covers error
 * responses too — and a CSP that vanishes on a 404 is a CSP that is missing
 * exactly when someone is poking at the deployment.
 *
 * `mod_headers` is required. If it is absent, Apache logs an error and serves
 * the files *without any of these headers*, so the meta tag is what remains
 * holding the line. That is why both are emitted rather than either.
 */
export function htaccess(csp: string): string {
  const lines = [
    "# Generated by vite/asset-attestation.ts. Do not edit by hand.",
    "#",
    "# Emitted on every build so that connect-src cannot drift from the API origin",
    "# the bundle was actually built against.",
    "",
    "<IfModule mod_headers.c>",
    `    Header always set Content-Security-Policy "${csp}"`,
  ];
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    lines.push(`    Header always set ${name} "${value}"`);
  }
  lines.push("</IfModule>", "");
  return lines.join("\n");
}

/**
 * The meta tag, injected into `<head>`.
 *
 * A meta CSP is weaker than a header in one way that matters for this page: it
 * does not apply to anything fetched before the parser reaches it. That is
 * irrelevant here — there is no inline script, and the policy is in the served
 * HTML before any script runs. It is also weaker in the sense that it cannot
 * express `frame-ancestors`, which is why that directive is dropped.
 */
export function cspMetaTag(csp: string): string {
  // Double quotes are escaped so the attribute cannot be terminated early by a
  // value containing one. The directive values here cannot, but a generated
  // header is not a place to leave that unchecked.
  const escaped = csp.replace(/"/g, "&quot;");
  return `<meta http-equiv="Content-Security-Policy" content="${escaped}" />`;
}