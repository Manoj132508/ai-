# ADR 007: Fire-and-forget indexing, no job queue

**Status:** Accepted · **Phase:** 2

## Context

Indexing a 40-page PDF takes 20–30 seconds. Holding an HTTP connection open
that long invites proxy timeouts and leaves the user staring at a frozen page,
so the work must be asynchronous. The usual answer is a job queue (BullMQ and
Redis).

## Decision

Upload returns **202 Accepted** immediately. Node fires a request at the Python
service and does not wait; Python processes in a background task and posts back
to a callback endpoint when finished. `Document.status` is the source of truth,
and the client polls until it leaves `processing`.

No Redis, no queue.

## Consequences

**Positive.** No extra infrastructure to run, monitor, secure or explain.
Adequate for a single instance.

**Negative — and it needs a mitigation, not just a note.** If the Python
process dies mid-index, the document sits at `processing` forever; nothing will
ever move it. `Document.processingStartedAt` exists for this: a reaper marks
anything processing for more than ten minutes as `failed` with a retryable
message.

**Every async design needs a stuck-state reaper.** Omitting one is the classic
mistake — the happy path is tested, the crash path is discovered in production
by a user whose document never finished.

Also absent: retry with backoff, concurrency limits, and a dead-letter queue.

## Alternatives considered

- **BullMQ + Redis.** The right answer at multi-instance scale, and the
  documented upgrade path. Rejected now as infrastructure that would need
  running and defending for no current benefit.
- **Synchronous indexing.** Simplest, but 30-second requests and a frozen UI.
