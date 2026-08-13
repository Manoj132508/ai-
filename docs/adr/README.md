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
| [010](010-csrf-double-submit.md) | Double-submit cookie for CSRF | 8 | Accepted |
| [011](011-provider-neutral-generation.md) | Provider-neutral generation, Ollama by default | 10 | Accepted |
| [012](012-rate-limiting.md) | In-memory fixed-window rate limiting, three tiers | 11 | Accepted |
| [013](013-read-model-performance.md) | Read-model `.lean()` boundary and index-backed sorts | 13 | Accepted |
| [014](014-deployment-topology.md) | Containerized deployment topology | 14 | Accepted |
| [015](015-threshold-held-out-tuning.md) | Retrieval threshold kept at 0.35 after held-out tuning | post | Accepted |
