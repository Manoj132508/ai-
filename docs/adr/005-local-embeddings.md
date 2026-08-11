# ADR 005: Local MiniLM embeddings behind a provider interface

**Status:** Accepted · **Phase:** 3

## Context

Every chunk and every query must be embedded. Hosted embedding APIs cost money
per token and require a second API key; local models are free but need CPU and
disk.

## Decision

`sentence-transformers/all-MiniLM-L6-v2`, running locally — 384 dimensions,
CPU-only, no API key, no network. It sits behind an `EmbeddingProvider`
interface so a hosted model can be substituted without touching call sites.

## Consequences

**Positive.** Zero marginal cost and no rate limits, so indexing a large
document set is free. Works offline, which makes development and tests
independent of network state. The provider interface is the honest form of
provider-agnosticism — an abstraction at the seam, rather than a vague
environment-variable name.

**Negative.** Retrieval quality is below the best hosted models. The model
loads at startup (a few hundred MB of RAM) and must be loaded eagerly, or the
first question of each boot pays a ~10-second penalty.

**The binding constraint:** MiniLM has a **256-token maximum sequence length**.
Longer input is silently truncated — no error, no warning. This is not a
quality concern but a correctness one, and it is what fixes the chunk size at
roughly 800 characters (~200 tokens, with headroom). "Why 800?" has a real
answer because of this.

## Alternatives considered

- **Hosted embeddings (Voyage, OpenAI).** Better quality, but a per-token cost
  on every re-index and a second key to manage. The provider interface keeps
  this a one-file change if quality becomes the bottleneck.
