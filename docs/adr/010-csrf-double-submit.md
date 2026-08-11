# ADR 010: Double-submit cookie for CSRF

**Status:** Accepted · **Phase:** 8

## Context

ADR 003 puts the session in a cookie, which the browser attaches to requests
automatically — *including requests initiated by another site*. A form on
`evil.example` POSTing to our API arrives carrying the victim's session. That
is the entire CSRF class, and it exists **because** cookie auth is automatic.
The bearer-token alternative does not have this problem, but is readable by
XSS instead. Choosing cookies means owning CSRF.

## Decision

Two layers.

1. **`SameSite=Strict`** on the session cookie. The browser will not attach it
   to any cross-site request, so a forged request arrives unauthenticated.
2. **Double-submit token.** On login the server also sets a non-httpOnly
   `aika_csrf` cookie holding 32 random bytes. The client reads it and echoes
   it in `X-CSRF-Token` on every unsafe method. The server requires the two to
   match, compared with `timingSafeEqual`.

Safe methods (`GET`/`HEAD`/`OPTIONS`) are exempt. A `GET` that mutates is the
actual bug; CSRF-protecting it would hide that.

`register` and `login` are exempt too: there is no session to hijack and no
CSRF cookie to echo, so requiring one would make login impossible in a fresh
browser.

## Consequences

**Why the attacker cannot defeat it.** They can make the browser *send* our
cookies, but the same-origin policy stops their page *reading* them — so they
cannot produce the header. The browser also refuses to let a cross-origin page
set a custom header on a simple request, which forces a preflight our CORS
allowlist rejects.

**Why the CSRF cookie is deliberately readable.** It is not a credential.
Knowing it grants nothing; its only job is to prove the request came from a
page that could read our cookie.

**Why two layers when `SameSite=Strict` alone would do.** `SameSite` is a
browser-enforced policy: it is not applied by non-browser clients, and its
handling has varied across browser versions. A defence with one layer fails
completely the moment that layer has a gap.

**Cost.** Every mutating request needs the header, so all client traffic must
go through the API client that adds it — a call site using bare `fetch` will
fail with a confusing 403. `CSRF_INVALID` is **403, not 401**: the caller is
authenticated, so telling a client to re-authenticate would send it down a
path that cannot fix the problem.

## Verified

`npm test` covers a request with cookies but no header (403), a mismatched
header (403), and a GET without one (200). Also confirmed in a real browser:
`fetch('/api/auth/logout', {method:'POST', credentials:'include'})` — exactly
what a forged request achieves — returns 403 and the session survives.

## Alternatives considered

- **Synchroniser token.** Stronger, needs server-side session state, which
  discards the statelessness that motivated a JWT.
- **`SameSite=Strict` alone.** One layer.
- **Custom-header requirement only.** Relies entirely on preflight behaviour
  and a correct CORS allowlist; double-submit adds a secret the attacker must
  also guess.
