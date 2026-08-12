# ADR 011: Provider-neutral generation, Ollama by default

**Status:** Accepted · **Phase:** 10

## Context

Generation was Anthropic-only. Everything else in the pipeline — chunking,
embeddings, retrieval, the vector store — runs locally and free (ADR 005), but
a grounded answer required a funded `ANTHROPIC_API_KEY`. That left the whole
development experience blocked on a paid credential: with no key, the pipeline
indexed and retrieved but could never actually answer, and the live path could
not be exercised at all.

## Decision

Introduce a small provider-neutral interface for streaming generation and make
**Ollama** — a free model running on the developer's own machine — the default
provider. Anthropic is preserved, unchanged, behind the same interface and
selected by configuration.

```
RAG prompt
   ↓
provider factory        (the ONLY place that knows providers exist)
   ├── Ollama adapter    (default: local, free, no key)
   └── Anthropic adapter (hosted, paid, unchanged)
   ↓
normalized token stream (Iterator[str])
   ↓
existing FastAPI → Node → browser SSE pipeline
```

- `app/pipeline/base.py` holds the interface (`TextGenerator`) and the shared
  types (`GenerationRequest`, `GenerationUnavailable`, `GenerationFailed`), so
  the two adapters depend on the contract, not on each other.
- `LLM_PROVIDER` selects the adapter (`ollama` default, `anthropic`). An
  unknown value fails at **startup**, in the config validator — not at the
  first question.
- The orchestration layer (`main.py`) asks the factory for a generator and
  never names a provider or touches a provider SDK.

## Consequences

**Positive.** The complete RAG pipeline — including a real grounded answer —
works with no API key, no internet and no cost. Contributors can run and
verify everything locally. Anthropic remains a one-line config switch for
deployment, with its `stop_reason`/refusal handling intact.

**Negative.** A local 3B model is weaker than a frontier hosted model, so
answer quality in development is lower than in an Anthropic deployment. Running
it needs a couple of GB of disk and enough RAM/CPU to generate at a usable
speed. And there are now two generation code paths to keep behind one
interface.

## Rules the design holds to

- **No silent fallback**, in either direction. Choosing a provider that cannot
  run (Anthropic without a key, Ollama not started) surfaces as
  `LLM_UNAVAILABLE` — never a quiet swap to the other one. A wrong provider
  should be an obvious failure, not a surprising bill or a surprising
  degradation.
- **Refusal is provider-independent and pre-generation.** The retrieval-score
  threshold (ADR 008) refuses ungrounded questions before either provider is
  called. Refusal is never inferred by scanning generated text for phrases
  like "I cannot" — that would be brittle and provider-specific.
- **One error taxonomy.** Unreachable server, bad HTTP status, timeout,
  malformed stream — all map to the existing `LLM_UNAVAILABLE` code (ADR 009),
  not to new ad-hoc shapes.
- **Cancellation is preserved.** The Ollama adapter is synchronous like the
  Anthropic one, so a downstream disconnect closes the generator, unwinds the
  `with client.stream(...)` block, and closes the upstream response — stopping
  generation for an answer nobody will read.
- **No secret ever leaves the process.** The Anthropic SDK reads its key from
  the environment; our code never handles it. `/health` reports a boolean, not
  a value.

## Alternatives considered

- **Keep Anthropic-only, require a key for development.** Rejected: it blocks
  every contributor without a paid account and makes the live path untestable
  offline.
- **A hosted free tier from another vendor.** Still a key, still a network
  dependency, still a signup. Ollama needs none of these.
- **An OpenAI-compatible shim over Ollama.** More moving parts than a ~150-line
  adapter over the `httpx` dependency the project already has.
