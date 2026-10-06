/**
 * Session credential generation, client-side (PLAN-v3 §4, §10 T9).
 *
 * This is *better* in a split-origin design, not worse: the frontend generates
 * the secret and posts it to the backend, so the frontend host never sees the
 * secret even in transit. The tradeoff is that a compromised frontend could
 * generate a weak one — which is why the API validates the length mechanically
 * instead of trusting the client, and why nothing here is security-critical
 * beyond the randomness itself.
 *
 * The GUID stays the identifier, the 256-bit secret is the credential, and
 * **neither ever appears in a URL**. The SPA route is a generic `/session`;
 * the GUID lives in the cookie's server-side lookup and in memory.
 */

/** 32 bytes -> 43 base64url characters, no padding. */
export const SECRET_LENGTH = 43;

/** Matches exactly 43 base64url characters and nothing else. */
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateSessionSecret(): string {
  const bytes = new Uint8Array(32);
  // Rejection sampling: `btoa` output must be base64url, so bytes >= 248
  // would produce `+` or `/` and are discarded rather than remapped. With
  // 256 possible values the loop terminates in about 1.03 iterations.
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  while (out.length < SECRET_LENGTH) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= 248) continue;
      out += alphabet[byte % 64];
      if (out.length === SECRET_LENGTH) break;
    }
  }
  return out;
}

/**
 * The same check the API performs, so the UI can fail before a round trip.
 * The server does not rely on this being called — it validates independently.
 */
export function isValidSessionSecret(value: string): boolean {
  return SECRET_PATTERN.test(value);
}

/**
 * 122 bits, never shortened. v2 accepted a bare GUID; under a cross-origin
 * `SameSite=None` cookie that is no longer tenable, which is why §13.1's
 * pre-launch blocker became a v1 requirement.
 */
export function generateSessionGuid(): string {
  return crypto.randomUUID();
}
