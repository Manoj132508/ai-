# Case study — AI Knowledge Assistant

A retrieval-augmented question-answering system over your own documents:
upload a PDF, ask a question in plain language, get a **streamed answer grounded
in the document with a citation to the exact page** — or an honest *"I couldn't
find this in your documents."*

**Role:** sole engineer, full stack + AI. **Stack:** React 18 · Node/Express ·
Python/FastAPI · MongoDB · ChromaDB · Ollama/Claude. **Status:** works end to
end and runs with **no API key** on a free local model; three test suites pass;
containerized with CI.

---

## The problem

Organisations sit on documents nobody can search. Two common tools both fail:

- **Keyword search** misses meaning. Someone asks *"how much notice do I need to
  give?"* while the handbook says *"termination requires 30 days' written
  notification"* — no shared words, no match.
- **A general LLM** answers confidently and *wrongly*: it has never seen the
  document, so it invents a plausible policy.

The goal was an answer you can **trust and verify**, not one that merely sounds
right.

## The approach

Retrieval-Augmented Generation. Documents are split into chunks and embedded
into a vector space where *meaning*, not vocabulary, determines proximity. A
question is embedded the same way, the nearest chunks are retrieved, and only
those are handed to the language model, which is instructed to answer **from
them** and cite them.

Two design choices are what make it trustworthy rather than plausible:

1. **A retrieval score threshold.** Cosine similarity *always* returns a nearest
   neighbour, so "no good match" looks identical to "a weak match" unless you
   measure it. Below the threshold the LLM is **never called** and the system
   says it couldn't find the answer. The primary defence against hallucination
   is this threshold — not the prompt.
2. **Citations on every answer** — document, page, similarity score, snippet —
   so a claim can be checked instead of trusted.

## Architecture, and the decision that shaped everything

```
Browser (React SPA)
   │  JSON · JWT in an httpOnly cookie
   ▼
Node / Express          identity · tenancy · validation · files · MongoDB
   │  localhost · X-Internal-Key
   ▼
Python / FastAPI        extract → chunk → embed → Chroma → retrieve → generate
   │  SSE token stream, then a citations payload
   ▼
Node proxies the stream ──▶ React renders the answer + sources
```

**Two services, split on the library boundary.** The AI work lives in Python
because that is where the mature libraries are (sentence-transformers, pypdf,
chromadb); everything with a user attached — auth, tenancy, file storage — lives
in Node. The cost is a network hop and two runtimes to operate.

**Authorisation happens once, at the Express layer.** The Python service has no
user model: it receives an opaque `kb_id` and trusts that Node authorised the
request. That is only safe because it is **bound to localhost** and unreachable
from outside the host — the first assumption to re-examine if the topology
changes.

## Decisions that show judgement

Each of these had a real alternative, and each cost something.

| Decision | Why | What it costs |
|---|---|---|
| **Grounded refusal by score threshold** | The single most important behaviour: a wrong answer is worse than "not found". | A too-high threshold refuses answerable questions; the threshold needs tuning against real data. |
| **Provider-neutral generation, Ollama by default** | The *entire* pipeline runs free and local, so anyone can verify the system with no API key. Claude is a one-env-var upgrade. | A local 3B model gives weaker prose than a frontier model; mitigated by grounding it on retrieved text it only has to summarise. |
| **JWT in an httpOnly cookie, not localStorage** | XSS cannot read an httpOnly cookie; a token in `localStorage` is readable by any injected script. | Cookies are sent automatically, which *creates* CSRF — paid for with a double-submit CSRF token + `SameSite=Strict`. |
| **Tenancy by query shape → 404, not 403** | Every read filters on `userId` in the query itself, so "not found" and "not yours" are the same code path. 403 would confirm a resource exists and let an attacker enumerate other tenants' IDs (IDOR). | None worth noting — it is strictly safer and also closes a timing side-channel. |
| **Delete vectors before the Mongo record** | Two datastores, no transaction: something must fail first. Deleting vectors first means a partial failure leaves an inert record, never deleted content that is still searchable. | A crash mid-delete can orphan a Mongo row — the lesser of the two failures, and reclaimable. |
| **`.lean()` only where the result isn't serialised** | Internal reads skip Mongoose hydration for speed. | The serialised list endpoints must stay hydrated: `.lean()` bypasses the `toJSON` transform (`_id`→`id`) and would silently break the API contract — so the boundary is explicit. |
| **No job queue for indexing** | Fire-and-forget with a status field is enough for one instance; no Redis to run. | Needs a stuck-state reaper (a crash mid-index would otherwise leave a document "processing" forever). Documented, with a reaper. |

Every decision above is recorded as an Architecture Decision Record (14 in
total), each stating the context, the choice, **and what it costs** — because
the cost is what a reviewer actually needs.

## Hard problems, and how they were solved

**Streaming that arrived as one blob.** The first cut of the answer endpoint
buffered every token and delivered them all at the end (7.5 s of nothing, then a
wall of text). The async request body was iterating a *synchronous* generator,
blocking the event loop. The fix was to make the generation path natively async
(`httpx.AsyncClient` with the stream inlined) and wrap it in
`contextlib.aclosing`, which delivered **both** incremental flushing *and*
genuine cancellation — a browser disconnect now closes the upstream model
connection promptly instead of generating tokens nobody will read. Verified: 34
token events at distinct timestamps over ~3.7 s, and a client abort observed as
`client_disconnect` across both services.

**The invisible embedding ceiling.** MiniLM silently truncates input past 256
tokens — no error. Feed it a 50-page PDF as one blob and pages 2–50 simply do
not exist for retrieval. This is what fixes chunk size at ~800 characters: not a
tuning preference, a hard constraint of the model. Turning "why 800?" from a
guess into a constraint is the difference between a number you picked and one you
can defend.

**A client's typo blamed on the server.** Malformed JSON made `express.json()`
throw its own error shape, which fell through to the generic branch and became a
**500** — telling the caller *we* failed and inflating the server-error rate.
Found by testing the error path deliberately; fixed by translating known
third-party error shapes into the taxonomy (400, not 500).

**One missing wrapper takes down the whole server.** An async route without the
`asyncHandler` wrapper hung its request, fired an `unhandledRejection`, and
tripped graceful shutdown for *every* in-flight request. The lesson — every
async handler must be wrapped, and middleware order is a dependency graph, not a
style choice — is now enforced by applying auth/CSRF at the mount point so a new
route cannot ship unprotected.

**Secure cookies vs. local http.** The auth cookie is `Secure` in production,
which a browser drops over plain `http` — so the containerized stack would
silently fail to log anyone in on `http://localhost`. Rather than weaken the
security default, the deployment docs make the constraint explicit: HTTPS at the
edge in production, an opt-in `NODE_ENV=development` for a local http trial.

## Quality: measured, not assumed

- **Three test suites, 181 tests.** Node (47) covers auth, **cross-tenant
  isolation** (user A must 404 on user B's knowledge base), CSRF, upload
  magic-byte validation, and the upload→index handoff via an **injected fake AI
  client** — a seam that was previously skipped rather than faked. Client (26,
  Vitest) covers the API client and the tricky `useAsk` SSE hook (frame
  buffering across network-chunk splits, the status machine, mid-stream error,
  abort). Python (108) covers chunking, retrieval threshold, both generation
  providers via `httpx.MockTransport`, streaming/cancellation, and the eval
  metric maths — all offline.
- **Performance was measured before it was optimised.** Profiling the build
  found a single 199 KB JS bundle. Route-based code-splitting plus a stable
  vendor chunk cut the initial app shell to **10.8 KB** and deferred the
  chat-heavy page (14.5 KB) until a knowledge base is opened — and a routine app
  deploy no longer re-downloads the ~164 KB framework.
- **Security hardening** with verification: rate limiting in three IP-keyed
  tiers (the login tier proven to allow exactly 10 attempts, then 429 with
  `Retry-After`), security headers on every response, `X-Powered-By` removed.
- **The answers themselves are measured, not just the code.** An evaluation
  harness runs a labelled question set through the real pipeline and scores
  retrieval (hit-rate 1.00, MRR 0.95), refusal accuracy, and — with a live LLM —
  citation correctness, gating the deterministic metrics against a baseline so a
  regression fails the build. It immediately paid for itself by surfacing that
  the shipped retrieval threshold slightly over-refuses.

## Outcomes

- **Runs end to end with zero cost or API keys** on a local model — the whole
  RAG loop, including a real grounded answer with citations, works offline.
- **Grounded and verifiable:** every answer cites the source page, and questions
  the documents can't answer are refused rather than hallucinated.
- **Operable:** structured logs with a request ID threaded across both services,
  a real health check that reports `degraded` when generation can't run,
  index-backed queries, and a one-command containerized stack with CI.

## What I'd do next

Hybrid search (BM25 + dense) for exact identifiers that embeddings handle
poorly · OCR for scanned PDFs · a real job queue with retries and a dead-letter
queue · a Redis-backed rate limiter for multiple API replicas · S3 instead of
local disk · a single end-to-end test spanning all three services.

## What I learned

- Cosine similarity has no concept of "no match" — which is exactly why the
  threshold, not the prompt, is the real defence against hallucination.
- Grounding buys *faithfulness to the source*, not truth: a stale document is
  reported faithfully and is still wrong.
- Deterministic chunk IDs are load-bearing — they make deletion cheap and remove
  the need for a chunk table entirely.
- The most valuable tests are the ones that encode a security invariant (the
  cross-tenant 404) or a subtle async contract (the SSE hook), not the ones that
  pad the count.
- "Measure first" is a better engineering story than "I added caching
  everywhere": find the real constraint, make the smallest change, prove it.
