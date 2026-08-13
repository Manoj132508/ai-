"""Embedding provider contract. Offline by default.

These test the CONTRACT every provider must satisfy -- dimension, batching,
determinism, normalisation -- not semantic quality. Semantic quality cannot be
asserted in a unit test; it belongs in an evaluation set with labelled
question/passage pairs. Pretending otherwise produces tests that pass while
retrieval is useless.
"""

import math
import os

import pytest
from app.pipeline.embedder import EmbeddingProvider, HashEmbeddingProvider, LocalEmbeddingProvider


@pytest.fixture
def embedder():
    return HashEmbeddingProvider(dimension=384)


def test_satisfies_the_protocol(embedder):
    # runtime_checkable Protocol: this is what guarantees a hosted provider
    # could be dropped in without touching call sites (ADR 005).
    assert isinstance(embedder, EmbeddingProvider)
    assert isinstance(LocalEmbeddingProvider("dummy-model"), EmbeddingProvider)


def test_dimension_is_stable(embedder):
    assert embedder.dimension == 384
    assert len(embedder.embed_query("anything")) == 384


def test_is_deterministic(embedder):
    """Identical text must give an identical vector.

    Re-indexing an unchanged document should be a no-op. A non-deterministic
    embedder would rewrite every vector on every re-index and quietly change
    retrieval results with no content change to explain it.
    """
    assert embedder.embed_query("notice period") == embedder.embed_query("notice period")


def test_different_text_gives_different_vectors(embedder):
    assert embedder.embed_query("apples") != embedder.embed_query("oranges")


def test_batching_preserves_order(embedder):
    """The i-th vector must correspond to the i-th text.

    A reordering bug here attaches every chunk's text to another chunk's
    embedding. Retrieval still returns results and citations still render --
    they are simply, silently, wrong.
    """
    texts = ["first", "second", "third", "fourth"]
    batched = embedder.embed_documents(texts)

    assert len(batched) == len(texts)
    for text, vector in zip(texts, batched, strict=True):
        assert vector == embedder.embed_query(text)


def test_empty_batch_returns_empty(embedder):
    assert embedder.embed_documents([]) == []


def test_vectors_are_unit_length(embedder):
    """Normalised, so cosine similarity is a plain dot product.

    The in-memory test store and Chroma's cosine space both assume this.
    Unnormalised vectors would make longer chunks score higher purely for
    being longer.
    """
    vector = embedder.embed_query("some text")
    magnitude = math.sqrt(sum(value * value for value in vector))
    assert magnitude == pytest.approx(1.0, abs=1e-6)


def test_query_and_document_paths_are_separate_methods(embedder):
    """MiniLM treats them identically; E5 and BGE do not.

    Keeping them apart now means adopting a model that needs `query:` /
    `passage:` prefixes is a change inside one class rather than an audit of
    every call site.
    """
    assert hasattr(embedder, "embed_query")
    assert hasattr(embedder, "embed_documents")


@pytest.mark.needs_model
@pytest.mark.skipif(
    os.environ.get("RUN_MODEL_TESTS") != "1",
    reason="downloads/loads the real model; set RUN_MODEL_TESTS=1 to run",
)
def test_real_model_matches_the_contract():
    """The one test that exercises sentence-transformers for real.

    Opt-in because it needs a ~90MB download and several seconds of load, and
    the rest of the suite must stay hermetic.
    """
    provider = LocalEmbeddingProvider("sentence-transformers/all-MiniLM-L6-v2")
    provider.warm_up()

    assert provider.dimension == 384

    vectors = provider.embed_documents(["notice period", "holiday allowance"])
    assert len(vectors) == 2
    assert all(len(v) == 384 for v in vectors)

    magnitude = math.sqrt(sum(v * v for v in vectors[0]))
    assert magnitude == pytest.approx(1.0, abs=1e-4)

    # A genuine semantic check, the sort a unit test CAN make: paraphrases
    # should sit closer together than unrelated sentences.
    close = provider.embed_documents(
        ["How much notice must I give?", "Employees must provide 30 days written notification."]
    )
    far = provider.embed_documents(
        ["How much notice must I give?", "The cafeteria serves lunch until 2pm."]
    )
    similarity = lambda a, b: sum(x * y for x, y in zip(a, b, strict=True))  # noqa: E731
    assert similarity(*close) > similarity(*far)
