/**
 * `T-F2` and `T-F7` — claims made about the build, and claims made to the user.
 *
 * Both were cited by ID in the README and in `index.html`'s comment, and
 * neither existed. They cover two things that break quietly and go unnoticed:
 *
 *  - `T-F2` — the served HTML references no external `<script>`, `<iframe>` or
 *    `<link>`. One CDN link breaks `script-src 'self'` and, worse, silently
 *    reintroduces the third-party JavaScript that the origin split exists to
 *    exclude.
 *  - `T-F7` — the consent copy says what actually happens.
 *
 * `T-F7` asserts against the rendered text of the component itself rather than
 * against a copy held in the test. A fixture copy keeps passing after the real
 * copy is weakened, which is the exact failure this is here to catch. The
 * assertions are per-claim rather than a whole-block snapshot for the same
 * reason: a reviewer reading a failing snapshot reads the diff, and can tell an
 * improvement from a regression.
 */
import { describe, expect, it, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Consent } from "./Consent";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let cached: string | undefined;

afterEach(() => {
  cleanup();
  cached = undefined;
});

/**
 * Rendered text of the consent block, whitespace-normalised.
 *
 * Rendered once and memoised: calling this repeatedly would mount a second copy
 * and every lookup would then be ambiguous. `cleanup` in `afterEach` releases it
 * between tests.
 */
function consentText(): string {
  if (cached !== undefined) return cached;
  render(<Consent onStarted={() => {}} />);
  const heading = screen.getByRole("heading", { name: /before you sign in/i });
  cached = (heading.closest("section")?.textContent ?? "").replace(/\s+/g, " ");
  return cached;
}

const html = readFileSync(join(ROOT, "index.html"), "utf8");

/**
 * The markup with comments stripped.
 *
 * `index.html`'s comment explains that no inline `<script>`, `<iframe>` or
 * `<link>` appears here — so a naive scan for those tags matches its own
 * explanation of why they are absent. Asserting on markup rather than on prose
 * is the difference between a test that means something and one that fails for
 * the wrong reason.
 */
const markup = html.replace(/<!--[\s\S]*?-->/g, "");

describe("T-F2: the served HTML pulls in nothing external", () => {
  it("has an index.html to assert against", () => {
    // A silently-empty read would make every assertion below vacuously pass,
    // which is how a deleted file turns into a green suite.
    expect(html.length).toBeGreaterThan(0);
  });

  it("references only same-origin scripts", () => {
    const srcs = [...markup.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/gi)].map(
      (m) => m[1]!,
    );

    // The module entry must exist, or this file proves nothing.
    expect(srcs.length).toBeGreaterThan(0);

    for (const src of srcs) {
      // `'self'` permits relative paths only. A protocol or a bare hostname is
      // third-party code running with the page's origin.
      expect(src).toMatch(/^\//);
      expect(src).not.toMatch(/^\/\//); // protocol-relative is still external
      expect(src).not.toMatch(/^https?:/i);
    }
  });

  it("references no external <link>", () => {
    const hrefs = [...markup.matchAll(/<link[^>]*\bhref=["']([^"']+)["']/gi)].map(
      (m) => m[1]!,
    );

    // The usual offender is a webfont CDN, which `style-src 'self'` forbids and
    // which is the first external reference anyone adds to fix typography.
    for (const href of hrefs) {
      expect(href).toMatch(/^\//);
      expect(href).not.toMatch(/^https?:/i);
    }
  });

  it("has no <iframe>", () => {
    expect(markup).not.toMatch(/<iframe/i);
  });

  it("has no inline event handlers", () => {
    // Each would require `'unsafe-inline'` in `script-src`, which the deployed
    // policy deliberately does not have.
    expect(markup).not.toMatch(/\son[a-z]+\s*=/i);
  });

  it("has no inline <script> body", () => {
    // An inline body needs a CSP hash. `index.html` states there is none
    // deliberately, so any inline body is a regression — and the common Vite
    // template's theme-flash script is exactly what will reintroduce one.
    for (const [, body] of markup.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      expect((body ?? "").trim()).toBe("");
    }
  });

  it("mounts React into #root, which is the only thing the page renders", () => {
    expect(markup).toContain('id="root"');
  });
});

describe("T-F7: the consent copy, as rendered", () => {
  it("states the service is unofficial", () => {
    expect(consentText()).toMatch(/unofficial/i);
    expect(consentText()).toMatch(/not affiliated with or endorsed by microsoft/i);
  });

  it("states that a Microsoft account AND password are typed into the page", () => {
    // The single most important sentence on the page. If it goes, the service
    // collects a credential without having said so.
    //
    // **Both halves, deliberately.** The form asks for an account as well as a
    // password, and a disclosure naming only the password is inaccurate about
    // what this service collects — which is the failure this assertion exists to
    // catch, and it is exactly what the copy said before the account field
    // existed.
    expect(consentText()).toMatch(/microsoft account and password/i);
  });

  it("states that neither is parsed, logged or written to disk", () => {
    // The three containment claims. Overstating them is as much a disclosure
    // failure as understating them.
    expect(consentText()).toMatch(/without being parsed, logged or written to disk/i);
  });

  it("says accepting Microsoft consent changes the user's account", () => {
    // The load-bearing correction. `microsoft-webauth` auto-accepts consent
    // pages, and accepting the Services Agreement genuinely alters the account.
    // Saying only that it "accepts prompts" undersells a real change.
    expect(consentText()).toMatch(/changes your account/i);
    expect(consentText()).toMatch(/terms you are bound by/i);
  });

  it("offers the local exporter as an alternative where no password leaves the machine", () => {
    expect(consentText()).toMatch(/use the local exporter instead/i);
    expect(consentText()).toMatch(/microsoft-onenote-exporter/);
    expect(consentText()).toMatch(/no password leaves it/i);
  });

  it("says they are gone when the session is erased", () => {
    expect(consentText()).toMatch(/gone when you erase your session/i);
  });

  it("does not promise the password is never seen by anyone", () => {
    // Guards against copy that drifts into being reassuring rather than true.
    // The backend *does* hold the password in memory to drive the sign-in; the
    // true claim is that it is not parsed, logged or stored.
    const text = consentText();
    expect(text).not.toMatch(/never (?:see|touch|receiv)/i);
    expect(text).not.toMatch(/anonymous/i);
  });
});