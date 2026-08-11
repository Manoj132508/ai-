# Architecture Decision Records

Each file records one decision: the context that forced it, what was decided,
and what it costs. ADRs are immutable — a decision that changes is superseded
by a new record rather than edited, so the reasoning at the time survives.

| # | Decision | Phase | Status |
|---|---|---|---|
| [001](001-two-services.md) | Split Node and Python on the library boundary | 2 | Accepted |
| [002](002-generate-in-python.md) | Generate the LLM answer in the Python service | 2 | Accepted |
| [003](003-jwt-in-httponly-cookie.md) | Store the session JWT in an httpOnly cookie | 2 | Accepted |
| [004](004-no-chunk-collection.md) | Chunk text lives only in Chroma | 3 | Accepted |
| [005](005-local-embeddings.md) | Local MiniLM embeddings behind a provider interface | 3 | Accepted |
| [006](006-delete-vectors-first.md) | Delete vectors before the Mongo record | 3 | Accepted |
| [007](007-no-job-queue.md) | Fire-and-forget indexing, no job queue | 2 | Accepted |
| [008](008-retrieval-threshold.md) | Refuse to answer below a retrieval score threshold | 2 | Accepted |
| [009](009-response-envelope.md) | One response envelope and a closed error taxonomy | 6 | Accepted |
