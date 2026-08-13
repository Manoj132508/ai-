"""Ollama adapter tests. Fully offline -- no server, no network, no key.

The adapter is natively async, so these are async tests driven by an injected
httpx.AsyncClient backed by a MockTransport, plus an async stream spy for the
cancellation case. Nothing here requires Ollama to be installed or running.
"""

import asyncio
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


def client_returning(response_factory) -> httpx.AsyncClient:
    """A real httpx.AsyncClient whose transport is a mock -- faithful
    aiter_lines / json parsing without a server."""
    return httpx.AsyncClient(transport=httpx.MockTransport(response_factory))


async def collect(agen) -> list[str]:
    return [item async for item in agen]


# --- happy path --------------------------------------------------------------


async def test_streams_multiple_tokens_in_order():
    """The point of streaming: several token events, in order, not one blob."""
    body = ndjson(
        token("You must give "),
        token("30 days "),
        token("notice. [1]"),
        token("", done=True, done_reason="stop"),
    )
    client = client_returning(lambda req: httpx.Response(200, content=body))
    gen = OllamaGenerator(model="llama3.2:3b", client=client)

    assert await collect(gen.astream_answer(REQUEST)) == [
        "You must give ", "30 days ", "notice. [1]"
    ]


async def test_final_done_metadata_is_handled():
    """A done:true line with a stop reason ends the stream cleanly."""
    body = ndjson(token("Answer."), token("", done=True, done_reason="stop"))
    client = client_returning(lambda req: httpx.Response(200, content=body))
    gen = OllamaGenerator(client=client)
    assert await collect(gen.astream_answer(REQUEST)) == ["Answer."]


async def test_stops_at_terminal_done_ignoring_later_lines():
    """Anything Ollama sends AFTER done: true is ignored, not appended."""
    body = ndjson(
        token("Real answer."),
        token("", done=True, done_reason="stop"),
        token(" LEAKED extra tokens after done"),  # must never appear
    )
    client = client_returning(lambda req: httpx.Response(200, content=body))
    gen = OllamaGenerator(client=client)
    assert await collect(gen.astream_answer(REQUEST)) == ["Real answer."]


async def test_truncation_reason_still_returns_the_partial_answer():
    """done_reason == 'length' means num_predict was hit. Logged, not raised."""
    body = ndjson(token("A very long "), token("", done=True, done_reason="length"))
    client = client_returning(lambda req: httpx.Response(200, content=body))
    gen = OllamaGenerator(client=client)
    assert await collect(gen.astream_answer(REQUEST)) == ["A very long "]


async def test_empty_generation_yields_nothing_and_does_not_raise():
    """A clean stream with a terminal event but no content. No tokens, no
    error -- the Node layer then persists nothing."""
    body = ndjson(token("", done=True, done_reason="stop"))
    client = client_returning(lambda req: httpx.Response(200, content=body))
    gen = OllamaGenerator(client=client)
    assert await collect(gen.astream_answer(REQUEST)) == []


# --- premature end -----------------------------------------------------------


async def test_stream_without_terminal_done_is_a_failure():
    """A stream that ends without done: true is incomplete. Its partial text
    must NOT be returned as a successful answer."""
    body = ndjson(token("Half an answer"), token(" and then the server vanished"))
    client = client_returning(lambda req: httpx.Response(200, content=body))
    gen = OllamaGenerator(client=client)
    with pytest.raises(GenerationFailed, match="ended unexpectedly"):
        await collect(gen.astream_answer(REQUEST))


async def test_dropped_connection_midstream_is_a_failure():
    """A connection that drops mid-body raises an httpx error -> GenerationFailed."""
    def drop(request):
        # A stream that raises partway looks like a RemoteProtocolError.
        raise httpx.ReadError("connection reset")

    gen = OllamaGenerator(client=client_returning(drop))
    with pytest.raises(GenerationFailed):
        await collect(gen.astream_answer(REQUEST))


# --- failure mapping ---------------------------------------------------------


async def test_connection_failure_maps_to_unavailable():
    def boom(request):
        raise httpx.ConnectError("connection refused")

    gen = OllamaGenerator(client=client_returning(boom))
    with pytest.raises(GenerationUnavailable, match="not reachable"):
        await collect(gen.astream_answer(REQUEST))


async def test_non_success_status_maps_to_failed():
    client = client_returning(lambda req: httpx.Response(500, content=b"boom"))
    gen = OllamaGenerator(client=client)
    with pytest.raises(GenerationFailed, match="returned an error"):
        await collect(gen.astream_answer(REQUEST))


async def test_timeout_maps_to_failed():
    def slow(request):
        raise httpx.ReadTimeout("timed out")

    gen = OllamaGenerator(client=client_returning(slow))
    with pytest.raises(GenerationFailed, match="timed out"):
        await collect(gen.astream_answer(REQUEST))


# --- malformed schemas -------------------------------------------------------


async def test_malformed_json_maps_to_failed():
    body = b'{"message": {"content": "ok"}, "done": false}\nnot json at all\n'
    client = client_returning(lambda req: httpx.Response(200, content=body))
    gen = OllamaGenerator(client=client)
    with pytest.raises(GenerationFailed, match="unexpected response"):
        await collect(gen.astream_answer(REQUEST))


async def test_message_not_a_dict_maps_to_failed():
    """Valid JSON, wrong schema: message is a string. Must NOT escape as
    AttributeError."""
    body = ndjson({"message": "not an object", "done": False})
    client = client_returning(lambda req: httpx.Response(200, content=body))
    gen = OllamaGenerator(client=client)
    with pytest.raises(GenerationFailed, match="unexpected response"):
        await collect(gen.astream_answer(REQUEST))


async def test_content_not_a_string_maps_to_failed():
    body = ndjson({"message": {"content": 12345}, "done": False})
    client = client_returning(lambda req: httpx.Response(200, content=body))
    gen = OllamaGenerator(client=client)
    with pytest.raises(GenerationFailed, match="unexpected response"):
        await collect(gen.astream_answer(REQUEST))


async def test_top_level_not_an_object_maps_to_failed():
    body = b'["a", "list", "not", "an", "object"]\n'
    client = client_returning(lambda req: httpx.Response(200, content=body))
    gen = OllamaGenerator(client=client)
    with pytest.raises(GenerationFailed, match="unexpected response"):
        await collect(gen.astream_answer(REQUEST))


async def test_error_object_midstream_maps_to_failed():
    body = ndjson(token("partial "), {"error": "model not found"})
    client = client_returning(lambda req: httpx.Response(200, content=body))
    gen = OllamaGenerator(client=client)

    produced = []
    with pytest.raises(GenerationFailed):
        async for text in gen.astream_answer(REQUEST):
            produced.append(text)
    assert produced == ["partial "]


# --- request shape -----------------------------------------------------------


async def test_payload_carries_system_prompt_sources_and_num_predict():
    captured = {}

    def handler(request):
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, content=ndjson(token("ok", done=True, done_reason="stop")))

    gen = OllamaGenerator(model="llama3.2:3b", max_tokens=4096, client=client_returning(handler))
    await collect(gen.astream_answer(REQUEST))

    body = captured["body"]
    assert body["model"] == "llama3.2:3b"
    assert body["stream"] is True
    assert body["options"]["num_predict"] == 4096
    roles = [m["role"] for m in body["messages"]]
    assert roles[0] == "system"
    assert roles[-1] == "user"
    assert "Sources:" in body["messages"][-1]["content"]
    assert "handbook.pdf" in body["messages"][-1]["content"]


async def test_request_id_forwarded_as_header():
    captured = {}

    def handler(request):
        captured["id"] = request.headers.get("X-Request-Id")
        return httpx.Response(200, content=ndjson(token("ok", done=True, done_reason="stop")))

    gen = OllamaGenerator(client=client_returning(handler))
    req = GenerationRequest(question="q", chunks=CHUNKS, history=[], request_id="trace-123")
    await collect(gen.astream_answer(req))

    assert captured["id"] == "trace-123"


async def test_no_request_id_sends_no_header():
    captured = {}

    def handler(request):
        captured["id"] = request.headers.get("X-Request-Id")
        return httpx.Response(200, content=ndjson(token("ok", done=True, done_reason="stop")))

    gen = OllamaGenerator(client=client_returning(handler))
    await collect(gen.astream_answer(REQUEST))
    assert captured["id"] is None


# --- cancellation ------------------------------------------------------------


class _AsyncSpyStream(httpx.AsyncByteStream):
    """An async byte stream that records when it is closed, so we can prove the
    upstream response is closed on cancellation. Yields slowly so a consumer
    can be cancelled mid-stream."""

    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks
        self.closed = False

    async def __aiter__(self):
        for chunk in self._chunks:
            await asyncio.sleep(0.05)
            yield chunk

    async def aclose(self) -> None:
        self.closed = True


async def test_cancellation_closes_the_upstream_response():
    """Cancelling the consuming task closes the httpx response promptly, which
    stops Ollama generating for an answer nobody will read -- genuine async
    cancellation, not best-effort."""
    spy = _AsyncSpyStream([
        ndjson(token("first ")),
        ndjson(token("second ")),
        ndjson(token("third ")),
    ])
    client = client_returning(lambda req: httpx.Response(200, stream=spy))
    gen = OllamaGenerator(client=client)

    agen = gen.astream_answer(REQUEST)
    first = await agen.__anext__()
    assert first == "first "
    assert spy.closed is False

    # Simulate the /query task being cancelled on client disconnect.
    await agen.aclose()

    assert spy.closed is True, "upstream response must be closed on cancellation"


async def test_injected_client_is_not_closed_by_the_adapter():
    client = client_returning(lambda req: httpx.Response(200, content=ndjson(
        token("ok", done=True, done_reason="stop"))))
    gen = OllamaGenerator(client=client)
    await collect(gen.astream_answer(REQUEST))
    assert not client.is_closed, "the adapter must not close a client it did not create"


# --- no secrets --------------------------------------------------------------


async def test_error_messages_carry_no_internals():
    client = client_returning(lambda req: httpx.Response(503, content=b"internal: 10.0.0.4 boom"))
    gen = OllamaGenerator(base_url="http://secret-host:11434", client=client)
    with pytest.raises(GenerationFailed) as caught:
        await collect(gen.astream_answer(REQUEST))

    message = str(caught.value)
    assert "10.0.0.4" not in message
    assert "secret-host" not in message
