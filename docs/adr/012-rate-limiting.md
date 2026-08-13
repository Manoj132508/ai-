# ADR 012: In-memory fixed-window rate limiting

**Status:** Accepted · **Phase:** 11

## Context

Three surfaces need throttling. Login and register are the brute-force and
account-enumeration targets. The `ask` endpoint fans out to retrieval plus a
streamed LLM generation — the most expensive thing the API does, and the
easiest way for one caller to run up cost or starve others. Everything else
wants a loose backstop so a single IP cannot flood the whole API.

`RATE_LIMITED` (429) was reserved in the error taxonomy from the start
(section 2.6), so the response shape is already decided; what is open is the
mechanism.

## Decision

A hand-rolled **fixed-window** limiter, counting requests per client IP in an
in-memory `Map`, applied in three tiers:

| Tier   | Default        | Where                          |
| ------ | -------------- | ------------------------------ |
| global | 300 / 15 min   | app chain, after CORS          |
| auth   | 10 / 15 min    | `POST /auth/login`, `/register`|
| ask    | 15 / 1 min     | `POST /knowledge-bases/:id/ask`|

All limits are env-tunable. Rejections flow through the existing error handler
as the taxonomy's 429, and every response carries IETF-draft `RateLimit-*`
headers (plus `Retry-After` on a 429) so a client can back off before it is
refused. Keying by IP relies on `trust proxy` (ADR/­app.js) to see the real
client address in production.

No express-rate-limit, no Redis.

## Consequences

**Positive.** Zero new dependencies and zero new infrastructure. The whole
limiter is ~40 lines and defensible line by line. A per-minute `ask` tier caps
the expensive path independently of the loose global one.

**Negative — two limitations, both deliberate and bounded.**

1. **Boundary burst.** Fixed window lets a client send `max` at the end of one
   window and `max` at the start of the next, so up to `2*max` can land in a
   short span. Acceptable: these are abuse controls, not billing meters.

2. **Single-instance only.** Counters live in one process's memory. With N
   replicas the effective limit becomes `N*max`, and a restart clears every
   counter. The fix is a shared store — Redis `INCR` + `EXPIRE` — behind the
   same middleware contract, so it is a drop-in, not a rewrite. This is the
   documented scale path, mirroring the job-queue decision in ADR 007.

**IP keying is coarse.** Users behind one NAT share a bucket, and the `ask`
tier throttles a source address rather than an account. A per-user key is a
phase-14 refinement, once quotas exist.

**Disabled under `NODE_ENV=test`.** The integration suite fires many auth
requests from one loopback IP; an active limit would reject them. The limiter's
logic is covered directly in `tests/rateLimit.test.js` with `enabled: true` and
an injected clock, so the algorithm is tested without coupling to the wiring.

## Alternatives considered

- **express-rate-limit.** The usual choice and a good one. Rejected for a
  dependency-free implementation this small; at scale it would need the same
  Redis store anyway.
- **Sliding-window log / token bucket.** Removes the boundary burst at the cost
  of more memory and code for a guarantee abuse control does not need.
- **Locking the targeted account after N failures.** Rejected: an attacker
  could then lock any victim out on purpose — a denial-of-service against the
  user. Throttling the source IP does not have that failure mode.
