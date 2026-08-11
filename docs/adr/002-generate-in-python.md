# ADR 002: Generate the LLM answer in the Python service

**Status:** Accepted · **Phase:** 2

## Context

Given ADR 001, the LLM call could live in either service. Calling Claude is an
authenticated HTTPS request with a JSON body; the Anthropic SDK is equally
capable in TypeScript and Python, and Node is arguably better at streaming.
The library argument that justified ADR 001 does **not** apply here.

## Decision

The Python service performs the LLM call, immediately after retrieval, and
streams the answer back to Node as SSE. Node proxies that stream to the
browser.

## Consequences

**Positive.** *Context locality* — the retrieved chunks are the largest payload
in the system (five chunks of ~800 characters, per question). Generating in
Python means they never cross the network a second time. *Secret surface* —
`ANTHROPIC_API_KEY` exists in exactly one process, so there is one place to
store, rotate and audit it. Node never sees it.

**Negative.** Node must proxy an SSE stream it does not produce. That means
handling backpressure, propagating client disconnects upstream so token
generation stops when nobody is listening, and mapping an error that arrives
*after* headers are sent — where a 503 is no longer possible. The error
handler's `res.headersSent` branch exists solely because of this decision.

## Alternatives considered

- **Node calls Claude with chunks returned from Python.** Simpler streaming,
  but doubles transfer of the largest payload and puts the API key in a
  second, internet-facing process.
