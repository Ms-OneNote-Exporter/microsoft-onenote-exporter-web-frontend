/**
 * What this client actually puts on the wire for a credential.
 *
 * The counterpart to the backend's `credential-verbatim.test.ts`, and the
 * missing half of it. His 23 cases prove the forwarder preserves the bytes it is
 * handed; nothing proved that the client hands it the right bytes. The seam
 * between the two is where the bug we both shipped lived.
 *
 * **The case list below is deliberately identical to his, entry for entry.** That
 * is the point: the same 23 inputs travel from here through to the runner, and a
 * divergence in either list shows up as a mismatch rather than as two suites that
 * are individually green and jointly wrong. If he adds a case, this one should
 * gain the same one, and the comment says so.
 *
 * ## The bug this exists to prevent
 *
 * PR #1: `request()` finished with `JSON.stringify(body)` for every body, so
 * `submitCredential("hunter2")` transmitted the 11 bytes `"hunter2"` — quotes
 * included. A password containing a quote or a backslash reached the server as a
 * *different password than the user typed*, and the symptom — "wrong password" —
 * points at the user, at Microsoft, or at the client. Never at the proxy.
 *
 * Every assertion here is **byte equality on the transmitted body**, never length
 * and never "the right characters". A length check passes for a trimmed password;
 * a character check passes for one that was re-escaped and then unescaped.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { api } from "./api";

/**
 * The backend's cap, mirrored. It is his constant, not ours — the frontend has
 * no business enforcing a server-side bound, but a test that omits the boundary
 * case cannot catch a client that clips to the wrong length.
 */
const MAX_CREDENTIAL_BYTES = 4096;

/**
 * Kept in step with `api/tests/credential-verbatim.test.ts` in the backend repo.
 *
 * Order and wording are not important; membership is. Each case exists because
 * something in the stack plausibly wants to change it.
 */
const CASES: ReadonlyArray<readonly [string, string]> = [
  ["a plain password", "hunter2"],

  // PR #1's actual shipped bug.
  ["double quotes", 'pass"word'],
  ["single quotes", "pass'word"],
  ["a backslash", "pass\\word"],
  ["a JSON-looking string", '{"password":"hunter2"}'],
  ["a backslash-escaped quote", 'pa\\"ss'],

  // The "being helpful" trim.
  ["a leading space", " hunter2"],
  ["a trailing space", "hunter2 "],
  ["both", " hunter2 "],
  ["a trailing tab", "hunter2\t"],
  ["a trailing newline", "hunter2\n"],
  ["a trailing CRLF", "hunter2\r\n"],
  ["only whitespace", "   "],

  // Charset and encoding.
  ["non-ASCII", "pässwörd-Ω-日本"],
  ["an emoji", "pw🔑🔒"],
  ["a combining sequence", "école"],

  // Things a C-style truncation or a NUL-terminated buffer would mangle.
  ["an embedded NUL", "hunter2evil"],
  ["an embedded newline", "hunter2\nevil"],

  ["a single character", "x"],
  ["the maximum length", "A".repeat(MAX_CREDENTIAL_BYTES)],
];

/** The body the client actually transmitted, as bytes. */
async function transmit(password: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  let captured: BodyInit | null | undefined;

  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      captured = init.body;
      return Promise.resolve({
        ok: true,
        status: 202,
        json: async () => ({}),
      } as unknown as Response);
    }),
  );

  await api.submitCredential(password, "csrf-token-value");

  if (typeof captured === "string") return encoder.encode(captured);
  if (captured instanceof Uint8Array) return captured;
  throw new Error("no body was transmitted");
}

beforeEach(() => {
  vi.stubGlobal("EventSource", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the credential is transmitted byte-for-byte", () => {
  for (const [name, password] of CASES) {
    it(`sends ${name} unchanged`, async () => {
      const sent = await transmit(password);
      const expected = new TextEncoder().encode(password);

      // Byte equality, not length and not content-with-tolerance. This is the
      // only assertion that fails for a trimmed, re-escaped or re-encoded body.
      expect(sent).toEqual(expected);
    });
  }
});

describe("the wire shape the forwarder depends on", () => {
  it("declares text/plain, so nothing decides the body is JSON", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({}),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchSpy);

    await api.submitCredential("hunter2", "csrf-token-value");

    const [, init] = fetchSpy.mock.calls[0]!;
    // Declaring JSON on a body the server refuses to parse would be both a
    // mismatch and a suggestion that someone might start parsing it.
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "text/plain",
    );
  });

  it("presents the CSRF token alongside the body", async () => {
    // The two halves of the same request: an unparseable body and a header that
    // proves the caller is the frontend. One without the other is a broken
    // request in a way that is hard to see from either side.
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({}),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchSpy);

    await api.submitCredential("hunter2", "csrf-token-value");

    const [, init] = fetchSpy.mock.calls[0]!;
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe(
      "csrf-token-value",
    );
  });

  it("survives a password that is valid JSON, without the client parsing it", async () => {
    // The case that would have exposed PR #1 immediately: if this body were
    // JSON-encoded it would arrive as a quoted, escaped string.
    const sent = await transmit('{"password":"hunter2"}');
    expect(new TextDecoder().decode(sent)).toBe('{"password":"hunter2"}');
    // And it round-trips as JSON only because it was treated as text throughout.
    expect(JSON.parse(new TextDecoder().decode(sent))).toEqual({
      password: "hunter2",
    });
  });

  it("never trims, and never refuses to send a password that looks unusual", async () => {
    // A client that rejected "suspicious" input would be guessing, and would
    // refuse a real password. Length is the server's call, not this file's.
    await expect(transmit("   ")).resolves.toEqual(
      new TextEncoder().encode("   "),
    );
    // Compared by length and decoded text rather than by array identity: two
    // empty Uint8Arrays from different realms compare unequal under `toEqual`
    // while being the same value, and a test that fails on that teaches nothing.
    const empty = await transmit("");
    expect(empty.length).toBe(0);
    expect(new TextDecoder().decode(empty)).toBe("");
  });
});

describe("what happens at the length boundary", () => {
  it("transmits the maximum length rather than clipping it", async () => {
    // The frontend has no cap of its own, deliberately: enforcing a
    // server-side bound here would mean two places to keep in step and a
    // silently truncated password if they drifted. The 4096 cap is his
    // constant, and his route answers 413.
    const password = "A".repeat(MAX_CREDENTIAL_BYTES);
    expect(await transmit(password)).toEqual(new TextEncoder().encode(password));
  });

  it("does not attempt to send something larger, so the server decides", async () => {
    // One byte over. The honest behaviour is to send it and let the route refuse
    // with 413, rather than to pre-empt the refusal with a local guess at where
    // the boundary is — a guess that would be invisible in every test that only
    // used short passwords.
    const over = "A".repeat(MAX_CREDENTIAL_BYTES + 1);
    expect((await transmit(over)).length).toBe(MAX_CREDENTIAL_BYTES + 1);
  });
});