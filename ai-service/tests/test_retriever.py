"""Retrieval and the grounding decision (ADR 008). Fully offline."""

import pytest
from app.pipeline.embedder import HashEmbeddingProvider
from app.pipeline.retriever import RetrievedChunk, distance_to_similarity, retrieve
from app.pipeline.vector_store import InMemoryVectorStore, StoredChunk, collection_name_for

KB = "kb1"
COLLECTION = collection_name_for(KB)


@pytest.fixture
def embedder():
    return HashEmbeddingProvider(dimension=64)


@pytest.fixture
def store(embedder):
    store = InMemoryVectorStore()
    texts = {
        "c0": "Employees must give 30 days written notification.",
        "c1": "Holiday allowance is 25 days per year.",
        "c2": "Expenses must be submitted within 60 days.",
    }
    store.index_document(
        KB,
        "doc1",
        [
            StoredChunk(
                chunk_id=f"doc1:{i}",
                text=text,
                embedding=embedder.embed_query(text),
                document_id="doc1",
                document_name="handbook.pdf",
                page=i + 1,
            )
            for i, text in enumerate(texts.values())
        ],
    )
    return store


# --- the distance/similarity conversion ------------------------------------


def test_distance_converts_to_similarity():
    """Chroma returns a DISTANCE: smaller is closer.

    Every threshold in this codebase is written as a SIMILARITY: larger is
    closer. Comparing a distance against a similarity threshold inverts the
    entire grounding rule -- the system answers confidently from irrelevant
    chunks and refuses the relevant ones, while every number on screen still
    looks reasonable.
    """
    assert distance_to_similarity(0.0) == 1.0  # identical
    assert distance_to_similarity(1.0) == 0.0  # orthogonal
    assert distance_to_similarity(0.25) == 0.75

    # The ordering must flip.
    assert distance_to_similarity(0.1) > distance_to_similarity(0.9)


# --- grounding --------------------------------------------------------------


def test_exact_match_is_grounded(embedder, store):
    question = "Employees must give 30 days written notification."
    result = retrieve(
        query=question, collection=COLLECTION, embedder=embedder, store=store,
        top_k=3, score_threshold=0.35,
    )

    assert result.grounded is True
    assert result.top_score == pytest.approx(1.0, abs=1e-6)
    assert result.chunks[0].text == question


def test_results_are_ordered_best_first(embedder, store):
    result = retrieve(
        query="Holiday allowance is 25 days per year.", collection=COLLECTION,
        embedder=embedder, store=store, top_k=3, score_threshold=0.0,
    )
    scores = [chunk.score for chunk in result.chunks]
    assert scores == sorted(scores, reverse=True)


def test_unrelated_question_is_refused(embedder, store):
    """The core of ADR 008.

    Cosine similarity ALWAYS returns a nearest neighbour -- there is no
    "no match". Ask about France against an HR handbook and three chunks come
    back with scores, all irrelevant, and nothing errors. Passing those to the
    model is exactly how a grounded system produces a confident wrong answer.
    """
    result = retrieve(
        query="What is the capital of France?", collection=COLLECTION,
        embedder=embedder, store=store, top_k=3, score_threshold=0.35,
    )

    # Chunks still came back...
    assert len(result.chunks) == 3
    # ...but nothing cleared the bar, so the model must not be called.
    assert result.grounded is False
    assert result.top_score < 0.35


def test_chunks_are_returned_even_when_refused(embedder, store):
    """So the caller can log what was retrieved.

    A threshold set too high fails SILENTLY: the user sees a polite refusal
    rather than an error, and nothing else records that it happened.
    top_score is the only evidence that would exist.
    """
    result = retrieve(
        query="Something entirely unrelated to any policy", collection=COLLECTION,
        embedder=embedder, store=store, top_k=3, score_threshold=0.99,
    )
    assert result.grounded is False
    assert result.chunks, "chunks are kept for auditing the threshold"
    assert result.top_score is not None


def test_empty_collection_is_not_grounded(embedder):
    result = retrieve(
        query="anything", collection=collection_name_for("empty"),
        embedder=embedder, store=InMemoryVectorStore(), top_k=5, score_threshold=0.35,
    )
    assert result.chunks == []
    assert result.grounded is False
    assert result.top_score is None


def test_threshold_is_inclusive_at_the_boundary(embedder):
    """A score exactly at the threshold counts as grounded."""

    class FixedStore:
        def query(self, collection, embedding, top_k):
            return [
                RetrievedChunk(
                    chunk_id="c", document_id="d", document_name="f.pdf",
                    page=1, text="t", score=0.35,
                )
            ]

    result = retrieve(
        query="q", collection="c", embedder=embedder, store=FixedStore(),
        top_k=1, score_threshold=0.35,
    )
    assert result.grounded is True


def test_top_k_bounds_the_result_count(embedder, store):
    result = retrieve(
        query="notice", collection=COLLECTION, embedder=embedder, store=store,
        top_k=2, score_threshold=0.0,
    )
    assert len(result.chunks) == 2


# --- the store's own behaviour ----------------------------------------------


def test_reindexing_replaces_rather_than_duplicates(embedder):
    """Delete-then-insert, never upsert.

    Upsert is only idempotent while the chunk count does not shrink. Retune
    the chunker and a document that produced 3 chunks now produces 1: upsert
    overwrites id 0 and leaves ids 1 and 2 as orphans, still searchable,
    holding text that matches no current boundary.
    """
    store = InMemoryVectorStore()

    def chunks(count):
        return [
            StoredChunk(
                chunk_id=f"doc1:{i}", text=f"chunk {i}",
                embedding=embedder.embed_query(f"chunk {i}"),
                document_id="doc1", document_name="f.pdf", page=1,
            )
            for i in range(count)
        ]

    store.index_document(KB, "doc1", chunks(3))
    assert len(store.collections[COLLECTION]) == 3

    store.index_document(KB, "doc1", chunks(1))
    assert len(store.collections[COLLECTION]) == 1, "old vectors must not survive"


def test_deleting_one_document_leaves_the_others(embedder):
    store = InMemoryVectorStore()
    for doc in ("doc1", "doc2"):
        store.index_document(
            KB, doc,
            [StoredChunk(
                chunk_id=f"{doc}:0", text=doc, embedding=embedder.embed_query(doc),
                document_id=doc, document_name=f"{doc}.pdf", page=1,
            )],
        )

    store.delete_document(KB, "doc1")
    remaining = {chunk.document_id for chunk in store.collections[COLLECTION]}
    assert remaining == {"doc2"}
