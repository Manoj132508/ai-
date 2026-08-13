"""Provider-neutral generation interface and shared types.

The orchestration layer (main.py) and the RAG pipeline depend only on the
symbols here -- never on a specific provider's SDK. That is what lets the same
FastAPI -> Node -> browser SSE path serve Anthropic or Ollama unchanged, and
what lets a test inject a fake generator.

Both exception types map to the same client-facing code (LLM_UNAVAILABLE) in
main.py; the distinction is for logging and intent, not for the wire.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from app.pipeline.retriever import RetrievedChunk
from starlette.concurrency import iterate_in_threadpool


class GenerationUnavailable(Exception):
    """The selected provider is not usable at all right now.

    No Anthropic key configured, or the local Ollama server is unreachable.
    Raised rather than degrading into a fabricated answer, and deliberately NOT
    a silent fallback to the other provider.
    """


class GenerationFailed(Exception):
    """The provider was reached but the call failed or was declined.

    Bad HTTP status, a timeout mid-stream, malformed output, or an Anthropic
    ``stop_reason == "refusal"``. The message is written to be safe to show a
    user -- it never carries request internals or secrets.
    """


@dataclass(frozen=True)
class GenerationRequest:
    """Everything a provider needs to produce a grounded answer.

    ``request_id`` is optional and defaults to None so existing positional
    construction -- ``GenerationRequest(question, chunks, history)`` -- keeps
    working. Providers that can forward it for tracing do; the Anthropic
    adapter ignores it, which is why its behaviour is unchanged.
    """

    question: str
    chunks: list[RetrievedChunk]
    history: list[dict] = field(default_factory=list)
    request_id: str | None = None


@runtime_checkable
class TextGenerator(Protocol):
    """The one method the orchestration layer calls.

    ASYNC on purpose. The FastAPI /query body streams tokens through an async
    generator, and only a genuinely async producer lets a client disconnect
    cancel the task and close the upstream connection promptly. A synchronous
    producer iterated inside the async body would block the event loop (so
    nothing flushes until the end) and could not be cancelled reliably (the
    blocking read has to return first). The Ollama adapter is natively async;
    the Anthropic adapter -- whose SDK stream is synchronous -- adapts its sync
    stream with ``sync_to_async_stream``.
    """

    def astream_answer(self, request: GenerationRequest) -> AsyncIterator[str]: ...


async def sync_to_async_stream(sync_iterable: Iterator[str]) -> AsyncIterator[str]:
    """Run a synchronous token generator off the event loop, yielding as it
    produces, and close it when the consumer stops.

    Used by the Anthropic adapter, whose SDK exposes a synchronous stream.
    Starlette's ``iterate_in_threadpool`` runs each ``next()`` in a worker
    thread so the loop stays free to flush. On cancellation the underlying
    generator is closed so its ``with`` block (and the SDK connection) is
    released; this is best-effort for the sync path, because a ``next()``
    already in flight must return before the close takes effect. The Ollama
    default has no such caveat -- it is natively async.
    """
    if not isinstance(sync_iterable, Iterator):
        sync_iterable = iter(sync_iterable)
    try:
        async for item in iterate_in_threadpool(sync_iterable):
            yield item
    finally:
        close = getattr(sync_iterable, "close", None)
        if close is not None:
            try:
                close()
            except Exception:  # noqa: BLE001 - generator may be mid-next in its thread
                pass
