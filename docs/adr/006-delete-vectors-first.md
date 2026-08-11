# ADR 006: Delete vectors before the Mongo record

**Status:** Accepted · **Phase:** 3

## Context

Deleting a document touches two stores with no distributed transaction between
them (ADR 004). Either write can fail after the other succeeds, so the system
must choose which inconsistency it would rather be left with.

## Decision

**Always delete the Chroma vectors first, then the MongoDB record.** If the
second step fails, the document is marked `failed` with a retryable message
rather than reported as deleted.

## Consequences

The ordering is chosen by comparing the two failure states:

| Order | If step 2 fails | Verdict |
|---|---|---|
| Mongo first | Orphaned vectors stay searchable. A user is shown content from a document they deleted, cited to a record that no longer exists. | Unacceptable — deletion silently did not delete |
| **Chroma first** | The document row survives with no vectors. It appears in the list and contributes nothing to answers. | Recoverable — retry the delete, or re-index |

**Fail toward the safer state.** A visible, inert record is a far better
outcome than invisible, live data the user believes is gone. Both steps log
under the request ID so a partial delete is diagnosable.

## Related

Re-indexing must be **delete-by-prefix then insert**, never `upsert`. If a
chunker change reduces the chunk count, upsert overwrites the first *N* IDs and
leaves the remainder as stale orphans that stay searchable indefinitely.
Deterministic IDs (ADR 005) make the prefix delete cheap.

## Alternatives considered

- **Two-phase commit / saga with compensation.** Correct, and far beyond what
  a single-instance application with a retry button needs.
- **Soft delete in Mongo, purge asynchronously.** Reasonable, but adds a
  `deletedAt` filter to every query — one forgotten filter resurrects data.
