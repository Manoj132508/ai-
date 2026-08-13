"""Endpoint-level boundary tests for /query. Fully offline.

These drive the StreamingResponse's async body directly, so they can prove two
things a buffered TestClient cannot: that a client disconnect (the body being
closed) closes the upstream provider connection, and that tokens flush
incrementally rather than as one final blob.
"""

import asyncio
import json

import httpx
from app import main
from app.main import QueryRequest, query
from app.pipeline.ollama_generator import OllamaGenerator
from app.pipeline.retriever import RetrievalResult, RetrievedChunk

CHUNK = RetrievedChunk(
    chunk_id="d:0", document_id="d", document_name="f.pdf", page=1, text="body", score=0.8
)
GROUNDED = RetrievalResult(chunks=[CHUNK], top_score=0.8, grounded=True)


def ndjson(*objects):
    return ("\n".join(json.dumps(o) for o in objects) + "\n").encode()


def tok(text, done=False, done_reason=None):
    obj = {"message": {"content": text}, "done": done}
    if done_reason:
        obj["done_reason"] = done_reason
    return obj


class _AsyncSpyStream(httpx.AsyncByteStream):
    def __init__(self, chunks):
        self._chunks = chunks
        self.closed = False

    async def __aiter__(self):
        for chunk in self._chunks:
            await asyncio.sleep(0.05)
            yield chunk

    async def aclose(self):
        self.closed = True


async def _make_response(monkeypatch, generator):
    # Retrieval is patched to a fixed grounded result so the test isolates the
    # streaming/generation boundary. It runs via run_in_threadpool, so a plain
    # callable is fine.
    monkeypatch.setattr(main, "retrieve", lambda **kwargs: GROUNDED)
    monkeypatch.setattr(main, "generator", generator)
    monkeypatch.setattr(main, "generation_configured", lambda s: True)
    return await query(QueryRequest(question="q", knowledge_base_id="kb"))


async def test_client_disconnect_closes_the_upstream(monkeypatch):
    """Closing the response body (what Starlette does on client disconnect)
    must close the upstream Ollama connection -- proven end to end at the
    endpoint, not just at the adapter."""
    spy = _AsyncSpyStream([
        ndjson(tok("first ")),
        ndjson(tok("second ")),
        ndjson(tok("", done=True, done_reason="stop")),
    ])
    transport = httpx.MockTransport(lambda r: httpx.Response(200, stream=spy))
    client = httpx.AsyncClient(transport=transport)
    response = await _make_response(monkeypatch, OllamaGenerator(client=client))

    body = response.body_iterator
    meta = await body.__anext__()
    assert '"type": "meta"' in meta
    first = await body.__anext__()
    assert "first " in first
    assert spy.closed is False

    await body.aclose()  # the disconnect
    assert spy.closed is True, "upstream must be closed when the client disconnects"


async def test_tokens_flush_incrementally_not_as_a_blob(monkeypatch):
    """The token frames must arrive spread out over time, not all at once at
    the end -- the regression the sync-in-async body caused."""

    class SlowGenerator:
        async def astream_answer(self, request):
            for text in ["one ", "two ", "three"]:
                await asyncio.sleep(0.1)
                yield text

    response = await _make_response(monkeypatch, SlowGenerator())
    body = response.body_iterator

    loop = asyncio.get_event_loop()
    start = loop.time()
    frames, times = [], []
    for _ in range(6):
        try:
            frame = await asyncio.wait_for(body.__anext__(), timeout=2)
        except (TimeoutError, StopAsyncIteration):
            break
        frames.append(frame)
        times.append(loop.time() - start)
    await body.aclose()

    token_times = [t for f, t in zip(frames, times, strict=True) if '"type": "token"' in f]
    assert len(token_times) == 3, "all three tokens should stream"
    # If the body buffered, the three tokens would land at nearly the same
    # instant. Spread across ~0.3s proves they flushed incrementally.
    assert token_times[-1] - token_times[0] >= 0.15
