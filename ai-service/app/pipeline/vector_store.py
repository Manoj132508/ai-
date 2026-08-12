"""ChromaDB vector store.

ONE COLLECTION PER KNOWLEDGE BASE, named ``kb_{knowledge_base_id}``.

Rejected alternative: one shared collection with a ``kb_id`` metadata filter.
Two reasons, and the first is the important one:

* **Security by construction.** With a collection per knowledge base a query
  physically cannot return another tenant's chunks. With a shared collection,
  one forgotten ``where`` clause leaks everything -- the same reasoning as
  scoping the Mongo query instead of checking ownership after the fetch.
* **Deleting a knowledge base is O(1)** -- ``delete_collection`` rather than a
  filtered mass delete.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.core import logging as log
from app.pipeline.retriever import RetrievedChunk, distance_to_similarity


@dataclass(frozen=True)
class StoredChunk:
    """A chunk ready to be written to the store."""

    chunk_id: str
    text: str
    embedding: list[float]
    document_id: str
    document_name: str
    page: int


def collection_name_for(knowledge_base_id: str) -> str:
    return f"kb_{knowledge_base_id}"


class ChromaVectorStore:
    def __init__(self, client) -> None:
        self._client = client

    def _collection(self, name: str, *, create: bool = False):
        if create:
            # Cosine, explicitly. Chroma's default is L2, and on normalised
            # vectors L2 and cosine rank identically -- so a wrong space here
            # produces plausible-looking results with subtly wrong DISTANCE
            # VALUES, which then compare wrongly against the score threshold.
            return self._client.get_or_create_collection(
                name=name, metadata={"hnsw:space": "cosine"}
            )
        try:
            return self._client.get_collection(name)
        except Exception:
            # A knowledge base with nothing indexed yet has no collection.
            # That is an empty result, not an error.
            return None

    def index_document(
        self, knowledge_base_id: str, document_id: str, chunks: list[StoredChunk]
    ) -> int:
        """Replaces all vectors for one document.

        DELETE-THEN-INSERT, never upsert.

        Upsert is only idempotent while the chunk count does not shrink. Retune
        the chunker from 800 to 1000 characters and a document that produced 87
        chunks now produces 65: upsert overwrites ids 0-64 and leaves 65-86 in
        place as orphans, holding text that matches no current chunk boundary
        and staying searchable forever. Deleting first makes re-indexing
        genuinely idempotent regardless of how the count moves.
        """
        name = collection_name_for(knowledge_base_id)
        collection = self._collection(name, create=True)

        self._delete_document_vectors(collection, document_id)

        if not chunks:
            return 0

        collection.add(
            ids=[chunk.chunk_id for chunk in chunks],
            embeddings=[chunk.embedding for chunk in chunks],
            documents=[chunk.text for chunk in chunks],
            metadatas=[
                {
                    "document_id": chunk.document_id,
                    # Denormalised so rendering five citations does not mean
                    # five database lookups on the hot path of every answer.
                    "document_name": chunk.document_name,
                    "page": chunk.page,
                }
                for chunk in chunks
            ],
        )
        return len(chunks)

    @staticmethod
    def _delete_document_vectors(collection, document_id: str) -> None:
        if collection is None:
            return
        collection.delete(where={"document_id": document_id})

    def delete_document(self, knowledge_base_id: str, document_id: str) -> bool:
        collection = self._collection(collection_name_for(knowledge_base_id))
        if collection is None:
            # Nothing to delete means the goal is already met. Treating this
            # as an error would abort the caller's cascading delete partway.
            return False
        collection.delete(where={"document_id": document_id})
        return True

    def delete_collection(self, knowledge_base_id: str) -> bool:
        try:
            self._client.delete_collection(collection_name_for(knowledge_base_id))
            return True
        except Exception as exc:
            log.warn(
                "collection not found during delete",
                knowledge_base_id=knowledge_base_id,
                reason=str(exc),
            )
            return False

    def query(self, collection: str, embedding: list[float], top_k: int) -> list[RetrievedChunk]:
        col = self._collection(collection)
        if col is None:
            return []

        results = col.query(
            query_embeddings=[embedding],
            n_results=top_k,
            include=["documents", "metadatas", "distances"],
        )

        ids = (results.get("ids") or [[]])[0]
        if not ids:
            return []

        documents = results["documents"][0]
        metadatas = results["metadatas"][0]
        distances = results["distances"][0]

        return [
            RetrievedChunk(
                chunk_id=chunk_id,
                document_id=(meta or {}).get("document_id", ""),
                document_name=(meta or {}).get("document_name", ""),
                page=(meta or {}).get("page"),
                text=text,
                # Chroma returns a DISTANCE. Converting here, once, at the
                # boundary, means nothing downstream can compare a distance
                # against a similarity threshold and invert the whole rule.
                score=distance_to_similarity(distance),
            )
            for chunk_id, text, meta, distance in zip(
                ids, documents, metadatas, distances, strict=False
            )
        ]


class InMemoryVectorStore:
    """Test double. Exact cosine, no Chroma, no disk."""

    def __init__(self) -> None:
        self.collections: dict[str, list[StoredChunk]] = {}

    def index_document(
        self, knowledge_base_id: str, document_id: str, chunks: list[StoredChunk]
    ) -> int:
        name = collection_name_for(knowledge_base_id)
        existing = [c for c in self.collections.get(name, []) if c.document_id != document_id]
        self.collections[name] = existing + list(chunks)
        return len(chunks)

    def delete_document(self, knowledge_base_id: str, document_id: str) -> bool:
        name = collection_name_for(knowledge_base_id)
        if name not in self.collections:
            return False
        self.collections[name] = [
            c for c in self.collections[name] if c.document_id != document_id
        ]
        return True

    def delete_collection(self, knowledge_base_id: str) -> bool:
        return self.collections.pop(collection_name_for(knowledge_base_id), None) is not None

    def query(self, collection: str, embedding: list[float], top_k: int) -> list[RetrievedChunk]:
        stored = self.collections.get(collection, [])
        scored = [
            RetrievedChunk(
                chunk_id=chunk.chunk_id,
                document_id=chunk.document_id,
                document_name=chunk.document_name,
                page=chunk.page,
                text=chunk.text,
                score=sum(a * b for a, b in zip(embedding, chunk.embedding, strict=False)),
            )
            for chunk in stored
        ]
        return sorted(scored, key=lambda c: c.score, reverse=True)[:top_k]
