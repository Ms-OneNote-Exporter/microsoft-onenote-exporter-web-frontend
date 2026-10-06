# NOTICE

## License

This project is released under the **MIT License**. See [LICENSE](LICENSE) for
the full text.

## Commercial use

The MIT License grants anyone the right to use, copy, modify, merge, publish,
distribute, sublicense and sell copies of this software, including for
commercial purposes. **No permission is required, and none is withheld.**

This NOTICE cannot add conditions to the MIT License, and does not attempt to.
If you are reading this hoping it sets rules, it does not: the terms in
[LICENSE](LICENSE) are the terms.

**A courtesy request, not a restriction:** if you use this commercially, or build
on it in a way you make money from, please **let the author know** — an issue or
a note is welcome. This is a request out of interest in the project, not a
condition of use. Nobody can enforce it, and no licence condition depends on it.

## Attribution

The copyright notice and the MIT permission notice must be retained in all
copies or substantial portions of the Software. Keeping the author's name in
the files is the one real obligation MIT does impose, and it is why the author
field is populated in `package.json`.

## What this is

This is **Component A** of the `microsoft-onenote-exporter-web` design: the
static React build. It is a separate repository and a separate origin from the
backend on purpose, and the split is load-bearing rather than cosmetic.

Component A holds **no session state, no secret, no credential and no
authorisation logic**. It is not a tier in the trust chain. If it were fully
compromised, the attacker would gain the ability to serve arbitrary JavaScript
to visitors, and nothing else — because the session secret is `HttpOnly` and
every capability is re-checked server-side.

**It never proxies, rewrites or forwards `/api/*`.** The credential `POST` goes
cross-origin from the browser straight to the backend. Nothing in this
repository parses, buffers, forwards or logs a credential. That property is the
single most important thing about the split, and it is enforced by the absence
of backend code in this tree and asserted by tests `T-A1`, `T-A3` and `T-A4`.

## It displays a password field

Being the origin that renders the login form means this repository's deployed
bundle is the one users are asked to trust with a Microsoft account password.
Two consequences, both required rather than optional:

- **`connect-src` in the Content-Security-Policy names the API origin and
  nothing else.** This directive is what makes a static host safe to type a
  password into. Without it, an attacker who can inject a script here can
  exfiltrate the credential to any host. `form-action 'none'` removes
  form-based exfiltration. Together they bound what a hostile bundle can do to
  redirecting a user who retypes a password somewhere visible, which is social
  engineering rather than silent programmatic capture.
- **The build is attested.** The hosting platform runs our `npm install` and our
  build script, and its users can write the deploy directory directly, so the
  served bytes are not guaranteed to be the reviewed bytes. A digest manifest is
  produced at build time and checked against the live deployment on a schedule,
  not only at deploy time. That is detection, not prevention, and it is
  described as such rather than oversold.

The honest residual risk is stated in the backend's `NOTICE.md` and in
`PLANNING/PLAN-v3.md` §0.2 and §11: a service that replays Microsoft credentials
trains a habit that phishing thrives on. It is a product-level decision, not a
technical one.

## Dependencies

This package does **not** depend on the `@msout` browser-automation packages.
It talks HTTP only, and CI asserts that (`T-…`, PLAN-v3 §1.6). It depends on
nothing of the backend's source: the contract is the HTTP API, the SSE event
stream, the `apiProtocol` integer and the header policy.

## Third-party content

The Microsoft Q&A page preserved as
`docs/graphapi-sharepoint-notebook-limit-evidence.pdf` in
`microsoft-onenote-export-notebook` is **Microsoft's content, not this
project's**, and is quoted as evidence outside the MIT licence. Nothing from
that file is vendored into this repository.
