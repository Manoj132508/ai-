# AI Knowledge Assistant

Ask natural-language questions of your own documents and get answers grounded
in them — with a citation to the exact page, and an honest *"I couldn't find
this in your documents"* when the answer isn't there.

> **Status: phases 1–14 of 17 complete.** The full stack works end to end —
> auth, tenancy, uploads, indexing, retrieval, and grounded streaming answers
> with citations — and runs **with no API key** on a free local model (Ollama).
> Three test suites pass; the system is containerized with CI. Remaining work is
> documentation, a case study, and interview prep. This file is kept honest
> deliberately — see [Current state](#current-state).

---

## Problem

Organisations sit on documents nobody can search. Keyword search fails because
people ask *"how much notice do I need to give?"* while the document says
*"termination requires 30 days' written notification"* — no shared words, no
match. A general-purpose LLM answers confidently and wrongly, because it has
never seen the document.

## Solution

Retrieval-Augmented Generation. Documents are split into chunks and embedded
into a vector space where meaning, not vocabulary, determines proximity. A
question is embedded the same way, the nearest chunks are retrieved, and only
those are given to the language model — which is instructed to answer from them
and cite them.

Two things make it trustworthy rather than merely plausible:

- **A retrieval score threshold.** If nothing relevant is found, the model is
  never called and the system says so. Cosine similarity always returns a
  nearest neighbour, so without this the system would confidently answer
  questions the documents cannot address ([ADR 008](docs/adr/008-retrieval-threshold.md)).
- **Citations on every answer** — document, page, similarity score, snippet —
  so a claim can be checked rather than trusted.

## Architecture

```
Browser (React SPA, :5177)
   │  JSON over HTTPS · JWT in an httpOnly cookie
   ▼
Node / Express (:4200)   identity · tenancy · validation · files · MongoDB
   │  HTTP on 127.0.0.1 · X-Internal-Key
   ▼
Python / FastAPI (:8000)   the RAG pipeline
   │
   ├─ extract    pypdf → text + page numbers
   ├─ chunk      ~800 chars, 150 overlap, page metadata preserved
   ├─ embed      all-MiniLM-L6-v2, local, 384-dim
   ├─ store      ChromaDB, one collection per knowledge base
   ├─ retrieve   top-k cosine + score threshold
   └─ generate   Ollama (local, default) or Claude, grounded, cited
   │
   ▼  SSE token stream, then a citations payload
Node proxies the stream ──▶ React renders answer + sources
```

**Authorisation happens once, at the Express layer.** The Python service has no
user model — it receives an opaque `kb_id` and trusts that Node authorised the
request. That is only safe because it is bound to localhost and unreachable
from outside the host; it is the first assumption to re-examine if the
deployment topology ever changes ([ADR 001](docs/adr/001-two-services.md)).

Full reasoning for every significant decision, including what each one costs,
is in [`docs/adr/`](docs/adr/README.md).

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 18, Vite 5, React Router 6, Bootstrap 5 + CSS Modules |
| API | Node 24, Express 4 |
| AI service | Python 3.12, FastAPI, pypdf, sentence-transformers |
| Vector store | ChromaDB (local, persistent) |
| Application data | MongoDB (Atlas in production) |
| LLM | **Ollama** (local, free, default) or **Claude** (hosted, paid), behind one provider interface ([ADR 011](docs/adr/011-provider-neutral-generation.md)) |
| Tests | node:test (Node), Vitest + Testing Library (client), pytest (Python) |
| Deploy | Docker + docker-compose, GitHub Actions CI |

State is managed with React Context and hooks. Redux is deliberately absent —
almost all state here is server state, and a cache-shaped problem is not a
store-shaped problem.

## Current state

| Phase | | Status |
|---|---|---|
| 1–2 | Requirements · system architecture | Complete |
| 3–4 | Database design · UI/UX design | Complete |
| 5–6 | Frontend foundation · backend API contract | Complete, verified |
| 7 | Database integration (Mongoose, ESR indexes, seeds) | Complete |
| 8 | Authentication (JWT cookie, CSRF, tenancy) | Complete |
| 9 | Documents (upload, magic-byte validation, indexing) | Complete |
| 10 | RAG pipeline (retrieve → grounded streaming answer) | Complete, live-verified |
| 11 | Security hardening (headers, rate limiting) | Complete |
| 12 | Automated testing (Node · client · Python) | Complete |
| 13 | Performance (code-splitting, read-model) | Complete |
| 14 | Deployment (Docker, compose, CI) | Complete |
| 15–17 | README · case study · interview prep | In progress |

**Working today — the whole product.** Register and log in, create a knowledge
base, upload a PDF/TXT/Markdown file, watch it index, then ask a question and
get a streamed answer grounded in your document with a citation to the exact
page — or an honest *"I couldn't find this in your documents"*. All of it runs
locally with no API key on a free Ollama model.

**Not built (by design):** team sharing, OCR for scanned PDFs, and the other
items under [Future improvements](#future-improvements).

## Installation

**Everything in containers** — the fastest way to run the whole system:

```bash
cp .env.compose.example .env    # fill in JWT_SECRET and INTERNAL_API_KEY
docker compose up --build       # SPA on http://localhost:8080
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for the details (including the
secure-cookie/HTTPS note). The rest of this section is the **local dev** setup,
service by service.

Requires Node 20+, Python 3.12, MongoDB (running locally), and — for free local
answers — [Ollama](#ollama--free-local-the-default).

```bash
# API  (terminal 1)
cd server
cp .env.example .env
npm install
npm run dev            # http://localhost:4200

# Web client  (terminal 2)
cd client
npm install
npm run dev            # http://localhost:5177
```

The Vite dev server proxies `/api` to the API, so the browser only ever talks to
one origin. That is not just convenience: it keeps development same-origin, so
the `httpOnly` auth cookie works without CORS handling, and removes the
temptation to "fix" a cookie problem by moving the token into `localStorage`
([ADR 003](docs/adr/003-jwt-in-httponly-cookie.md)).

```bash
# AI service  (terminal 3)
python -m venv .venv && .\.venv\Scripts\Activate.ps1     # PowerShell
cp .env.example .env                                     # repo-root .env
pip install -r ai-service/requirements-dev.txt
uvicorn app.main:app --app-dir ai-service --port 8000
```

## Generation provider (Ollama or Anthropic)

Answer generation runs behind a provider-neutral interface. Two providers are
supported, selected by `LLM_PROVIDER` ([ADR 011](docs/adr/011-provider-neutral-generation.md)).

### Ollama — free, local, the default

Everything else in the pipeline is already local and free (embeddings,
retrieval, the vector store). **Ollama** makes generation local too, so the
*entire* RAG pipeline — including a real grounded answer — works with **no API
key, no internet and no cost**. That is what lets any contributor run and
verify the whole system.

Install and start it, then pull the default model:

```bash
# 1. Install Ollama:  https://ollama.com/download   (Windows/macOS/Linux)
# 2. Ollama runs as a background service on http://localhost:11434
# 3. Download the model (~2 GB):
ollama pull llama3.2:3b
```

`llama3.2:3b` is chosen as a sensible default: ~2 GB on disk, runs on a
CPU-only laptop, and is capable enough for grounded question-answering over
retrieved text (the model only has to summarise passages it is handed, not
reason from scratch). If you have more RAM/VRAM, a larger model such as
`llama3.1:8b` will give better answers — set `OLLAMA_MODEL` and `ollama pull`
it. On a very constrained machine, `qwen2.5:1.5b` is smaller and faster at some
cost to quality.

**Hardware / disk:** budget the model's download size on disk (2–5 GB), and
enough free RAM to load it (roughly the file size). Generation speed is
CPU/GPU-bound; a 3B model is comfortably interactive on a modern laptop.

### Anthropic — hosted, paid, optional

For a deployment that wants frontier-quality answers, switch to Claude:

```bash
# in the repo-root .env
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...    # required for this provider; never commit it
```

Anthropic usage is **optional and paid** — it is only ever called when
`LLM_PROVIDER=anthropic`. The key lives in the Python service's environment
only; the SDK reads it directly, so our code never handles it.

### Switching, and what happens when it is misconfigured

- `LLM_PROVIDER=ollama` (default) needs no key.
- `LLM_PROVIDER=anthropic` needs `ANTHROPIC_API_KEY`.
- Any other value **fails at startup** with a clear error — no silent default.
- There is **no silent fallback** between providers. A provider that cannot run
  (Ollama not started, or Anthropic without a key) returns `LLM_UNAVAILABLE`;
  retrieval and citations still work.

`GET http://localhost:8000/health` reports the selected provider and whether a
real answer could be produced right now — for Ollama, whether the local server
responds **and the configured model is actually pulled**; for Anthropic,
whether a key is present. When generation is unavailable the overall `status`
is `degraded` (retrieval and search still work), not `ok`:

```json
{ "status": "ok",       "provider": "ollama", "generation_available": true }
{ "status": "degraded", "provider": "ollama", "generation_available": false }
```

### Troubleshooting an unreachable Ollama

If answers come back as *"Answer generation is not configured / not reachable"*
while retrieval and citations still work:

- Is Ollama running? `ollama list` should respond; the server listens on
  `http://localhost:11434`.
- Is the model pulled? `ollama pull llama3.2:3b` (or whatever `OLLAMA_MODEL` is
  set to).
- Does `OLLAMA_BASE_URL` match where Ollama is listening?
- Check the AI service's `/health` — `status: "degraded"` /
  `generation_available: false` for the `ollama` provider means the server was
  not reachable, or the configured model was not pulled, when probed.

## Environment variables

`server/.env` — see `server/.env.example`.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` enables strict config checks |
| `PORT` | `4200` | Validated at startup |
| `CORS_ORIGINS` | `http://localhost:5177` | Comma-separated allowlist. Never a wildcard — credentials forbid it |
| `AI_SERVICE_URL` | `http://127.0.0.1:8000` | Must stay loopback |
| `INTERNAL_API_KEY` | dev fallback | **Required in production**; the server refuses to boot without it |

Configuration is read once, validated once and frozen in `server/config/env.js`.
Missing production secrets throw at startup rather than surfacing on the first
real request — a server that boots and looks healthy while misconfigured is
worse than one that refuses to start.

**AI service** (repo-root `.env` — see `.env.example`). Key generation-related
variables:

| Variable | Default | Notes |
|---|---|---|
| `LLM_PROVIDER` | `ollama` | `ollama` or `anthropic`; unknown values fail at startup |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Where the local Ollama server listens |
| `OLLAMA_MODEL` | `llama3.2:3b` | `ollama pull` this first |
| `LLM_MAX_TOKENS` | `8192` | Max answer length (both providers) |
| `ANTHROPIC_API_KEY` | *(empty)* | **Required only** when `LLM_PROVIDER=anthropic`; never committed |
| `ANTHROPIC_MODEL` | `claude-opus-5` | Used only by the Anthropic provider |
| `INTERNAL_API_KEY` | dev fallback | Must match `server/.env` |

The key belongs to the Python service only, so it exists in exactly one process
([ADR 002](docs/adr/002-generate-in-python.md)). Config is anchored to the
repository root, so the service reads the same `.env` regardless of which
directory launched it.

## API

Every response — success or failure — has the same shape:

```jsonc
{ "success": true,  "data": { … }, "error": null }
{ "success": false, "data": null,  "error": { "code": "KB_NOT_FOUND",
                                              "message": "…",
                                              "requestId": "…" } }
```

Clients switch on `error.code`, never on `error.message`: codes are the
contract, messages are prose ([ADR 009](docs/adr/009-response-envelope.md)).

| Method | Path | |
|---|---|---|
| `POST` | `/api/auth/register` · `/login` · `/logout` | Session cookie + CSRF token; strict rate limit |
| `GET` | `/api/auth/me` | Current user, or 401 |
| `GET` `POST` | `/api/knowledge-bases` | List / create (per-tenant unique name) |
| `GET` `PATCH` `DELETE` | `/api/knowledge-bases/:id` | Read / update / cascade delete |
| `GET` `POST` | `/api/knowledge-bases/:id/documents` | List / upload (magic-byte validated) |
| `POST` | `/api/knowledge-bases/:id/ask` | **Ask — SSE stream** of tokens then citations |
| `GET` | `/api/knowledge-bases/:id/conversations` | Conversation history |
| `GET` | `/api/documents/:id` | Document status (polled while `processing`) |
| `GET` `DELETE` | `/api/conversations/:id` · `/:id/messages` | Messages / delete conversation |
| `GET` | `/api/health` | Liveness plus a per-dependency `checks` map |
| `GET` | `/api/dev/*` | Deliberate-failure routes; absent in production |

Every authenticated route is tenancy-scoped and CSRF-protected at its mount
point, so a new route cannot accidentally ship public ([Security](#security)).

### Error taxonomy

| Code | Status | |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Includes malformed JSON bodies |
| `ROUTE_NOT_FOUND` | 404 | |
| `AUTH_REQUIRED` / `AUTH_INVALID` | 401 | |
| `KB_NOT_FOUND` / `DOC_NOT_FOUND` | 404 | **404, not 403** — see Security |
| `KB_EMPTY` | 409 | Well-formed request, wrong resource state |
| `PAYLOAD_TOO_LARGE` | 413 | JSON body over the parser limit |
| `FILE_TOO_LARGE` | 413 | Upload over 10 MB |
| `FILE_TYPE_UNSUPPORTED` | 415 | |
| `FILE_NO_TEXT` | 422 | Probably a scanned PDF |
| `RATE_LIMITED` / `LLM_RATE_LIMITED` | 429 | |
| `AI_SERVICE_UNAVAILABLE` / `LLM_UNAVAILABLE` | 503 | |
| `INTERNAL_ERROR` | 500 | Generic; never carries internals |

`NO_RELEVANT_CONTEXT` is deliberately **not** an error. A grounded refusal is a
correct outcome returned as 200.

## Security

- **Passwords** hashed with bcrypt at cost 12, never selected by default.
- **Sessions** in `httpOnly` + `Secure` + `SameSite=Strict` cookies, so XSS
  cannot read the token.
- **Tenancy enforced by query shape.** Every read filters on `userId` in the
  query itself, rather than fetching and comparing afterwards — so "not found"
  and "not yours" are the same code path and cannot diverge.
- **404 rather than 403** for another user's resource. A 403 confirms the
  resource exists, which is enough to enumerate other tenants' IDs (IDOR).
  Same code path also closes the timing side channel.
- **No internals in responses.** Only deliberate `ApiError` messages reach the
  client; anything else becomes a generic 500 while the full error is logged.
- **Request tracing.** A validated `X-Request-Id` (generated when absent or
  malformed) threads through both services. Inbound values are pattern-checked
  because an unvalidated header reaches log files, where a newline lets a
  caller forge log entries.
- **Uploads** validated by magic bytes, not by the client-supplied
  `Content-Type` or the file extension.
- **Secrets** never reach the client bundle. Tree-shaking removes code; it is
  not a hiding place.
- **Security headers** on every response: `nosniff`, `X-Frame-Options: DENY`
  and a `frame-ancestors 'none'` CSP (clickjacking), `no-referrer`,
  `Cross-Origin-Resource-Policy: same-origin`, and HSTS in production. The
  `X-Powered-By` framework fingerprint is removed.
- **Rate limiting** in three IP-keyed tiers ([ADR 012](docs/adr/012-rate-limiting.md)):
  a loose global backstop, a tight tier on login/register (brute force and
  enumeration), and a per-minute tier on the expensive `ask` endpoint. Limits
  are env-tunable; a 429 carries `RateLimit-*` and `Retry-After` headers. The
  store is in-memory (single instance); the documented scale path is a shared
  Redis store behind the same middleware.

## Testing

Three suites, all offline and dependency-light. `app.js` builds the app without
listening precisely so the Node tests can drive the real middleware chain on an
ephemeral port (`listen(0)`) without binding 4200.

| Suite | Run | Covers |
|---|---|---|
| **Node** (`node:test`, no framework) | `cd server && npm test` | Auth + session lifecycle; **tenancy isolation — user A gets 404 on user B's KB**; CSRF; KB/document CRUD; magic-byte upload validation; deletion + cascade; security headers; rate-limiter logic; the **upload→index handoff** via an injected fake AI client |
| **Python** (`pytest`, `asyncio_mode=auto`) | `.venv\Scripts\python -m pytest` (repo root) | Chunker boundaries/overlap/page attribution; embeddings; retrieval threshold; both generation providers via `httpx.MockTransport`; the `/query` streaming + cancellation boundary; secret-free config |
| **Client** (`vitest` + Testing Library + jsdom) | `cd client && npm test` | `apiClient` (CSRF, envelope, error mapping); `format` utils; the **`useAsk` SSE hook** (frame buffering, status machine, mid-stream error, abort); the `RequireAuth` three-state guard |

Two Python tests skip by design (the live Anthropic call and the real-model
load; `RUN_MODEL_TESTS=1` enables the latter). Injecting the AI client
(`setAiClient`) is what lets the Node suite cover the fire-and-forget indexing
seam that was previously skipped rather than faked.

Not yet a single end-to-end flow (register → upload → `indexed` → ask →
citation): that spans all three services and belongs to a later CI harness.
Component coverage is the highest-value pieces, not every component.

## Challenges so far

**The 256-token embedding ceiling.** MiniLM silently truncates longer input —
no error. Feed it a 50-page PDF and pages 2–50 simply do not exist as far as
retrieval is concerned. This is what fixes chunk size at ~800 characters, and
it turns "why 800?" from a guess into a constraint.

**Two datastores, no transaction.** Deleting a document must update Mongo and
Chroma, and either can fail. The resolution was not to eliminate the failure but
to choose which one to be left with: vectors are deleted first, so a partial
failure leaves an inert record rather than deleted content that is still
searchable ([ADR 006](docs/adr/006-delete-vectors-first.md)).

**An unhandled rejection takes down the whole server.** Verified accidentally
while testing: an async route without `asyncHandler` hung its request, fired
`unhandledRejection`, triggered shutdown, and then blocked `server.close()`
until the force-exit timer fired. One missing wrapper kills every other
in-flight request.

**Malformed JSON was reported as a 500.** `express.json()` throws its own error
shape, which fell through to the generic branch — blaming the server for a
client's broken body and inflating the server-error rate. Found by testing the
error path deliberately rather than waiting for it to happen.

## What I learned

- Cosine similarity has no concept of "no match". Every query returns
  neighbours, which is precisely why a threshold is the primary defence against
  hallucination — not the prompt.
- Grounding buys *faithfulness to the source*, not truth. A stale document is
  reported faithfully and is still wrong.
- Deterministic IDs are load-bearing: they are what makes deletion cheap and
  removes the need for a chunk table entirely.
- `visibility: hidden` removes an element from the tab order; `opacity: 0` and
  a transform do not. An off-screen drawer built the obvious way is a keyboard
  trap.
- Ordering middleware is a dependency graph, not a style choice. Each entry in
  `app.js` documents what breaks if it moves.

## Future improvements

Hybrid search (BM25 + dense) for exact identifiers, which embeddings handle
poorly · OCR for scanned PDFs · a real job queue with retries and a
dead-letter queue · team sharing and shared knowledge bases · document
versioning · streaming re-rank before generation · S3 instead of local disk.

## Deployment

The whole system is containerized — `docker compose up --build` brings up the
client (nginx), server, AI service and MongoDB on one network, with ChromaDB
embedded in the AI service and a shared uploads volume between server and AI
service. A GitHub Actions workflow runs all three test suites on every push.

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the run steps, the environment
reference, the secure-cookie/HTTPS caveat, and the cloud path (S3 + CloudFront
for the SPA; ECS/VM for the services behind TLS; Atlas for Mongo). Topology
rationale is in [ADR 014](docs/adr/014-deployment-topology.md).

Not yet deployed to a live URL — the images are authored and their inputs
verified, but Docker was unavailable on the build machine, so `docker compose
up` is the first step where Docker is installed.
