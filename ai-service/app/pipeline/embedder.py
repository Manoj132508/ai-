"""Embedding providers.

The interface exists so ADR 005's "swap the local model for a hosted one
without touching call sites" is a real property rather than an aspiration.
Nothing downstream knows which implementation it holds -- the retriever only
needs a vector and a dimension.
"""

from __future__ import annotations

import hashlib
import math
from typing import Protocol, runtime_checkable


@runtime_checkable
class EmbeddingProvider(Protocol):
    """Turns text into vectors.

    ``embed_documents`` and ``embed_query`` are separate methods even though
    MiniLM treats them identically. Several stronger models do not: E5 and BGE
    require ``query:`` / ``passage:`` prefixes, and using the wrong one costs
    real retrieval quality. Splitting them now means adopting such a model is
    a change inside one class rather than an audit of every call site.
    """

    @property
    def dimension(self) -> int: ...

    def embed_documents(self, texts: list[str]) -> list[list[float]]: ...

    def embed_query(self, text: str) -> list[float]: ...


class LocalEmbeddingProvider:
    """sentence-transformers, running on CPU.

    Free per call, works offline, and needs no API key -- which is what lets
    indexing be unlimited and the test suite be hermetic (ADR 005). The cost is
    a ~90MB model download on first use and a few hundred MB of resident
    memory.

    The model is loaded LAZILY but should be warmed at startup. Left to load on
    first use, the first question after every deploy pays a ~10 second penalty
    that looks like a slow query rather than a cold model.
    """

    def __init__(self, model_name: str, *, batch_size: int = 32) -> None:
        self._model_name = model_name
        self._batch_size = batch_size
        self._model = None

    def warm_up(self) -> None:
        self._load()

    def _load(self):
        if self._model is None:
            # Imported here, not at module scope: importing
            # sentence-transformers drags in torch and costs seconds, which
            # would be paid by every test run and every CLI invocation that
            # never embeds anything.
            from sentence_transformers import SentenceTransformer

            self._model = SentenceTransformer(self._model_name, device="cpu")
        return self._model

    @property
    def dimension(self) -> int:
        return self._load().get_sentence_embedding_dimension()

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        model = self._load()
        # Batched, and normalised so cosine similarity is a plain dot product
        # and Chroma's cosine distance behaves predictably.
        vectors = model.encode(
            texts,
            batch_size=self._batch_size,
            normalize_embeddings=True,
            show_progress_bar=False,
            convert_to_numpy=True,
        )
        return [vector.tolist() for vector in vectors]

    def embed_query(self, text: str) -> list[float]:
        return self.embed_documents([text])[0]


class HashEmbeddingProvider:
    """Deterministic fake for tests. Never used in production.

    Real embeddings would make the suite depend on a 90MB download and several
    seconds of model load, so the tests that exercise *pipeline contracts*
    (dimension, batching, determinism, retrieval ordering) use this instead.
    What it cannot test is semantic quality -- and neither could a unit test
    with the real model, which is why that belongs in an evaluation set rather
    than in pytest.

    Vectors are derived from a SHA-256 of the text, so identical text always
    produces an identical vector and different text almost never collides.
    """

    def __init__(self, dimension: int = 384) -> None:
        self._dimension = dimension

    @property
    def dimension(self) -> int:
        return self._dimension

    def _vector(self, text: str) -> list[float]:
        raw = b""
        counter = 0
        # Stretch the digest until there is a byte per dimension.
        while len(raw) < self._dimension:
            raw += hashlib.sha256(f"{counter}:{text}".encode()).digest()
            counter += 1

        values = [(byte / 255.0) - 0.5 for byte in raw[: self._dimension]]
        norm = math.sqrt(sum(value * value for value in values)) or 1.0
        return [value / norm for value in values]

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return [self._vector(text) for text in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._vector(text)
