"""Integration tests for the Python FastAPI RAG microservice."""

from app.main import app, settings
from app.pipeline.embedder import HashEmbeddingProvider
from fastapi.testclient import TestClient

client = TestClient(app)

INTERNAL_KEY = settings.internal_api_key
HEADERS = {"X-Internal-Key": INTERNAL_KEY}


def test_health_check():
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    # "ok" / "degraded", matching the Node health endpoint. Two services
    # reporting health with different vocabularies means two things to learn
    # and two dashboards to write.
    assert data["status"] == "ok"
    assert data["service"] == "ai-service"
    assert "generation_available" in data
    # The health endpoint now reports which provider is selected.
    assert data["provider"] == settings.llm_provider
    # A boolean, never a key or other secret.
    assert isinstance(data["generation_available"], bool)


def test_index_rejects_missing_internal_key(tmp_path):
    doc_path = tmp_path / "test.txt"
    doc_path.write_text("Sample document text.")

    payload = {
        "document_id": "doc123",
        "knowledge_base_id": "kb123",
        "file_path": str(doc_path),
        "filename": "test.txt",
        "mime_type": "text/plain"
    }

    # Missing X-Internal-Key header
    response = client.post("/index", json=payload)
    assert response.status_code == 401


def test_index_and_query_flow(tmp_path, monkeypatch):
    # Use deterministic HashEmbeddingProvider to keep unit tests fast and offline
    fake_embedder = HashEmbeddingProvider(dimension=384)
    monkeypatch.setattr("app.main.embedder", fake_embedder)

    doc_path = tmp_path / "policy.txt"
    doc_path.write_text("Company termination policy requires 30 days written notification.")

    kb_id = "kb_test_1"
    doc_id = "doc_test_1"

    # 1. Index Document
    index_payload = {
        "document_id": doc_id,
        "knowledge_base_id": kb_id,
        "file_path": str(doc_path),
        "filename": "policy.txt",
        "mime_type": "text/plain"
    }

    response = client.post("/index", json=index_payload, headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["success"] is True
    assert response.json()["chunk_count"] > 0

    # 2. Delete Document Cleanup
    del_payload = {"knowledge_base_id": kb_id, "document_id": doc_id}
    del_res = client.post("/delete-document", json=del_payload, headers=HEADERS)
    assert del_res.status_code == 200

    # 3. Delete Collection Cleanup
    col_del_payload = {"knowledge_base_id": kb_id}
    col_res = client.post("/delete-collection", json=col_del_payload, headers=HEADERS)
    assert col_res.status_code == 200


def test_grounding_refusal_never_calls_the_provider(tmp_path, monkeypatch):
    """ADR 008 is provider-independent: a below-threshold question is refused
    before generation, so NEITHER provider is touched. Proven by installing a
    generator that fails the test if it is ever called."""
    fake_embedder = HashEmbeddingProvider(dimension=384)
    monkeypatch.setattr("app.main.embedder", fake_embedder)

    class ExplodingGenerator:
        def stream_answer(self, request):
            raise AssertionError("provider called for an ungrounded question")

    monkeypatch.setattr("app.main.generator", ExplodingGenerator())

    doc_path = tmp_path / "policy.txt"
    doc_path.write_text("Company holiday allowance is 25 days per year.")

    kb_id, doc_id = "kb_refuse", "doc_refuse"
    client.post(
        "/index",
        headers=HEADERS,
        json={
            "document_id": doc_id,
            "knowledge_base_id": kb_id,
            "file_path": str(doc_path),
            "filename": "policy.txt",
            "mime_type": "text/plain",
        },
    )

    try:
        # Entirely unrelated to the document -> below the score threshold.
        resp = client.post(
            "/query",
            headers=HEADERS,
            json={"question": "What is the capital of France?", "knowledge_base_id": kb_id},
        )
        assert resp.status_code == 200
        body = resp.text
        assert '"grounded": false' in body
        assert "I couldn't find this in your documents" in body
        # The provider was never invoked (or the ExplodingGenerator would have
        # failed the test) and no LLM error was emitted.
        assert "LLM_UNAVAILABLE" not in body
    finally:
        client.post("/delete-collection", json={"knowledge_base_id": kb_id}, headers=HEADERS)
