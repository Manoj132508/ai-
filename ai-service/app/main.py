"""FastAPI AI service: document processing, retrieval and grounded generation.

Binds to loopback and authenticates the CALLER (the Node API) with a shared
secret. It has no user model and performs no authorisation of its own -- it
receives an opaque knowledge_base_id and trusts that Node authorised the
request (ADR 001). That is only safe while it is unreachable from outside the
host, which is the first assumption to re-examine if the deployment changes.

There is deliberately no CORS middleware. Browsers never talk to this service;
only the Node API does, server to server. Advertising cross-origin access on
an intentionally unauthenticated internal service widens its blast radius for
no benefit.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager

import chromadb
from app.core import logging as log
from app.core.config import get_settings
from app.core.security import require_internal_key
from app.pipeline.base import GenerationFailed, GenerationRequest, GenerationUnavailable
from app.pipeline.chunker import chunk_pages
from app.pipeline.embedder import LocalEmbeddingProvider
from app.pipeline.extractor import NoExtractableText, extract_pages
from app.pipeline.prompt import REFUSAL_TEXT
from app.pipeline.provider_factory import (
    build_generator,
    generation_configured,
    provider_health,
)
from app.pipeline.retriever import retrieve
from app.pipeline.vector_store import ChromaVectorStore, StoredChunk, collection_name_for
from chromadb.config import Settings as ChromaSettings
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

settings = get_settings()

embedder = LocalEmbeddingProvider(settings.embedding_model)

chroma_client = chromadb.PersistentClient(
    path=settings.chroma_dir,
    settings=ChromaSettings(anonymized_telemetry=False),
)
vector_store = ChromaVectorStore(chroma_client)

# Provider chosen once, from config. main.py never names a provider or touches
# a provider SDK; the factory owns that decision (ADR 011).
generator = build_generator(settings)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Loads the embedding model before the first request.

    Left lazy, the first question after every restart pays a ~10 second
    penalty that looks like a slow query rather than a cold model. Failure is
    logged rather than fatal, so the service can still serve /health and
    report itself degraded instead of refusing to start.

    (`lifespan` rather than the deprecated `@app.on_event("startup")`.)
    """
    try:
        embedder.warm_up()
        log.info("embedding model ready", model=settings.embedding_model)
    except Exception as exc:
        log.error("embedding model failed to load", detail=str(exc))
    yield


app = FastAPI(
    title="AI Knowledge Assistant - RAG service",
    version="0.1.0",
    lifespan=lifespan,
)


# --- request models ---------------------------------------------------------


class IndexRequest(BaseModel):
    document_id: str
    knowledge_base_id: str
    file_path: str
    filename: str
    mime_type: str
    request_id: str | None = None


class DeleteDocumentRequest(BaseModel):
    knowledge_base_id: str
    document_id: str


class DeleteCollectionRequest(BaseModel):
    knowledge_base_id: str


class QueryRequest(BaseModel):
    question: str
    knowledge_base_id: str
    history: list[dict] = Field(default_factory=list)
    request_id: str | None = None


# --- endpoints ---------------------------------------------------------------


@app.get("/health")
def health() -> dict:
    # provider_health reports the selected provider and whether a real answer
    # could be produced right now -- for ollama that means probing the local
    # server, for anthropic that a key is present. It never returns a key or
    # any secret value.
    health_info = provider_health(settings)
    return {
        "status": "ok",
        "service": "ai-service",
        "embedding_model": settings.embedding_model,
        "provider": health_info["provider"],
        # Reported rather than assumed, so the Node API can tell a user that
        # answering is unavailable instead of discovering it mid-question.
        "generation_available": health_info["generation_available"],
    }


@app.post("/index", dependencies=[Depends(require_internal_key)])
def index_document(req: IndexRequest) -> dict:
    try:
        pages = extract_pages(req.file_path, req.mime_type)
    except NoExtractableText as exc:
        # 422: the file parsed fine, its content cannot be used. Distinct from
        # a 500, and it maps to FILE_NO_TEXT on the Node side.
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="File not found.") from exc

    chunks = chunk_pages(
        pages,
        chunk_size=settings.chunk_size,
        chunk_overlap=settings.chunk_overlap,
    )
    if not chunks:
        return {"success": True, "chunk_count": 0, "page_count": len(pages)}

    embeddings = embedder.embed_documents([chunk.text for chunk in chunks])

    stored = [
        StoredChunk(
            # Deterministic ids (ADR 005): re-indexing produces the same ids,
            # so deletion is a metadata match and nothing orphans.
            chunk_id=f"{req.document_id}:{chunk.index}",
            text=chunk.text,
            embedding=embedding,
            document_id=req.document_id,
            document_name=req.filename,
            page=chunk.page,
        )
        for chunk, embedding in zip(chunks, embeddings, strict=True)
    ]

    count = vector_store.index_document(req.knowledge_base_id, req.document_id, stored)

    log.info(
        "document indexed",
        request_id=req.request_id,
        document_id=req.document_id,
        knowledge_base_id=req.knowledge_base_id,
        pages=len(pages),
        chunks=count,
    )
    return {"success": True, "chunk_count": count, "page_count": len(pages)}


@app.post("/delete-document", dependencies=[Depends(require_internal_key)])
def delete_document(req: DeleteDocumentRequest) -> dict:
    removed = vector_store.delete_document(req.knowledge_base_id, req.document_id)
    return {"success": True, "removed": removed}


@app.post("/delete-collection", dependencies=[Depends(require_internal_key)])
def delete_collection(req: DeleteCollectionRequest) -> dict:
    removed = vector_store.delete_collection(req.knowledge_base_id)
    return {"success": True, "removed": removed}


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


@app.post("/query", dependencies=[Depends(require_internal_key)])
async def query(req: QueryRequest) -> StreamingResponse:
    """Retrieves, decides groundedness, and streams an answer.

    Event order is fixed: meta, then zero or more token events, then citations,
    then done. Citations come LAST because which sources the answer actually
    used is only known once generation finishes.

    ``events`` is a SYNCHRONOUS generator, on purpose. The provider adapters
    are synchronous (to keep cancellation simple and the Anthropic path
    unchanged), and iterating a blocking generator inside an ``async`` body
    would hold the event loop for the whole multi-second generation -- so
    Starlette could not flush anything, and the entire stream, meta event and
    all, would arrive as one blob at the end. Passing a sync generator instead
    makes Starlette run it in a threadpool (``iterate_in_threadpool``), leaving
    the loop free to flush each token the moment it is produced.
    """

    def events():
        result = retrieve(
            query=req.question,
            collection=collection_name_for(req.knowledge_base_id),
            embedder=embedder,
            store=vector_store,
            top_k=settings.retrieval_top_k,
            score_threshold=settings.retrieval_score_threshold,
        )

        yield _sse(
            {
                "type": "meta",
                "retrieved": len(result.chunks),
                "top_score": result.top_score,
                "grounded": result.grounded,
            }
        )

        # ADR 008: nothing cleared the bar, so the model is never called. The
        # cheapest request in the system is the one we refuse to make.
        if not result.grounded:
            log.info(
                "refused ungrounded question",
                request_id=req.request_id,
                top_score=result.top_score,
                retrieved=len(result.chunks),
            )
            yield _sse({"type": "token", "text": REFUSAL_TEXT})
            yield _sse({"type": "citations", "citations": [], "grounded": False})
            yield _sse({"type": "done"})
            return

        citations = [
            {
                "chunkId": chunk.chunk_id,
                "documentId": chunk.document_id,
                "documentName": chunk.document_name,
                "page": chunk.page,
                "snippet": chunk.text.strip()[:300],
                "score": round(chunk.score, 4),
            }
            for chunk in result.chunks
        ]

        # Provider-aware, no-network config check. For anthropic this is a
        # missing key; for ollama it is always configured (reachability is a
        # runtime question the adapter maps to LLM_UNAVAILABLE). There is no
        # silent fallback to the other provider in either case.
        if not generation_configured(settings):
            log.warn(
                "generation not configured",
                request_id=req.request_id,
                provider=settings.llm_provider,
            )
            yield _sse(
                {
                    "type": "error",
                    "code": "LLM_UNAVAILABLE",
                    "message": (
                        "Answer generation is not configured on this server. "
                        "Retrieval and search still work."
                    ),
                }
            )
        else:
            try:
                for text in generator.stream_answer(
                    GenerationRequest(
                        question=req.question,
                        chunks=result.chunks,
                        history=req.history,
                        request_id=req.request_id,
                    )
                ):
                    yield _sse({"type": "token", "text": text})
            except (GenerationUnavailable, GenerationFailed) as exc:
                # An honest error, NOT a synthesised answer. Streaming the raw
                # retrieved chunks back and labelling them "grounded" would
                # present unprocessed source text as if the system had answered.
                log.warn("generation failed", request_id=req.request_id, reason=str(exc))
                yield _sse({"type": "error", "code": "LLM_UNAVAILABLE", "message": str(exc)})

        # Citations are emitted for every grounded result -- whether generation
        # succeeded, failed, or was not configured. Retrieval succeeded, so the
        # sources are useful even when nothing summarised them.
        yield _sse({"type": "citations", "citations": citations, "grounded": True})
        yield _sse({"type": "done"})

    return StreamingResponse(events(), media_type="text/event-stream")
