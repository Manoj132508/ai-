# ADR 004: Chunk text lives only in Chroma

**Status:** Accepted · **Phase:** 3

## Context

Each indexed document becomes many chunks, each with text, an embedding and
metadata (document, page, offsets). That data could live in MongoDB, in Chroma,
or in both.

## Decision

Chunk text, embedding and metadata live **only in Chroma**. MongoDB stores
application state — users, knowledge bases, documents, conversations — plus
`chunkCount` as a denormalised convenience. There is no `Chunk` collection.

## Consequences

**Positive.** One source of truth per fact. A retrieval result already carries
everything a citation needs (document name, page, snippet, score), so rendering
citations requires no second lookup.

**Negative.** No transaction spans the two stores, so deletion has to choose
which inconsistency it prefers — see ADR 006. Chunk text cannot be queried with
Mongo operators; anything needing that must go through Chroma.

**Coupling worth noting:** this decision depends on ADR 005's deterministic
chunk IDs. With random UUIDs, something would have to record which IDs belong
to which document — and that something would be the `Chunk` collection this ADR
removes. The two decisions hold each other up.

## Alternatives considered

- **Chunks in both stores.** Enables Mongo-side queries but creates two copies
  of the same text that drift on re-index.
