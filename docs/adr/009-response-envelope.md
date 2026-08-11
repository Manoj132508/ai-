# ADR 009: One response envelope and a closed error taxonomy

**Status:** Accepted · **Phase:** 6

## Context

Without a convention, an API accumulates shapes: a bare array here, a bare
object there, `{ message }` on one error and `{ error: "..." }` on another. The
client ends up with bespoke parsing per endpoint, and error handling becomes
string matching on prose.

## Decision

**Every** response carries `{ success, data, error }`. `error` is `null` on
success, `data` is `null` on failure, and neither key is ever absent. Errors
carry a `code` from a closed registry mapping each to exactly one HTTP status
and one user-safe message.

The client switches on `error.code`. Messages are prose and will be reworded;
codes are the contract.

## Consequences

**Positive.** One shape to parse. Rewording a message is not a breaking change.
A typo'd code throws at construction rather than becoming a silent 500. `404`
for another user's resource is expressible as a first-class code, so the
IDOR-safe behaviour is the default rather than something each route remembers.

**Negative.** Slightly more verbose than returning a bare object. Every new
failure mode requires a taxonomy entry — which is the intended friction: it
forces a decision about the status code and the user-facing wording at the time
the failure is introduced.

## The rule that makes it safe

Only `ApiError` messages reach the client. Anything else — a `TypeError`, a
driver failure — is replaced wholesale with a generic 500, because its message
may contain a path, a query or a credential. Verified in Phase 6: an error
whose message embedded a Mongo connection string with a password returned only
`"Something went wrong on our side."`, while the full detail was logged.

## Learned during implementation

Third-party middleware throws its own shapes. `express.json()` raises a
SyntaxError tagged `entity.parse.failed` on malformed JSON, which reached the
generic branch and became a **500** — blaming the server for a client's broken
request body, inflating the server-error rate and paging on-call for a user's
typo. Recognised shapes are now translated into the taxonomy before that branch.
Unrecognised ones must still fall through to 500: guessing that an unknown
error is the client's fault would hide real bugs behind 4xx nobody investigates.
