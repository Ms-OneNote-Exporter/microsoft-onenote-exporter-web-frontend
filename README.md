# microsoft-onenote-exporter-web-frontend

**Component A** of the `microsoft-onenote-exporter-web` design: the static
React build. It is a separate repository and a separate origin from the
backend, and that separation is load-bearing rather than cosmetic.

The design documents live in the backend repository under
[`PLANNING/`](https://github.com/Ms-OneNote-Exporter/microsoft-onenote-exporter-web-backend/tree/main/PLANNING)
and are cited by section number from this code. The two that matter here are
**PLAN-v3** (the current two-component design) and **PLAN-v2** (the SSE
contract, TTLs and rate limits it carries forward).

## What this component is, and is not

It serves the React build. That is the whole job.

**It holds no session state, no secret, no credential and no authorisation
logic.** It is not a tier in the trust chain. If it were fully compromised, the
attacker would gain the ability to serve arbitrary JavaScript to visitors, and
nothing else — the session secret is `HttpOnly` and every capability is
re-checked server-side.

**It never proxies, rewrites or forwards `/api/*`.** The credential `POST` goes
cross-origin from the browser straight to the backend. Nothing in this
repository parses, buffers, forwards or logs a credential. That property is the
single most important thing about the split; it is enforced by the absence of
backend code in this tree and asserted by tests `T-A1`, `T-A3` and `T-A4`.

## Why a separate repository

1. **CI secret separation.** The hosting platform runs our `npm install` and our
   build script, and its users can write the deploy directory directly. If the
   backend lived here, the `GHCR` push token and the VPS deploy key would sit in
   the same secret store as that build. Two repos means this workflow has no
   token to leak, because it is not in its scope.
2. **Repo layout is not deploy topology.** hPanel builds on push; the backend
   deploys on `compose pull && up`. Skew exists whatever the repository layout
   is, so the `apiProtocol` handshake is required either way. A monorepo would
   not remove it.
3. **Two claims stop being conventions.** "Never proxies `/api/*`" and "holds
   no authorisation logic" are true by construction when the backend source is
   not in the tree. Here they would be a review rule plus two greps.

## The build-time contract

Everything below is emitted by `vite/asset-attestation.ts` on every build:

| Artefact | Purpose |
|---|---|
| `dist/ASSETS.sha256` | sorted digest of **every** emitted file, chunks included. §7.1's attestation job compares it against the live deployment — and runs on a **schedule**, not only at deploy time, because a tampered bundle needs no code change. |
| `dist/CSP-HASHES.txt` | the `'sha256-…'` sources for any inline `<script>`, for merging into `script-src`. |

Builds are byte-deterministic, so a diff in the manifest means a real output
change rather than iteration-order noise.

`connect-src` naming the API origin **and nothing else** is what makes a static
host safe to type a Microsoft password into. Without it, an attacker who can
inject a script here exfiltrates the credential to any host. `form-action
'none'` removes form-based exfiltration. Together they bound a hostile bundle
to redirecting a user who retypes a password somewhere visible — social
engineering, not silent capture.

That is **containment, not prevention**, and the build attestation is
**detection**. Neither is oversold in the docs.

## Layout

```
src/lib/protocol.ts        EXPECTED_PROTOCOL + the build-time API origin
src/lib/api.ts             every request; the credential route; the boot handshake
src/lib/events.ts          cross-origin SSE, withCredentials, replay via Last-Event-ID
src/lib/session-secret.ts  client-side 256-bit secret + GUID generation
src/App.tsx                boot shell: handshake states, and the consent block
vite/asset-attestation.ts  the two build artefacts above
```

Three things in there are easy to get wrong and are commented as such:

- **`withCredentials: true` on the `EventSource`** (§6, `T-S4`). Without it the
  browser omits the cross-site cookie, every reconnect 401s, and the UI shows
  "reconnecting…" forever with nothing in the console. There is no error event
  for a 401 on an `EventSource`.
- **`credentials: "include"` on every fetch**, for the same reason.
- **`X-CSRF-Token` on every non-`GET`**, which forces a preflight — and a
  non-allowlisted origin therefore cannot cause a request body to be
  transmitted at all. That is the structural CSRF layer, and it is what makes
  `SameSite=None` on the backend survivable.

`EventSource` cannot send custom headers, which is why the CSRF token rides in
a readable cookie and why the session cookie must be `SameSite=None`. Ambient
credentials are what make the stream work; that is exactly why the CSRF header
check is load-bearing rather than hygiene.

## Deploying

hPanel: framework `vite`, Node LTS, build script `npm ci && npm run build`,
output `dist`, **entry file empty** — leaving the entry file empty is what
deploys the build as a static site with no Node server running.

The Node runtime is unusable for anything stateful here: the process is stopped
after an idle window, so an SSE hub, session state or rate-limit counters die
with it, and the filesystem is not a substitute under a platform that redeploys
to a new versioned directory per build. The one legitimate use is a stateless
file server whose only non-static job is emitting the §1.5 headers, and only if
`.htaccess` cannot set them (`Header always set` needs `mod_headers`, which
must be verified rather than assumed). That process still must never proxy
`/api/*` — `T-A3`.

## Local development

```sh
cp .env.example .env      # set VITE_API_ORIGIN
npm ci
npm run dev               # http://localhost:5173, talking to the backend origin
npm run build             # emits dist/ + the two attestation artefacts
```

`VITE_API_ORIGIN` must be an exact origin: `https:` in production, no path, no
trailing slash. There is deliberately no user-supplied base URL anywhere — that
would turn this origin into an open proxy and would let a substituted bundle
choose where the credential goes.

## Not built yet

This is a scaffold: the layout, the licence, the build-time contract, the API
client, the SSE client, the secret generator and the boot shell. The pages
themselves — landing, session, export flow, refresh restore — are §12 step 12,
and the hosting setup is step 13. The consent copy in `src/App.tsx` is
finished, because it is a claim made to the user and is asserted against the
rendered string (`T-F7`) rather than against a mechanism.

## Licence

MIT — see [`LICENSE`](./LICENSE) and [`NOTICE.md`](./NOTICE.md). This package
does **not** depend on the `@msout` browser-automation packages; it talks HTTP
only, and CI asserts that.
