"""Integration tests for the Python FastAPI RAG microservice."""

import pytest
from fastapi.testclient import TestClient
from app.main import app, settings, embedder
from app.pipeline.embedder import HashEmbeddingProvider

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
