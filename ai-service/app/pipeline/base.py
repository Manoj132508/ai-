"""Provider-neutral generation interface and shared types.

The orchestration layer (main.py) and the RAG pipeline depend only on the
symbols here -- never on a specific provider's SDK. That is what lets the same
FastAPI -> Node -> browser SSE path serve Anthropic or Ollama unchanged, and
what lets a test inject a fake generator.

Both exception types map to the same client-facing code (LLM_UNAVAILABLE) in
main.py; the distinction is for logging and intent, not for the wire.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from app.pipeline.retriever import RetrievedChunk


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
    """The one method the pipeline calls.

    Synchronous on purpose: it matches the existing Anthropic adapter and the
    ``for text in generator.stream_answer(...)`` loop in main.py, so
    cancellation still propagates as GeneratorExit into the provider's open
    stream. An async variant would change that contract for no gain here.
    """

    def stream_answer(self, request: GenerationRequest) -> Iterator[str]: ...
