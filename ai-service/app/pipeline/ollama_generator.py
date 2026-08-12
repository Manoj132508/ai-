"""Ollama generation adapter -- the default free, local provider.

Ollama runs a model on the developer's own machine and exposes a local HTTP
API, so grounded generation works with no API key and no internet. It speaks
the same interface as the Anthropic adapter (``stream_answer`` yielding text),
so the FastAPI -> Node -> browser SSE pipeline is unchanged.

Uses the project's existing ``httpx`` dependency, and stays SYNCHRONOUS to
match the Anthropic adapter and preserve the cancellation chain: when the
downstream request is aborted, the generator is closed, GeneratorExit unwinds
the ``with client.stream(...)`` block, and the upstream Ollama response is
closed -- stopping generation for an answer nobody will read.
"""

from __future__ import annotations

import json
from collections.abc import Iterator

import httpx
from app.core import logging as log
from app.pipeline.base import GenerationFailed, GenerationRequest, GenerationUnavailable
from app.pipeline.prompt import SYSTEM_PROMPT, build_history_messages, build_user_message

# The local streaming chat endpoint. Emits newline-delimited JSON, one object
# per token, with a final object carrying done: true and done_reason.
CHAT_PATH = "/api/chat"


class OllamaGenerator:
    def __init__(
        self,
        *,
        base_url: str = "http://localhost:11434",
        model: str = "llama3.2:3b",
        max_tokens: int = 8192,
        client: httpx.Client | None = None,
        timeout: float = 120.0,
    ) -> None:
        # rstrip so a trailing slash in the configured URL does not produce
        # `//api/chat`.
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._max_tokens = max_tokens
        # Injectable, exactly like the Anthropic client: a MockTransport-backed
        # client makes every path here testable with no server running.
        self._client = client
        self._timeout = timeout

    def build_payload(self, request: GenerationRequest) -> dict:
        """The request body sent to Ollama.

        Separated so tests can assert on model, messages and options as data,
        the same way the Anthropic adapter exposes build_request_kwargs.

        Message shape mirrors the Anthropic path: the system prompt carries the
        grounding rules, prior turns give follow-up context, and the final user
        message holds the numbered sources plus the question.
        """
        messages = [{"role": "system", "content": SYSTEM_PROMPT}]
        messages.extend(build_history_messages(request.history))
        messages.append(
            {"role": "user", "content": build_user_message(request.question, request.chunks)}
        )

        return {
            "model": self._model,
            "messages": messages,
            "stream": True,
            # num_predict is Ollama's max-output cap, the analogue of
            # max_tokens. Ollama does not run a separate "thinking" budget, so
            # unlike the Anthropic path this bounds the answer directly.
            "options": {"num_predict": self._max_tokens},
        }

    def stream_answer(self, request: GenerationRequest) -> Iterator[str]:
        payload = self.build_payload(request)

        headers = {}
        # Forwarded for tracing where the boundary supports it. Ollama ignores
        # unknown headers, and this keeps one request id traceable from Node
        # through Python to the model boundary.
        if request.request_id:
            headers["X-Request-Id"] = request.request_id

        client, owns_client = (
            (self._client, False)
            if self._client is not None
            else (httpx.Client(timeout=self._timeout), True)
        )

        try:
            yield from self._stream(client, payload, headers)
        finally:
            # Close only a client we created. An injected client belongs to the
            # caller. The finally runs on normal exhaustion AND on GeneratorExit
            # (cancellation), so an internally-created client never leaks.
            if owns_client:
                client.close()

    def _stream(self, client, payload, headers) -> Iterator[str]:
        try:
            with client.stream(
                "POST", f"{self._base_url}{CHAT_PATH}", json=payload, headers=headers
            ) as response:
                if response.status_code != 200:
                    # Drain the body so the connection can be reused/closed
                    # cleanly, but do NOT surface it -- it may be verbose and is
                    # not useful to a user.
                    response.read()
                    log.warn(
                        "ollama returned non-success status",
                        status=response.status_code,
                        model=self._model,
                    )
                    raise GenerationFailed(
                        "The answering service returned an error. Please try again shortly."
                    )

                for line in response.iter_lines():
                    if not line:
                        continue
                    yield from self._handle_line(line)

        except (GenerationFailed, GenerationUnavailable):
            raise
        except httpx.ConnectError as exc:
            # Server not running / wrong port. This is the common local case.
            log.warn("ollama unreachable", base_url=self._base_url)
            raise GenerationUnavailable(
                "The local model server (Ollama) is not reachable. "
                "Start it and pull the model, then try again."
            ) from exc
        except httpx.TimeoutException as exc:
            log.warn("ollama request timed out", model=self._model)
            raise GenerationFailed(
                "The answering service timed out. Please try again."
            ) from exc
        except httpx.HTTPError as exc:
            # Any other transport-level failure (read error, protocol error).
            log.warn("ollama transport error", error_type=type(exc).__name__)
            raise GenerationFailed(
                "The answering service is temporarily unavailable. Please try again shortly."
            ) from exc

    def _handle_line(self, line: str) -> Iterator[str]:
        """Parses one NDJSON line, yielding its text token if any.

        A malformed line, or an error object from Ollama, is mapped to
        GenerationFailed rather than crashing the stream with an unmapped
        exception.
        """
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as exc:
            log.warn("ollama returned malformed json")
            raise GenerationFailed(
                "The answering service returned an unexpected response."
            ) from exc

        # Ollama reports model-side problems as {"error": "..."} rather than an
        # HTTP status once the stream has started.
        if isinstance(obj, dict) and obj.get("error"):
            log.warn("ollama reported an error mid-stream")
            raise GenerationFailed(
                "The answering service could not complete the answer."
            )

        chunk = (obj.get("message") or {}).get("content", "") if isinstance(obj, dict) else ""
        if chunk:
            yield chunk

        if isinstance(obj, dict) and obj.get("done"):
            reason = obj.get("done_reason")
            if reason == "length":
                # The analogue of Anthropic's max_tokens stop: the answer was
                # cut off. Logged, not raised -- a truncated answer is still
                # worth showing.
                log.warn("ollama answer truncated at num_predict", max_tokens=self._max_tokens)
