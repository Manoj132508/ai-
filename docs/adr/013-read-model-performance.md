# ADR 013: Read-model performance — `.lean()` boundary and index-backed sorts

**Status:** Accepted · **Phase:** 13

## Context

Phase 13 is performance, and the honest first step was to measure rather than
guess. Two things stood out: Mongo reads hydrate full Mongoose documents even
when the result is thrown away after reading one field, and the client shipped
as a single 199 kB bundle. This ADR records the backend read-model decisions;
the bundle work is in the `perf(client)` commit and its code comments.

## Decision

**`.lean()` only where the result never reaches `res.json()`.**

Mongoose hydration builds a full document with change tracking, getters and
virtuals. For a read whose result is only iterated internally, that is wasted
work, so those queries use `.lean()` to get plain objects:

- the cascade delete's `Document.find(...).select('storedPath')` and
  `Conversation.find(...).select('_id')`;
- the prompt-history read in the ask path.

**The client-facing list endpoints deliberately do NOT use `.lean()`.** Their
results are serialised through the schema `toJSON` transform (ADR-shared
`baseSchemaOptions`), which renames `_id` → `id`, drops `__v`, and deletes
hidden fields. `.lean()` returns raw objects with no `toJSON`, so `res.json()`
would emit `_id` and leak `__v` — a silent break of the API contract. The
boundary is therefore simple and stated at the call sites: **lean for internal
reads, hydrated for anything serialised.**

**Sorts are index-backed, and it is verified, not assumed.** Every list query
pairs an equality filter with a sort whose fields sit in a compound index in
Equality-Sort-Range order:

| Query | Index |
| --- | --- |
| KBs by user, newest first | `userId:1, createdAt:-1` |
| documents in a KB, newest first | `knowledgeBaseId:1, createdAt:-1` |
| conversations in a KB, by activity | `knowledgeBaseId:1, lastMessageAt:-1` |
| messages in a conversation, oldest first | `conversationId:1, createdAt:1` |
| ownership lookup (tenancy) | `userId:1, _id:1` |

`npm run indexes` reports drift between declared and live indexes and confirmed
all present with no in-memory sort.

## Consequences

**Positive.** Internal reads skip hydration; list sorts never fall back to an
in-memory sort; the read model has one rule a reviewer can check at a glance.

**Negative / limits.** The gain from `.lean()` is proportional to result size,
so on the projected internal reads it is modest and honest — this is not where a
slow request would come from. The larger read paths (a long message list) keep
hydration because correctness of the response shape outranks the saving; if a
conversation ever grew large enough to matter, the fix is a lean read plus an
explicit serializer, accepting the duplication `baseSchemaOptions` was written
to avoid — a trade to make against evidence, not pre-emptively.

**`listDocuments` with a `status` filter** uses the `knowledgeBaseId` prefix of
its index and filters `status` within the matched set; a `status`-specific
index would be over-engineering for per-KB document counts.

## Alternatives considered

- **Blanket `.lean()` on every read.** Rejected: it breaks the `toJSON`
  contract on serialised endpoints — the exact bug this ADR exists to prevent.
- **A `mongoose-lean-virtuals`/global transform plugin.** Would let list
  endpoints go lean while keeping `id`. Rejected for now: it reintroduces a
  second place serialisation rules live, and the measured benefit at current
  page sizes does not justify that risk.
