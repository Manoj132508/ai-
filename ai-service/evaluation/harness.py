"""Runs the fixed dataset through the REAL pipeline and collects raw results.

This imports the actual pipeline modules -- extractor, chunker, embedder,
vector store, retriever, prompt, generator -- so the eval measures the shipping
code, not a re-implementation of it. The only substitution is a throwaway Chroma
store in a temp directory, so a run never touches the real vector data.

Two tiers:
- retrieval + refusal (always): deterministic given the fixed embedding model.
- generation (opt-in): needs a live LLM provider, so it is nondeterministic and
  never gates CI.
"""

from __future__ import annotations

import asyncio
from contextlib import aclosing
from dataclasses import dataclass, field
from pathlib import Path

from app.core.config import Settings
from app.pipeline.base import GenerationFailed, GenerationRequest, GenerationUnavailable
from app.pipeline.chunker import chunk_pages
from app.pipeline.extractor import extract_pages
from app.pipeline.provider_factory import build_generator, generation_configured
from app.pipeline.retriever import RetrievedChunk, retrieve
from app.pipeline.vector_store import StoredChunk, collection_name_for

from evaluation.dataset import DATASET, EvalQuestion

CORPUS_DIR = Path(__file__).parent / "corpus"
EVAL_KB = "evaluation-corpus"


@dataclass
class QuestionResult:
    q: EvalQuestion
    top_score: float | None
    grounded: bool
    retrieved_docs: list[str]          # document name per retrieved chunk, in rank order
    chunks: list[RetrievedChunk] = field(default_factory=list)
    # generation tier (populated only when --generation is used)
    generated: bool = False
    answer: str | None = None


def index_corpus(embedder, store, settings: Settings) -> int:
    """Indexes every corpus file into the throwaway store, using the real chunker
    and embedder. Returns the number of chunks written."""
    total = 0
    for path in sorted(CORPUS_DIR.glob("*.md")):
        pages = extract_pages(str(path), "text/markdown")
        chunks = chunk_pages(
            pages, chunk_size=settings.chunk_size, chunk_overlap=settings.chunk_overlap
        )
        if not chunks:
            continue
        embeddings = embedder.embed_documents([c.text for c in chunks])
        doc_id = path.name  # e.g. "handbook.md" -- also the citable document name
        stored = [
            StoredChunk(
                chunk_id=f"{doc_id}:{c.index}",
                text=c.text,
                embedding=emb,
                document_id=doc_id,
                document_name=path.name,
                page=c.page,
            )
            for c, emb in zip(chunks, embeddings, strict=True)
        ]
        total += store.index_document(EVAL_KB, doc_id, stored)
    return total


def run_retrieval(embedder, store, settings: Settings) -> list[QuestionResult]:
    """Tier A: retrieve for every question and record the grounding decision."""
    results: list[QuestionResult] = []
    for q in DATASET:
        r = retrieve(
            query=q.question,
            collection=collection_name_for(EVAL_KB),
            embedder=embedder,
            store=store,
            top_k=settings.retrieval_top_k,
            score_threshold=settings.retrieval_score_threshold,
        )
        results.append(
            QuestionResult(
                q=q,
                top_score=r.top_score,
                grounded=r.grounded,
                retrieved_docs=[c.document_name for c in r.chunks],
                chunks=r.chunks,
            )
        )
    return results


async def _generate(generator, question: str, chunks: list[RetrievedChunk]) -> str:
    req = GenerationRequest(question=question, chunks=chunks, history=[], request_id=None)
    parts: list[str] = []
    try:
        async with aclosing(generator.astream_answer(req)) as stream:
            async for text in stream:
                parts.append(text)
    except (GenerationUnavailable, GenerationFailed):
        return ""
    return "".join(parts)


def run_generation(results: list[QuestionResult], settings: Settings) -> None:
    """Tier B (opt-in): generate an answer for every GROUNDED question.

    Grounded answerable questions test citation and answer quality; grounded
    UNanswerable ones (a threshold false-answer) test the prompt's second-layer
    refusal. Ungrounded questions never reach the model, so there is nothing to
    generate."""
    if not generation_configured(settings):
        raise RuntimeError(
            f"generation tier requested but provider '{settings.llm_provider}' is not "
            "configured (for anthropic, set ANTHROPIC_API_KEY; for ollama, start it)."
        )
    generator = build_generator(settings)

    async def run_all() -> None:
        for res in results:
            if not res.grounded:
                continue
            res.answer = await _generate(generator, res.q.question, res.chunks)
            res.generated = True

    asyncio.run(run_all())
