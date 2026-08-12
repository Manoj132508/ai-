"""Semantic retrieval and the grounding decision.

This module owns ADR 008: the rule that the LLM is not called when nothing
relevant was found.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class RetrievedChunk:
    chunk_id: str
    document_id: str
    document_name: str
    page: int | None
    text: str
    score: float


@dataclass(frozen=True)
class RetrievalResult:
    chunks: list[RetrievedChunk]
    top_score: float | None
    grounded: bool
    """False means: do not call the model, answer "not in your documents"."""


class VectorStore(Protocol):
    def query(
        self, collection: str, embedding: list[float], top_k: int
    ) -> list[RetrievedChunk]: ...


def distance_to_similarity(distance: float) -> float:
    """Converts Chroma's cosine DISTANCE into a similarity.

    A classic source of silent bugs: Chroma returns a distance, where SMALLER
    is more similar, while every threshold people write assumes a similarity,
    where LARGER is more similar. Compare a distance against a 0.35 similarity
    threshold and the logic is exactly inverted -- the system confidently
    answers from irrelevant chunks and refuses the relevant ones, while every
    number on screen still looks plausible.

    For normalised vectors, cosine distance is 1 - cosine similarity.
    """
    return 1.0 - distance


def retrieve(
    *,
    query: str,
    collection: str,
    embedder,
    store: VectorStore,
    top_k: int = 5,
    score_threshold: float = 0.35,
) -> RetrievalResult:
    """Embeds the question, fetches the nearest chunks, and decides groundedness.

    THE THRESHOLD IS THE POINT. Cosine similarity always returns a nearest
    neighbour -- there is no "no match". Ask "what is the capital of France?"
    against an HR handbook and five chunks come back, each with a score, all
    irrelevant, and nothing errors. Passing those to the model is precisely how
    a grounded system produces a confident, wrong answer.

    Refusing here is also the cheapest possible request: zero output tokens.
    """
    embedding = embedder.embed_query(query)
    chunks = store.query(collection, embedding, top_k)

    if not chunks:
        # An empty knowledge base, or every vector filtered out.
        return RetrievalResult(chunks=[], top_score=None, grounded=False)

    ranked = sorted(chunks, key=lambda chunk: chunk.score, reverse=True)
    top_score = ranked[0].score

    grounded = top_score >= score_threshold

    # When the answer is refused, the chunks are still returned so the caller
    # can log them. `top_score` is persisted on every message specifically so a
    # badly tuned threshold can be audited later -- it fails SILENTLY, showing
    # the user a polite refusal rather than an error, so nothing else would
    # ever record that it happened.
    return RetrievalResult(chunks=ranked, top_score=top_score, grounded=grounded)
