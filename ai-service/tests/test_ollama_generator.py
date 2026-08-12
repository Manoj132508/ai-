"""Ollama adapter tests. Fully offline -- no server, no network, no key.

Every path is exercised with an injected httpx client backed by a
MockTransport, or a small stream spy for the cancellation case. Nothing here
requires Ollama to be installed or running.
"""

import json

import httpx
import pytest
from app.pipeline.base import GenerationFailed, GenerationRequest, GenerationUnavailable
from app.pipeline.ollama_generator import OllamaGenerator
from app.pipeline.retriever import RetrievedChunk

CHUNKS = [
    RetrievedChunk(
        chunk_id="doc1:0", document_id="doc1", document_name="handbook.pdf", page=12,
        text="Termination by the employee requires 30 days written notification.", score=0.78,
    ),
]
REQUEST = GenerationRequest(question="How much notice?", chunks=CHUNKS, history=[])


def ndjson(*objects: dict) -> bytes:
    """Ollama streams newline-delimited JSON, one object per token."""
    return ("\n".join(json.dumps(o) for o in objects) + "\n").encode()


def token(text: str, done: bool = False, done_reason: str | None = None) -> dict:
    obj = {"model": "llama3.2:3b", "message": {"role": "assistant", "content": text}, "done": done}
    if done_reason is not None:
        obj["done_reason"] = done_reason
    return obj


def client_returning(response_factory) -> httpx.Client:
    """A real httpx.Client whose transport is a mock -- faithful iter_lines /
    json parsing without a server."""
    return httpx.Client(transport=httpx.MockTransport(response_factory))


def collect(gen) -> list[str]:
    return list(gen)


# --- happy path --------------------------------------------------------------


def test_streams_multiple_tokens_in_order():
    """The point of streaming: several token events, in order, not one blob."""
    body = ndjson(
        token("You must give "),
        token("30 days "),
        token("notice. [1]"),
        token("", done=True, done_reason="stop"),
    )
    client = client_returning(lambda req: httpx.Response(200, content=body))
    gen = OllamaGenerator(model="llama3.2:3b", client=client)

    assert collect(gen.stream_answer(REQUEST)) == ["You must give ", "30 days ", "notice. [1]"]


def test_final_done_metadata_is_handled():
    """A done:true line with a stop reason ends the stream cleanly and yields
    no extra token (its content is empty)."""
    body = ndjson(token("Answer."), token("", done=True, done_reason="stop"))
    client = client_returning(lambda req: httpx.Response(200, content=body))
    gen = OllamaGenerator(client=client)
    assert collect(gen.stream_answer(REQUEST)) == ["Answer."]


def test_truncation_reason_still_returns_the_partial_answer():
    """done_reason == 'length' means num_predict was hit. Logged, not raised --
    a truncated answer is still worth showing (mirrors Anthropic max_tokens)."""
    body = ndjson(token("A very long "), token("", done=True, done_reason="length"))
    client = client_returning(lambda req: httpx.Response(200, content=body))
    gen = OllamaGenerator(client=client)
    assert collect(gen.stream_answer(REQUEST)) == ["A very long "]


def test_empty_generation_yields_nothing_and_does_not_raise():
    """A clean stream with no content. No tokens, no error -- the Node layer
    then persists nothing (requirement: no empty successful message)."""
    body = ndjson(token("", done=True, done_reason="stop"))
    client = client_returning(lambda req: httpx.Response(200, content=body))
    gen = OllamaGenerator(client=client)
    assert collect(gen.stream_answer(REQUEST)) == []


# --- failure mapping ---------------------------------------------------------


def test_connection_failure_maps_to_unavailable():
    """Server not running. The common local case -> GenerationUnavailable,
    which main.py turns into LLM_UNAVAILABLE."""
    def boom(req):
        raise httpx.ConnectError("connection refused")

    gen = OllamaGenerator(client=client_returning(boom))
    with pytest.raises(GenerationUnavailable, match="not reachable"):
        collect(gen.stream_answer(REQUEST))


def test_non_success_status_maps_to_failed():
    client = client_returning(lambda req: httpx.Response(500, content=b"boom"))
    gen = OllamaGenerator(client=client)
    with pytest.raises(GenerationFailed, match="returned an error"):
        collect(gen.stream_answer(REQUEST))


def test_timeout_maps_to_failed():
    def slow(req):
        raise httpx.ReadTimeout("timed out")

    gen = OllamaGenerator(client=client_returning(slow))
    with pytest.raises(GenerationFailed, match="timed out"):
        collect(gen.stream_answer(REQUEST))


def test_malformed_json_maps_to_failed():
    """A line that is not JSON must not crash the stream with an unmapped
    exception -- it becomes GenerationFailed."""
    body = b'{"message": {"content": "ok"}, "done": false}\nnot json at all\n'
    client = client_returning(lambda req: httpx.Response(200, content=body))
    gen = OllamaGenerator(client=client)
    with pytest.raises(GenerationFailed, match="unexpected response"):
        collect(gen.stream_answer(REQUEST))


def test_error_object_midstream_maps_to_failed():
    """Ollama reports a model-side error as {"error": ...} once streaming."""
    body = ndjson(token("partial "), {"error": "model not found"})
    client = client_returning(lambda req: httpx.Response(200, content=body))
    gen = OllamaGenerator(client=client)

    produced = []
    with pytest.raises(GenerationFailed):
        for text in gen.stream_answer(REQUEST):
            produced.append(text)
    # The partial token before the error is still delivered.
    assert produced == ["partial "]


# --- request shape -----------------------------------------------------------


def test_payload_carries_system_prompt_sources_and_num_predict():
    captured = {}

    def handler(request):
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, content=ndjson(token("ok", done=True, done_reason="stop")))

    gen = OllamaGenerator(model="llama3.2:3b", max_tokens=4096, client=client_returning(handler))
    collect(gen.stream_answer(REQUEST))

    body = captured["body"]
    assert body["model"] == "llama3.2:3b"
    assert body["stream"] is True
    assert body["options"]["num_predict"] == 4096
    roles = [m["role"] for m in body["messages"]]
    assert roles[0] == "system"
    assert roles[-1] == "user"
    assert "Sources:" in body["messages"][-1]["content"]
    assert "handbook.pdf" in body["messages"][-1]["content"]


def test_request_id_forwarded_as_header():
    captured = {}

    def handler(request):
        captured["id"] = request.headers.get("X-Request-Id")
        return httpx.Response(200, content=ndjson(token("ok", done=True, done_reason="stop")))

    gen = OllamaGenerator(client=client_returning(handler))
    req = GenerationRequest(question="q", chunks=CHUNKS, history=[], request_id="trace-123")
    collect(gen.stream_answer(req))

    assert captured["id"] == "trace-123"


def test_no_request_id_sends_no_header():
    captured = {}

    def handler(request):
        captured["id"] = request.headers.get("X-Request-Id")
        return httpx.Response(200, content=ndjson(token("ok", done=True, done_reason="stop")))

    gen = OllamaGenerator(client=client_returning(handler))
    collect(gen.stream_answer(REQUEST))  # request_id is None
    assert captured["id"] is None


# --- cancellation ------------------------------------------------------------


class _SpyStream(httpx.SyncByteStream):
    """A byte stream that records when it is closed, so we can prove the
    upstream response is closed on cancellation."""

    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks
        self.closed = False

    def __iter__(self):
        yield from self._chunks

    def close(self) -> None:
        self.closed = True


def test_cancellation_closes_the_upstream_response():
    """Closing the generator mid-stream must close the httpx response, which
    stops Ollama generating for an answer nobody will read. Also verifies
    GeneratorExit is not swallowed by the broad httpx.HTTPError handler."""
    spy = _SpyStream([
        ndjson(token("first ")),
        ndjson(token("second ")),
        ndjson(token("third ")),
    ])

    client = client_returning(lambda req: httpx.Response(200, stream=spy))
    gen = OllamaGenerator(client=client)

    stream = gen.stream_answer(REQUEST)
    assert next(stream) == "first "
    assert spy.closed is False, "still open mid-answer"

    stream.close()  # what a client disconnect ultimately triggers

    assert spy.closed is True, "upstream response must be closed on cancellation"


def test_injected_client_is_not_closed_by_the_adapter():
    """An injected client belongs to the caller; only an internally-created
    one is closed. (The adapter closes the response, never the caller's client.)"""
    client = client_returning(lambda req: httpx.Response(200, content=ndjson(
        token("ok", done=True, done_reason="stop"))))
    gen = OllamaGenerator(client=client)
    collect(gen.stream_answer(REQUEST))
    assert not client.is_closed, "the adapter must not close a client it did not create"


# --- no secrets --------------------------------------------------------------


def test_error_messages_carry_no_internals():
    """User-facing failure messages never leak a URL, status body or token."""
    client = client_returning(lambda req: httpx.Response(503, content=b"internal: 10.0.0.4 boom"))
    gen = OllamaGenerator(base_url="http://secret-host:11434", client=client)
    with pytest.raises(GenerationFailed) as caught:
        collect(gen.stream_answer(REQUEST))

    message = str(caught.value)
    assert "10.0.0.4" not in message
    assert "secret-host" not in message
