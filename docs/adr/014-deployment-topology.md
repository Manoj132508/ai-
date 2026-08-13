# ADR 014: Containerized deployment topology

**Status:** Accepted · **Phase:** 14

## Context

The system is three services plus two datastores. Phase 14 needed a
reproducible way to build and run all of it, and an honest account of what a
real cloud deploy adds. The constraint that shaped the choices: the Python AI
service authorizes nothing itself (ADR 001), and one of its inputs is a file the
Express service wrote.

## Decision

**One image per service, orchestrated by docker-compose; Chroma embedded, not a
service.**

- **client**: a two-stage build — Vite builds the static bundle, nginx serves
  it. nginx also reverse-proxies `/api` to the server so the browser sees one
  origin (which is what the httpOnly auth cookie needs), and turns
  `proxy_buffering off` on `/api` so the `/ask` SSE stream is not re-buffered at
  the edge.
- **server**: a slim Node image that reads config from `process.env` (no
  `--env-file` as in dev), so the orchestrator injects the environment.
- **ai-service**: a slim Python image. **ChromaDB runs in-process**
  (`PersistentClient`) against a volume, so there is no separate vector-store
  container to run, secure, or back up.
- **mongo**: the official image with a named volume.

**The uploads volume is shared** between server (read-write) and ai-service
(read-only) at the same absolute path, because the server passes a `file_path`,
not the bytes.

**Compression lives at the edge** (nginx gzip on static types), not in the Node
app, and never on the streamed `/api` responses — the same decision recorded in
Phase 13, made concrete here.

## Consequences

**Positive.** `docker compose up` is the whole system. Fewer moving parts than a
Chroma-as-a-service design. The images are cloud-agnostic: the same artifacts
run on a VM, ECS, or a PaaS.

**Negative / sharp edges, all documented in DEPLOYMENT.md.**

- **Secure cookies vs local http.** `NODE_ENV=production` marks the auth cookie
  `Secure`, which a browser drops over plain http. Local http trials set
  `NODE_ENV=development`; real deploys terminate TLS at the edge.
- **Embedding model on first use.** sentence-transformers pulls ~90 MB on the
  first index call. The Dockerfile documents a one-line prefetch to bake it in;
  left off by default to keep the base image smaller.
- **Single instance.** The in-memory rate limiter (ADR 012) means more than one
  API replica needs a shared Redis store first.
- **Not built here.** Docker was unavailable on the build machine, so the images
  were authored and their inputs verified (env-only boot, the client build, YAML
  parsing, passing suites) but not built or run. That is stated plainly rather
  than implied as done.

## Alternatives considered

- **ChromaDB as its own service (chromadb/chroma image).** Rejected: the code
  uses an embedded PersistentClient, so a service would add a container and a
  network hop for no behavioural gain at this scale. It becomes the right move
  only when multiple AI-service replicas must share one store.
- **App-level gzip in Express.** Rejected: redundant behind a CDN/proxy and a
  hazard next to SSE. Edge compression is cleaner.
- **Baking secrets or `.env` into images.** Never: images are artifacts that get
  pushed to registries; secrets come from the environment or a secrets manager.
