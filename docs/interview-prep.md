# Interview prep — AI Knowledge Assistant

A rehearsal pack for defending this project. Answers are written the way you'd
actually say them out loud — tight, specific, and honest about trade-offs. Every
claim here is backed by code in the repo or an [ADR](adr/README.md).

---

## The 30-second pitch

> It's a retrieval-augmented Q&A system over your own documents. You upload a
> PDF, ask a question in plain language, and get a streamed answer grounded in
> the document with a citation to the exact page — or an honest "I couldn't find
> this." It's a React front end, an Express API that owns auth, tenancy and
> files, and a Python service that runs the RAG pipeline. The whole thing runs
> free and offline on a local model, and every architectural decision is
> recorded as an ADR with its cost.

If they want one sentence: *"RAG done so the answer is verifiable — cited to the
page, and refused rather than hallucinated when the documents don't cover it."*

---

## 1 · RAG fundamentals

**Why RAG instead of fine-tuning a model on the documents?**
Fine-tuning bakes knowledge into weights: it's expensive, has to be redone when
a document changes, and still hallucinates because the model can't tell you
*where* an answer came from. RAG keeps the documents as data, so updates are
just re-indexing, and every answer can cite its source. For a knowledge base
that changes, retrieval is the right tool.

**Why chunk documents? Why ~800 characters?**
Two reasons. First, an embedding is one fixed-size vector, so embedding a whole
document dilutes any specific fact into an average — retrieval needs passages,
not books. Second, and this is the load-bearing one: the embedding model
(all-MiniLM-L6-v2) silently truncates input past **256 tokens** with no error.
Feed it a 50-page PDF as one blob and pages 2–50 don't exist for retrieval. So
~800 characters isn't a preference — it's the model's hard ceiling turned into a
constraint. Chunks overlap ~150 chars so a sentence split across a boundary
isn't lost.

**Embeddings vs. keyword search — why not just BM25?**
Keyword search needs shared vocabulary. "How much notice do I give?" won't match
"termination requires 30 days' written notification" — no overlapping words.
Embeddings put both near each other because they *mean* the same thing. The
honest caveat: embeddings are weak at exact identifiers (a part number, an error
code), which is why "hybrid search — BM25 + dense" is top of my next-steps list.

**What's the retrieval threshold, and why do you call it the primary defence
against hallucination?**
Cosine similarity *always* returns a nearest neighbour — there's no "no match".
So a totally irrelevant question still retrieves *something*, and if you hand
that to the model it'll confidently answer from noise. The threshold measures
the top similarity; below it, the model is **never called** and the system says
"I couldn't find this." That check — not the prompt — is what actually prevents
the confident-wrong answer. The prompt helps, but a prompt is a request; the
threshold is a gate.

**What does grounding actually buy you?**
*Faithfulness to the source, not truth.* If the document is stale, the answer is
faithfully wrong — grounding guarantees the answer reflects the retrieved text,
not that the text is correct. That's the right guarantee for a document
assistant, and worth stating plainly so nobody over-trusts it.

---

## 2 · Architecture & system design

**Why two services — Node *and* Python?**
The split is on the **library boundary**. The mature AI libraries
(sentence-transformers, pypdf, chromadb) are Python; everything with a user
attached — auth, tenancy, file storage — is idiomatic in Node/Express. The cost
is real: a network hop and two runtimes to operate. I paid it because forcing
embeddings into Node, or auth into Python, would fight the ecosystem the whole
way.

**The Python service has no auth. Isn't that a hole?**
It authorizes nothing itself — it takes an opaque `kb_id` and trusts that
Express already checked ownership. That's safe *only* because it's bound to
localhost and unreachable from outside the host. I call that out explicitly as
the first assumption to re-examine if the topology changes — e.g. if the two
services ever run on different hosts, that boundary needs a real auth token, not
just network isolation.

**Why generate the answer in Python, not proxy the LLM from Node?**
Keeping the whole RAG pipeline — retrieve, build the grounded prompt, generate —
in one service means the prompt-construction logic lives next to the retrieval
that feeds it, and there's one place that talks to the model. Node's job is to
proxy the resulting stream to the browser, nothing more.

**Walk me through how streaming works end-to-end.**
Python generates tokens and emits them as Server-Sent Events. Express proxies
that stream straight through to the browser (using the response body reader, not
buffering). React's `useAsk` hook reads the stream, hand-parses the SSE frames,
and appends tokens to the answer as they arrive. After the tokens, the server
sends a citations payload, then a `done` event.

**How does cancellation work?**
End to end. If the user navigates away, React aborts the fetch; that tears down
the Express request, which Python observes as a client disconnect, which closes
the upstream model connection so it stops generating for an answer nobody will
read. Every link had to be wired — the Python path is natively async
(`httpx.AsyncClient` + `contextlib.aclosing`) specifically so the disconnect
propagates promptly. (This is also the bug I'm proudest of fixing — see §7.)

**Why deterministic chunk IDs (`{documentId}:{index}`)?**
They make two things trivial. Deletion: every chunk for a document is
predictably named, so I delete by prefix — no lookup table. Re-indexing: the
same document produces the same IDs, so re-processing overwrites in place
instead of duplicating. That's *why* there's no `Chunk` collection in Mongo at
all — the IDs encode the relationship.

**You delete vectors before the Mongo record. Why that order?**
Two datastores, no distributed transaction, so one has to fail first. If I
delete the Mongo row first and Chroma fails, I've got orphaned vectors that are
still *searchable* — deleted content that still shows up in answers. Deleting
vectors first inverts the failure: the worst case is an inert Mongo row with no
vectors, which is reclaimable and never leaks content. You can't remove the
failure; you choose which one to be left with.

**No job queue for indexing — isn't that fragile?**
It's fire-and-forget with a `status` field, which is enough for a single
instance and saves running Redis + a worker. The catch every async design has:
if the process dies mid-index, the document sits at "processing" forever. So
there's a stuck-state reaper that fails anything processing too long. The
trade-off and the mitigation are both in ADR 007 — "every async design needs a
stuck-state reaper" is the lesson.

---

## 3 · Auth & security

**Why store the JWT in an httpOnly cookie instead of localStorage?**
`localStorage` is readable by any JavaScript, so one XSS bug leaks every user's
token. An httpOnly cookie can't be read by script at all. The trade is that
cookies are sent automatically, which *creates* CSRF — so I pay for it with a
double-submit CSRF token and `SameSite=Strict`. It's a deliberate swap of one
risk (XSS token theft) for another (CSRF) that has a clean, well-understood
mitigation.

**Explain the double-submit CSRF scheme.**
On login the server sets a second cookie holding a random token — deliberately
*not* httpOnly, so the client can read it. The client echoes it in an
`X-CSRF-Token` header on every unsafe request, and the server requires the
header to match the cookie. An attacker's page can send the session cookie
(browsers attach it automatically) but *cannot read* the CSRF cookie to produce
the header — the same-origin policy stops them. `SameSite=Strict` is a second
layer, because relying on one browser-enforced mechanism means one gap breaks
everything.

**Why return 404, not 403, when I request another user's resource?**
A 403 confirms the resource *exists*, which lets an attacker enumerate other
tenants' IDs (IDOR). A 404 is indistinguishable from "never existed." And it
falls out of the design for free: every query filters on `userId` in the query
itself, so "not found" and "not yours" are literally the same code path — they
*can't* diverge, and it closes the timing side-channel too.

**How do you rate-limit, and what's the limitation?**
A hand-rolled fixed-window limiter, keyed by IP, in three tiers: a loose global
backstop, a tight tier on login/register (brute force + enumeration), and a
per-minute tier on the expensive `ask` endpoint. It reuses the taxonomy's 429
and sends `Retry-After`. The honest limitation: the counters are in-memory, so
it's single-instance — two replicas means an effective limit of N×max. The scale
path is a Redis `INCR`/`EXPIRE` store behind the same middleware; documented in
ADR 012. I chose IP-throttling over account-locking on purpose — locking an
account after N failures lets an attacker lock any victim out deliberately.

**Why validate uploads by magic bytes instead of the Content-Type?**
Both the filename extension and the `Content-Type` header are attacker-supplied.
A PNG renamed `.pdf` and declared `application/pdf` would pass both. Sniffing the
actual leading bytes is the only check the client can't lie about — that's why
it runs *after* the bytes land, not before.

**Any security detail that only shows up in deployment?**
Yes — the auth cookie is `Secure` in production, and a browser drops a Secure
cookie over plain http. So the container stack would silently fail to log anyone
in on `http://localhost`. Rather than weaken the default, the deploy docs make
it explicit: HTTPS at the edge in production, an opt-in dev mode for a local http
trial. It's a good example of a setting that's correct in prod and a trap
locally.

---

## 4 · Frontend / React

**Why React Context and hooks, not Redux?**
Almost all the state here is *server* state — knowledge bases, documents,
answers — which is a caching problem, not a store problem. Redux would be
ceremony around data whose source of truth is the server. Context handles the
genuinely global, genuinely client state (the auth session), and that's it.

**What's the three-state auth model, and what bug does it prevent?**
Auth is `loading` / `authenticated` / `anonymous`, not a boolean. `user === null`
is ambiguous — it means both "logged out" and "haven't checked yet." Collapsing
them causes the flash-of-login-page on every refresh: the app renders "logged
out" for the 80ms before `/auth/me` answers. The `loading` state waits for the
answer before deciding, so a deep-linked refresh doesn't bounce an authenticated
user to `/login`.

**The SSE parsing in `useAsk` — what's subtle about it?**
Network chunks don't align with SSE frame boundaries: one read might contain two
events, another might cut a frame in half. So after splitting on `\n\n`, every
piece *except the last* is a complete frame; the last might be a fragment, so
it's held back in a buffer and joined with the next chunk. Parsing every piece
immediately would intermittently choke on half a JSON object. That's the single
most bug-prone piece of frontend logic, so it has the most tests.

**How did you improve front-end performance?**
Measured first. The build was one 199 KB bundle — a `/login` visitor downloaded
the whole app. Route-based `React.lazy` split each page into its own chunk, and a
`manualChunks` vendor split put the ~164 KB framework in a stable chunk. Result:
the initial shell is ~11 KB, the chat-heavy page is deferred until you open a
knowledge base, and a routine app deploy no longer re-downloads React. "Measure,
change the one thing, prove it" beats "add caching everywhere."

---

## 5 · Testing & quality

**What's your testing strategy?**
Three suites, all offline: Node (`node:test`) for the API, Vitest + Testing
Library for the client, pytest for the Python pipeline — 181 tests total, plus a
separate RAG evaluation harness that scores answer quality (see §8). I
optimise for tests that encode a real invariant, not coverage percentage. The two
I'd point to: the **cross-tenant isolation** test (user A must get a 404 on user
B's knowledge base — a security guarantee), and the **`useAsk` SSE hook** tests
that drive a fake byte-reader to prove frame buffering across chunk splits.

**How do you test fire-and-forget background work?**
The upload→index handoff isn't awaited by the request handler, so the test can't
just await the response and assert "indexed" — that races the background work.
Instead the test **polls** the document status until it reaches a terminal state
within a deadline. And to test the handoff at all without a live Python service,
I made the AI client **injectable** (`setAiClient`) so a fake can stand in — a
seam the suite previously skipped rather than faked.

**Why Vitest over Jest for the client?**
The project is Vite-based, and Vitest reuses the same config and transform
pipeline — same JSX runtime, same plugins. Jest would mean a parallel Babel/ESM
setup that drifts until something works in dev but fails in tests. One source of
truth.

---

## 6 · Provider-neutral generation

**Why default to Ollama, and how does the provider abstraction work?**
Everything else in the pipeline is already local and free — embeddings,
retrieval, the vector store. Ollama makes *generation* local too, so the entire
RAG loop, including a real grounded answer, runs with no API key, no internet,
and no cost. That's what lets anyone verify the whole system. Both providers
implement one `TextGenerator` interface with an async `astream_answer`; a factory
is the only place that knows which provider exists. Claude is a one-env-var
upgrade for frontier-quality prose.

**What happens when a provider is misconfigured?**
It fails loudly, never silently. An unknown `LLM_PROVIDER` fails at *startup*.
There's **no silent fallback** between providers — a provider that can't run
(Ollama down, or Anthropic with no key) returns `LLM_UNAVAILABLE`, and retrieval
and citations still work. The health check is model-aware: it reports `degraded`
(not `ok`) unless the configured model is actually pulled, so "the server is up"
never masks "it can't answer." And the API key is a `SecretStr`, so it never
lands in a log or a stack trace.

---

## 7 · The story they'll ask for: "biggest challenge?"

**Streaming that arrived as one blob.** The first cut of the answer endpoint
showed nothing for 7.5 seconds, then dumped the whole answer at once. The async
request body was iterating a *synchronous* generator, which blocked the event
loop — so tokens were produced incrementally but flushed all at the end. The fix
was to make the generation path natively async and wrap the stream in
`contextlib.aclosing`, which delivered **both** incremental flushing *and*
genuine cancellation. What makes it a good story: a passing test suite had hidden
it — the tests asserted the *content* was right, not that it *streamed*. I only
caught it by watching real timestamps: 34 token events at distinct times over
~3.7s, versus all at one instant before. The lesson: some properties (it
streams; it cancels) can only be verified behaviourally, not with a green
checkmark.

---

## 8 · Curveballs

**How would you scale this to multiple instances?**
Three changes, all already flagged in ADRs. The rate limiter moves to a shared
Redis store (it's a drop-in behind the same middleware). The embedded ChromaDB
becomes a Chroma *service* so replicas share one store. And file storage moves
from local disk to S3. None are rewrites — they're the documented scale paths,
which is the point of writing the limitation down when you take the simple option.

**A user uploads a 500-page PDF. What happens?**
It's chunked page-aware into ~800-char pieces, each embedded and stored — the
256-token ceiling is exactly why chunking is non-negotiable at that size.
Indexing is async so the request returns immediately with a "processing" status
the client polls. The real limits at that scale are indexing time (no job queue
yet, so no parallelism or retries) and retrieval quality across thousands of
chunks (where a re-ranking step before generation would help).

**Document content could contain "ignore previous instructions." Prompt
injection?**
Real risk, and I won't claim it's solved. The grounding prompt instructs
answer-only-from-sources, and sources are clearly delimited and numbered, which
raises the bar — but a determined injection in the document text is a known open
problem for RAG. Honest mitigations I'd add: stronger delimiting, treating
retrieved text as data with instruction-hierarchy techniques, and output
validation. I'd rather say that clearly than pretend a prompt line fixed it.

**How do you know the answers are actually good?**
There's an evaluation harness (`ai-service/evaluation/`) that runs a fixed,
labelled question set through the real pipeline and scores it against a saved
baseline. It's split by determinism: a **Tier A** — retrieval hit-rate/MRR,
refusal accuracy, and the false-answer rate — is deterministic given the fixed
embedding model, so `--check` gates it in CI; a **Tier B** — citation validity,
correct-source, answer-contains-fact — needs a live LLM and is reported but not
gated. It already earned its keep — and the *way* it did is the point. It flagged that
the 0.35 threshold over-refuses some answerable questions. Instead of nudging the
number until the harness looked better (overfitting), I expanded the set to 39
questions, split it into a fixed tuning and held-out partition, selected the
threshold on tuning, and evaluated **once** on the holdout. The selected value
(0.38) **did not beat 0.35 on the holdout**, so I kept the default. The deeper
finding: the answerable and on-topic-but-unanswerable score distributions
overlap, so no single threshold separates them — that's the generation layer's
job (and a re-ranker's), not a constant's ([ADR 015](adr/015-threshold-held-out-tuning.md)).
What's still missing is full LLM-judge faithfulness at scale; that's the next
increment.

**What would you do differently if you started over?**
Two things. I'd stand up the streaming path and *watch it stream* earlier, before
building around it — the blob bug lived longer than it should have because tests
looked green. And I'd build the eval harness *first*, not last: "is the answer
good?" is the one question the unit tests can't answer, and having the baseline
from day one would have caught threshold and retrieval regressions as I went
rather than surfacing them at the end.

---

## Rapid-fire

- **Why 404 not 403?** — hides existence; prevents IDOR enumeration.
- **Primary hallucination defence?** — the retrieval score threshold, not the prompt.
- **Why ~800-char chunks?** — MiniLM truncates past 256 tokens, silently.
- **Why httpOnly cookie?** — XSS can't read it; pay for it with CSRF double-submit.
- **Why delete vectors first?** — leaves an inert record, never searchable "deleted" content.
- **Why no Chunk table?** — deterministic IDs encode the relationship; delete by prefix.
- **Why Ollama default?** — the whole pipeline runs free and offline, no key.
- **Rate-limit limitation?** — in-memory, single-instance; Redis is the scale path.
- **Context vs Redux?** — it's server state (a cache), not store state.
- **Cancellation?** — abort → Express teardown → Python disconnect → model stops.
- **Biggest bug?** — streaming-as-a-blob; a sync generator blocking the async loop.
- **Why not just retune the threshold?** — held-out validation rejected it; the score distributions overlap, so no constant separates them.
