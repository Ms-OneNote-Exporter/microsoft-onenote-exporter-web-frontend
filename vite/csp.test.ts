/**
 * The Content-Security-Policy.
 *
 * `connect-src` is the load-bearing directive in this design. It names the API
 * origin and nothing else, and that is what makes a static host safe to type a
 * Microsoft password into: without it, anyone who can inject a script here
 * exfiltrates the credential to any host, and the split between the two
 * repositories buys nothing.
 *
 * These tests are mostly about what the policy *refuses*. A CSP that fails open
 * is the worst shape of failure for a security header — the page loads, looks
 * fine, and restricts nothing — so the validation is asserted rather than
 * assumed.
 */
import { describe, expect, it } from "vitest";
import {
  assertExactOrigin,
  buildCsp,
  cspMetaTag,
  htaccess,
  SECURITY_HEADERS,
} from "./csp";

const ORIGIN = "https://one-backend.phttp.com";

/** Pull one directive out of a policy string. */
function directive(policy: string, name: string): string | undefined {
  return policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `))
    ?.slice(name.length + 1);
}

describe("assertExactOrigin", () => {
  it("accepts and normalises an exact origin", () => {
    expect(assertExactOrigin(ORIGIN)).toBe(ORIGIN);
    // Normalisation matters: the emitted policy must not differ from the value
    // the code compares against by differing in a trailing slash.
    expect(assertExactOrigin("https://one-backend.phttp.com/")).toBe(ORIGIN);
    expect(assertExactOrigin("  https://one-backend.phttp.com  ")).toBe(ORIGIN);
  });

  it("keeps a non-default port, which is part of the origin", () => {
    expect(assertExactOrigin("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("refuses a value with a path", () => {
    // A path in connect-src does not name an origin, so the directive would not
    // restrict what it claims to.
    expect(() => assertExactOrigin(`${ORIGIN}/api`)).toThrow(/no path/i);
  });

  it("refuses a wildcard", () => {
    // A wildcard allowlists every host, which is the same as no policy.
    expect(() => assertExactOrigin("https://*.phttp.com")).toThrow(/wildcard/i);
  });

  it("refuses a non-http scheme", () => {
    // data: and blob: in connect-src would allowlist the page itself.
    expect(() => assertExactOrigin("data:text/plain,x")).toThrow(/http/i);
  });

  it("refuses a query or fragment", () => {
    expect(() => assertExactOrigin(`${ORIGIN}?a=1`)).toThrow(/query/i);
    expect(() => assertExactOrigin(`${ORIGIN}#x`)).toThrow(/query/i);
  });

  it("refuses a value that is not a URL at all", () => {
    expect(() => assertExactOrigin("not a url")).toThrow(/not a valid URL/i);
    expect(() => assertExactOrigin("")).toThrow(/not a valid URL/i);
  });
});

describe("buildCsp", () => {
  const policy = buildCsp({ apiOrigin: ORIGIN });

  it("restricts connect-src to the API origin and nothing else", () => {
    // The assertion that matters. Note what is absent: no `*`, no `https:`, no
    // bare scheme that would match any host.
    expect(directive(policy, "connect-src")).toBe(`'self' ${ORIGIN}`);
  });

  it("names no other host anywhere in the policy", () => {
    // A wildcard in a different directive would not help an attacker who
    // controls a script but is worth ruling out explicitly.
    expect(policy).not.toContain("*");
  });

  it("forbids form submission, the route that needs no script", () => {
    // An attacker who cannot inject script can still submit a form pointing
    // anywhere. This is the directive that closes that.
    expect(directive(policy, "form-action")).toBe("'none'");
  });

  it("denies framing in the header variant", () => {
    expect(directive(policy, "frame-ancestors")).toBe("'none'");
  });

  it("omits frame-ancestors from the meta variant", () => {
    // The HTML parser discards it and browsers log a warning, so including it
    // would be noise that looks like a mistake.
    const meta = buildCsp({ apiOrigin: ORIGIN, header: false });
    expect(directive(meta, "frame-ancestors")).toBeUndefined();
  });

  it("keeps every other directive identical between the two variants", () => {
    // Otherwise the meta floor and the header would disagree about what is
    // allowed, and the weaker one wins wherever it applies.
    const header = buildCsp({ apiOrigin: ORIGIN, header: true });
    const meta = buildCsp({ apiOrigin: ORIGIN, header: false });
    const strip = (p: string) => p.replace(/;?\s*frame-ancestors 'none'/g, "");
    expect(strip(header)).toBe(strip(meta));
  });

  it("merges inline script hashes into script-src", () => {
    const withHash = buildCsp({
      apiOrigin: ORIGIN,
      hashes: ["'sha256-abc'"],
    });
    expect(directive(withHash, "script-src")).toBe("'self' 'sha256-abc'");
  });

  it("denies base-uri and object-src", () => {
    // `base-uri 'none'` stops a hostile base tag rewriting every relative URL.
    expect(directive(policy, "base-uri")).toBe("'none'");
    expect(directive(policy, "object-src")).toBe("'none'");
  });

  it("allows no data: or blob: in connect-src", () => {
    const cs = directive(policy, "connect-src");
    expect(cs).not.toContain("data:");
    expect(cs).not.toContain("blob:");
  });

  it("propagates origin validation rather than emitting a broken directive", () => {
    // A connect-src that does not parse restricts nothing, and the page still
    // loads — so this has to fail the build rather than the header.
    expect(() => buildCsp({ apiOrigin: "https://*.phttp.com" })).toThrow(
      /wildcard/i,
    );
  });
});

describe("cspMetaTag", () => {
  it("produces a meta tag the browser will parse", () => {
    const tag = cspMetaTag(buildCsp({ apiOrigin: ORIGIN, header: false }));
    expect(tag).toMatch(/^<meta http-equiv="Content-Security-Policy" content=".+"\s*\/>$/);
    expect(tag).toContain(ORIGIN);
  });

  it("cannot be terminated early by a quote in the policy", () => {
    // Not reachable from today's directive values, and that is the point: a
    // generated header is not a place to leave attribute escaping unchecked.
    const nasty = buildCsp({ apiOrigin: ORIGIN, header: false }).replace(
      "'self'",
      '"onload="alert(1)',
    );
    const tag = cspMetaTag(nasty);

    // Exactly four raw quotes: the http-equiv pair and the content pair. A
    // fifth would mean the attribute was terminated early.
    expect(tag.match(/"/g)).toHaveLength(4);
    // The injected payload survives only in escaped form.
    expect(tag).toContain("&quot;onload=&quot;alert(1)");
    expect(tag).not.toContain('"onload=');
  });
});

describe("htaccess", () => {
  const body = htaccess(buildCsp({ apiOrigin: ORIGIN }));

  it("sets the policy on every response, including errors", () => {
    // `always` rather than bare `Header set`: a CSP that vanishes on a 404 is
    // missing exactly when someone is probing the deployment.
    expect(body).toMatch(/Header always set Content-Security-Policy/);
  });

  it("is guarded by IfModule, so an absent mod_headers does not 500", () => {
    expect(body).toContain("<IfModule mod_headers.c>");
    expect(body).toContain("</IfModule>");
  });

  it("carries the security headers that are not CSP directives", () => {
    for (const name of Object.keys(SECURITY_HEADERS)) {
      expect(body).toContain(`Header always set ${name} `);
    }
  });

  it("does not reference a path", () => {
    // A stray `</IfModule>` or misplaced directive here would be an Apache
    // config error, and Apache's is to serve 500.
    expect(body).not.toMatch(/RewriteRule|RewriteCond|ProxyPass/i);
  });

  it("quotes the policy, which contains single quotes throughout", () => {
    // Single quotes inside a double-quoted Apache argument are literal, so
    // `default-src 'self'` needs no escaping — but the policy must still be one
    // quoted argument, not several.
    expect(body).toContain(`Content-Security-Policy "default-src 'self'; script-src`);
    const line = body.split("\n").find((l) => l.includes("Content-Security-Policy"))!;
    expect(line.split('"')).toHaveLength(3);
  });

  it("names the API origin, so the policy cannot drift from the bundle", () => {
    expect(body).toContain(ORIGIN);
  });
});