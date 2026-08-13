# Deployment

How to run the whole system as containers, and what changes for a real cloud
deploy. The design decisions behind this are in
[ADR 014](docs/adr/014-deployment-topology.md).

## Topology

Four containers on one private network:

```
browser ──► client (nginx :80)
                │  static SPA + /api reverse-proxy
                ▼
             server (Express :4200) ──► mongo (:27017)
                │                         (users, KBs, docs, messages)
                ▼
             ai-service (FastAPI :8000)
                │  embedded ChromaDB  ──► chroma_data volume
                └─ Ollama on the host (:11434)
```

Two wires that are easy to get wrong:

1. **Shared uploads volume.** The server writes an uploaded file, then hands the
   AI service a `file_path` to read (not the bytes). So the `uploads` volume is
   mounted into both containers at the **same absolute path** — read-write in the
   server, read-only in the AI service.
2. **Chroma is embedded**, not a service. The AI service runs
   `chromadb.PersistentClient` in-process and persists to the `chroma_data`
   volume. There is no Chroma container to run.

## Run it locally (production-like)

**Prerequisites:** Docker (with Compose), and — for the default free provider —
[Ollama](https://ollama.com) running on the host with the model pulled:

```bash
ollama pull llama3.2:3b
```

Then:

```bash
cp .env.compose.example .env      # fill in JWT_SECRET and INTERNAL_API_KEY
docker compose up --build
```

The SPA is published on <http://localhost:8080>.

### The one gotcha: secure cookies over http

The auth cookie is marked `Secure` when `NODE_ENV=production`, and a browser
**refuses to store a Secure cookie over plain http**. So with the default
`NODE_ENV=production`, login at `http://localhost:8080` will not persist the
session. Two options:

- **Local trial:** set `NODE_ENV=development` in `.env`. The cookie is no longer
  Secure and login works over http. (This also relaxes `trust proxy`.)
- **Real deploy:** serve the SPA over **HTTPS** (TLS at the edge). The cookie is
  set over the browser↔edge https leg, so `Secure` is satisfied even though the
  edge↔app hop is internal http.

## Environment reference

| Variable | Service | Notes |
|---|---|---|
| `JWT_SECRET` | server | **Required.** Session signing key; no default anywhere. |
| `INTERNAL_API_KEY` | server + ai-service | **Required.** Shared secret; the two must match (`X-Internal-Key`). |
| `NODE_ENV` | server | `production` (secure cookies, HSTS, trust proxy) or `development`. |
| `MONGODB_URI` | server | Set to the `mongo` service in compose; an Atlas URI in the cloud. |
| `LLM_PROVIDER` | ai-service | `ollama` (default, free, local) or `anthropic`. |
| `OLLAMA_BASE_URL` | ai-service | Defaults to `host.docker.internal:11434`. |
| `ANTHROPIC_API_KEY` | ai-service | Only when `LLM_PROVIDER=anthropic`. |
| `CHROMA_DIR` | ai-service | Volume path for the vector store. |
| Rate-limit / CORS vars | server | See `server/.env.example`. |

Real `.env` files are git-ignored; only `.env*.example` templates are committed.

## The embedding model

`sentence-transformers` downloads all-MiniLM-L6-v2 (~90 MB) on the **first**
index request, so the first upload after a cold start is slow and needs network.
For a real deploy, bake it into the image: uncomment the prefetch line in
`ai-service/Dockerfile` so the container starts answer-ready and needs no
network at runtime.

## CI

`.github/workflows/ci.yml` runs all three suites in parallel on every push and
on PRs into `main`: the server (`node:test` against a mongo service), the client
(`vitest`), and the AI service (`pytest` + `ruff`). Each job runs the same
command a developer runs locally, so CI cannot drift from local.

## Cloud path (what changes)

The containers are cloud-agnostic; a real deploy swaps *where* they run:

- **SPA →** build once and serve the static `dist/` from **S3 + CloudFront** (or
  any static/CDN host). This is the SPA-on-CDN half of the architecture. The
  `client` nginx image is the alternative when you want the app and API behind
  one origin instead.
- **API + AI service →** a container host: **ECS/Fargate**, a single VM running
  this compose file, or a PaaS. Keep the AI service **private** (not internet-
  facing) — it authorizes nothing itself (ADR 001); only the Express API may
  reach it.
- **Mongo →** managed **Atlas**; put the credential-bearing URI in a secrets
  manager, never in an image.
- **TLS** at the edge (CloudFront / ALB / nginx) — required for the secure auth
  cookie.
- **CORS** matters only if the SPA and API are on different origins; set
  `CORS_ORIGINS` to the SPA's URL (the allowlist already exists, ADR 003).
- **Rate limiting** is in-memory and single-instance; running more than one API
  replica needs the Redis store from [ADR 012](docs/adr/012-rate-limiting.md).

## Verification status

Authored and validated as far as this machine allows: the client production
build and the server's env-only boot were run directly; the compose and CI YAML
were parsed; `ruff` and the full test suites pass. **Docker was not available on
the build machine**, so the images were not built and the stack was not brought
up here — `docker compose up --build` is the first thing to run where Docker is
installed.
