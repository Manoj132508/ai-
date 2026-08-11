# ADR 003: Store the session JWT in an httpOnly cookie

**Status:** Accepted · **Phase:** 2

## Context

The SPA needs an authenticated session. The two common options are a token in
`localStorage` attached via an `Authorization` header, or a cookie set by the
server.

## Decision

A JWT in a cookie marked `httpOnly`, `Secure` and `SameSite=Strict`.

## Consequences

**Positive.** JavaScript cannot read the token, so an XSS vulnerability — a
third-party script, a compromised dependency — cannot exfiltrate the session.
With `localStorage`, one `<script>` is game over. The browser also attaches the
cookie automatically, so no client code can forget to.

**Negative.** Cookies are sent automatically, which is what makes CSRF
possible; `SameSite=Strict` is the mitigation, and any future cross-site flow
would need a token as well. Cross-origin requests need
`Access-Control-Allow-Credentials`, and the CORS specification forbids pairing
credentials with a wildcard origin — so `CORS_ORIGINS` must stay an explicit
allowlist.

**Downstream effect:** the Vite dev server proxies `/api` to the API precisely
to protect this decision. Without the proxy the browser hits cross-origin
cookie rules on day one, and the tempting "fix" is to move the token to
`localStorage`, silently undoing it. Verified in Phase 6: a relative `fetch`
from the SPA returns no `Access-Control-Allow-Origin` header, because the
request is genuinely same-origin.

## Alternatives considered

- **`localStorage` + `Authorization` header.** Simplest, immune to CSRF,
  fully exposed to XSS. Rejected: XSS is the more likely failure.
- **Short-lived token in memory + refresh cookie.** Strictly better, but adds
  a refresh endpoint, rotation and race handling for little gain at this scale.
