# ADR 001: Split Node and Python on the library boundary

**Status:** Accepted · **Phase:** 2

## Context

The application needs both a conventional web API (authentication, tenancy,
file storage, CRUD) and a RAG pipeline (PDF parsing, chunking, embeddings, a
vector store). The mature libraries for the second set — `pypdf`,
`sentence-transformers`, `chromadb` — are Python. The team's existing skills
cover both Node and Python.

## Decision

Two processes. **Node/Express** owns identity, tenancy, validation, file
storage and MongoDB. **Python/FastAPI** owns the pipeline. Node calls Python
over HTTP on `127.0.0.1` with a shared secret in `X-Internal-Key`.

Authorisation happens **once**, in Node. Python has no user model; it receives
an opaque `kb_id` and trusts that Node authorised the request.

## Consequences

**Positive.** Each service uses the best tooling for its job. The security
boundary is a single, auditable layer rather than checks scattered through the
pipeline. Either service can be scaled or replaced independently.

**Negative.** A second runtime to install, run and deploy. One extra network
hop on every AI request. A shared secret to manage and rotate.

**The load-bearing assumption:** Python's lack of authorisation is only safe
because it is unreachable from outside the host. If it is ever bound to
`0.0.0.0` or moved to another machine, this decision must be revisited before
anything else — see ADR 002 for the related credential surface.

## Alternatives considered

- **One Node service, calling Python as a subprocess.** Rejected: process
  spawn per request is slow, and the embedding model would reload each time.
- **One Python service, dropping Node.** Viable, but discards the Express and
  Mongoose experience this project is meant to demonstrate.
