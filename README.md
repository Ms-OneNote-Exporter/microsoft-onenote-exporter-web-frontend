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
| `dist/.htaccess` | §1.5's headers, with `connect-src` naming the API origin this bundle was built against. |

The policy is emitted twice, from the same `VITE_API_ORIGIN` as the bundle: as
the `.htaccess` header, and as a `<meta http-equiv>` in `index.html`. Both is
strictly safer than either — a `<meta>` policy needs no server cooperation, so it
holds even where `mod_headers` is unavailable, and multiple policies are
enforced as an intersection rather than last-one-wins. It is generated rather
than committed precisely so that `connect-src` cannot drift from the origin the
code actually talks to; that drift would silently unbind the password route.

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

## Outstanding questions

**These are open contract items, not a task list.** Each one is a decision the
backend owns. They are listed here rather than left in a comment because a
reader of this file cannot see the two repositories' correspondence, and the
code makes deliberate guesses that a reviewer needs to know are guesses.

### 1. Which origin serves `GET /files/:artifactId`?

The status snapshot's artifacts carry an optional `url`, and the frontend uses
it when present, falling back to a relative `/files/<id>`. So the answer is not
load-bearing *provided the backend sends the URL*.

Consequences differ and neither is free:

| | Relative (static host) | Absolute (API origin) |
|---|---|---|
| `download` attribute | honoured | ignored — browser navigates |
| Filename | server `Content-Disposition` | needs `Access-Control-Expose-Headers: Content-Disposition` |
| New CSP surface | none (`connect-src` unchanged) | none, same origin as the API |
| Host config | **Caddy must serve `/files/`** on the static root | none |

The risk asymmetry matters more than the table. If Caddy is not configured for
`/files/`, the failure is a 404 **after a completed export** — the worst moment
to discover it. If the backend simply sends `url`, none of this applies.

### 2. What are the §7.5 snapshot field names?

Guessed: `authenticated`, `signedIn`, `notebooks`, `export`.

Each field resolves through an alias list (`signed_in`, `isSignedIn`,
`runningExport`, `currentExport`, `job`, …) and `parseSessionStatus` returns
`matched`, recording which key satisfied each field.

**This mitigation is not free, and the cost is the important part:** an alias
table turns a loud failure into a quiet one. A typo in the backend's JSON now
produces a "signed in as false" page rather than a parse error. That is a worse
failure mode than the one it hides, and on a screen where a wrong read bounces a
user back to the credential form it is not obviously worth it.

Once the names are agreed the aliases should be deleted, and `matched` replaced
by a test asserting the canonical spelling is the one in use. If the backend
would rather have a hard failure on an unknown key, that is a one-line change
and probably the better default.

### 3. What are the notebook `state` values?

Only `loaded` and `failed` were ever specified. Rendered: `idle`, `listing`,
`loaded`, `failed`, and `unknown`. An unrecognised value shows a visible
"unrecognised notebook state" message naming the raw value.

The unknown branch is deliberate: mapping an unknown state to `idle` renders
"No notebooks listed yet", which is indistinguishable from a working empty
account — and a broken page nobody reports.

### 4. Is the SSE event set right?

The frontend listens for `notebooks-listed`, `export-started`,
`export-progress`, `export-ended`, `signed-in` and `session-ended`. Unmodelled
events are ignored rather than treated as an error, so a new backend event is
harmless — but an event the frontend needs under a different name is silent.

### 4. Where does the CSRF token come from?

**Settled: in the response body, not a cookie.**

The token used to be a readable `msout_csrf` cookie the page echoed into a header. That cannot work across origins — `document.cookie` only returns cookies scoped to the page's own origin, and the cookie was set host-only by the API origin — so every mutating request went out with an empty header and was refused with a bare `forbidden`.

Neither side's tests caught it. The backend's assert the token is *set and checked*; these assert the header is *present*. Both were true while the value could never arrive.

It now arrives in a response body, which a foreign origin cannot read — CORS lets a non-allowlisted origin *trigger* a request but not read the response. That is the same property that made the cookie safe, and it is why body delivery is safe here.

Two things the backend has to provide:

- `POST /api/session` returns `{ csrfToken }` in its body.
- `GET /api/session/status` returns `csrfToken` as well. **This is not optional redundancy:** the token is held in memory, so a page reload would otherwise lose it and every mutating route would refuse. `/api/session/status` is already fetched on every load, so this costs no extra round trip and no new route.

The alternative was `Domain=.phttp.com` on the cookie, which the shared registrable domain would have allowed. Rejected because it widens the token's visibility to every subdomain on `phttp.com` — including a message bus — where returning it in a body removes the readable cookie entirely.

If a session exists but no token arrives, the page says so and withholds the forms rather than submitting requests that would be refused with no explanation.

### 5. Does the backend ever want a client-side password trim?

No, and it should not. `<input type="password">` runs the HTML value
sanitization algorithm: browsers strip **every** CR and LF before React sees the
value, so `"hunter\n2"` arrives as `"hunter2"`. An earlier version of the
credential form tried to detect a trailing paste newline and ask the user to
confirm a trimmed value; that was unreachable code and was removed.

The consequence is a real limitation rather than a bug to fix: a user whose
password genuinely contains a newline is signed in with a different password and
sees an ordinary rejection. Nothing in this repository can prevent it.

## Layout

```
src/lib/protocol.ts        EXPECTED_PROTOCOL + the build-time API origin
src/lib/api.ts             every request; the credential route; the boot handshake
src/lib/events.ts          cross-origin SSE, withCredentials, replay via Last-Event-ID
src/lib/session.ts         snapshot types + tolerant parsers (see Outstanding questions)
src/lib/useEventStream.ts  the SSE transport as React state
src/lib/session-secret.ts  client-side 256-bit secret + GUID generation
src/App.tsx                boot shell, view selection, SSE event handling
src/pages/Consent.tsx      the disclosure (T-F7 asserts this, against rendered text)
src/pages/SessionCreate.tsx  GUID entry, "generate for me", unrecoverable warning
src/pages/Credential.tsx   the password form; sends the value byte-for-byte
src/pages/NotebookPicker.tsx  chooser, export progress, artifact downloads
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

hPanel: framework `vite`, Node LTS, build script `npm run build`, output
`dist`, **entry file empty** — leaving the entry file empty is what
deploys the build as a static site with no Node server running.

The Node runtime is unusable for anything stateful here: the process is stopped
after an idle window, so an SSE hub, session state or rate-limit counters die
with it, and the filesystem is not a substitute under a platform that redeploys
to a new versioned directory per build. The one legitimate use is a stateless
file server whose only non-static job is emitting the §1.5 headers, and only if
`.htaccess` cannot set them (`Header always set` needs `mod_headers`, which
must be verified rather than assumed). That process still must never proxy
`/api/*` — `T-A3`.

### hPanel settings

| Setting | Value | Why |
|---|---|---|
| Framework preset | `Vite` | — |
| Branch | `main` | — |
| Node version | `22.x` | must resolve to **22.12.0 or later** — vitest 5's floor. hPanel's `22.x` resolves to current 22.x, which is fine. |
| Root directory | `./` | **`vite.config.ts` and `package.json` are at the top level.** Picking `src` or `vite` breaks the build. |
| Build command | `npm run build` | runs `tsc -b && vite build`, so a type error fails the build |
| Package manager | `npm` | matches `package-lock.json` |
| Output directory | `dist` | matches `build.outDir` |
| Environment variable | `VITE_API_ORIGIN` | **required** — the build refuses without it |
| Startup file | *empty* | static site, no Node process |

Changing the API origin is one environment variable and a redeploy. There is
deliberately no runtime config endpoint and no in-app setting — see "no
user-supplied base URL" above for why that would be a hole rather than a feature.

### Verify after the first deploy

These are checks against the **served** site. The build is attested locally;
whether the host honours what it emits is a separate question, and the one that
decides whether this deployment is contained at all.

1. **Is the CSP actually being sent?**
   `curl -sI https://<frontend-host>/ | grep -i content-security-policy`
   - Present → `frame-ancestors` is enforced as well.
   - Absent → `.htaccess` was ignored and the `<meta>` tag is the only thing
     holding. Confirm it is in the served HTML
     (`curl -s https://<frontend-host>/ | grep -o 'Content-Security-Policy'`)
     before treating the deployment as contained.
   - **Neither → this is an uncontained Microsoft password input.** Do not let
     anyone use it.
2. **`connect-src` names the API origin and nothing else.** A policy containing
   `*` or a bare scheme is not the policy this build emits.
3. **No Node process is running.** A long-lived process here can only be
   accumulating state that dies on the idle timeout.
4. **`/files/` resolves.** Downloads assume the static host serves this path; a
   404 here means artifacts are unreachable after a completed export. See
   Outstanding questions.

`mod_headers` cannot be verified from here, which is why both a header and a
meta tag are emitted. `vite/csp.ts` documents which directives survive on each
path — `frame-ancestors` reaches the browser only through the header, so
clickjacking protection is the one control that depends on the host cooperating.

## Local development

### Node version

`engines.node` is `>=22.12.0`, and the `.0` matters.

**Not because of the build.** Vite 6 and TypeScript are happy on any 22.x — the
build works on 22.0. The floor is set by **vitest 5, which requires
`^22.12.0 || ^24 || >=26`**. So `npm test` would fail on 22.0–22.11 while
`npm run build` succeeded, which is the worst shape: a declared floor part of the
project honours and part of it does not.

Found by reading each dependency's own `engines` field rather than trusting the
range — after the same class of bug appeared in the api repository, where a
declared `>=22.5` turned out to be a floor that could not load its own database
driver, and which 463 passing tests never caught because every test ran on the
developer's current Node. **A test suite can only verify a version claim by
running on the version claimed.**

```sh
cp .env.example .env      # set VITE_API_ORIGIN — the build refuses without it
npm ci
npm run dev               # http://localhost:5173, talking to the backend origin
npm run build             # emits dist/ + .htaccess + the two attestation artefacts
npm run typecheck
npm test
```

`VITE_API_ORIGIN` must be an exact origin: `https:` in production, no path, no
trailing slash. There is deliberately no user-supplied base URL anywhere — that
would turn this origin into an open proxy and would let a substituted bundle
choose where the credential goes.

## Status

The pages are built (§12 step 12): session creation, the credential form, the
notebook chooser with export progress, and refresh-restore off the status
snapshot. The consent copy is finished, because it is a claim made to the user
and is asserted against the rendered text (`T-F7`) rather than against a
mechanism.

Two items from §12 step 12 remain:

- **Hosting setup is step 13** and is not done. In particular `/files/` routing
  on the static host is unconfirmed — see Outstanding questions.
- **No end-to-end run against a real backend.** Every test in this repository
  runs against stubs. There is no equivalent here to the fake-Docker-daemon smoke
  test on the backend side, which is a real gap: a mocked `fetch` cannot tell you
  that a route is missing, that a cookie is not being set, or that CORS refuses
  a preflight. The first run against a live backend should be expected to find
  something.

### Tests

`npm test` — 80 tests. Those cited by ID elsewhere in this file are real and
named in the test sources:

| ID | Asserts | File |
|---|---|---|
| `T-A1` | the credential is never parsed, forwarded, retried or cached | `src/lib/api.test.ts` |
| `T-A3` | no proxying; the origin comes from the build-time constant | `src/lib/api.test.ts` |
| `T-A4` | `API_ORIGIN` is an exact origin (it also lands in `connect-src`) | `src/lib/api.test.ts` |
| `T-S4` | `withCredentials: true` on the `EventSource` | `src/lib/events.test.ts` |
| `T-F2` | the served HTML references nothing external | `src/pages/consent.test.tsx` |
| `T-F7` | the consent copy, against rendered text | `src/pages/consent.test.tsx` |
| `T-F5` | the four boot states, incl. the version-mismatch screen | `src/App.test.tsx` |

Two bugs were found by writing these: the credential route was JSON-encoding the
password (`"hunter2"` on the wire, quotes included), and `abort()` was
interpolating an unencoded export id. Both are fixed in
[`68089f5`](https://github.com/Ms-OneNote-Exporter/microsoft-onenote-exporter-web-frontend/commit/68089f5).

## Licence

MIT — see [`LICENSE`](./LICENSE) and [`NOTICE.md`](./NOTICE.md). This package
does **not** depend on the `@msout` browser-automation packages; it talks HTTP
only, and CI asserts that.
