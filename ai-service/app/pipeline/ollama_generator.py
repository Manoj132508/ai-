"""Ollama generation adapter -- the default free, local provider.

Ollama runs a model on the developer's own machine and exposes a local HTTP
API, so grounded generation works with no API key and no internet. It speaks
the same async interface as the Anthropic adapter, so the FastAPI -> Node ->
browser SSE pipeline is unchanged.

NATIVELY ASYNC, using httpx.AsyncClient. This is what makes a downstream
disconnect genuinely cancel the work: when the /query task is cancelled, the
``async with client.stream(...)`` block is exited and the upstream response is
closed promptly, stopping generation for an answer nobody will read. A
synchronous stream could not offer that -- a blocking read has to return first.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

import httpx
from app.core import logging as log
from app.pipeline.base import GenerationFailed, GenerationRequest, GenerationUnavailable
from app.pipeline.prompt import SYSTEM_PROMPT, build_history_messages, build_user_message

# The local streaming chat endpoint. Emits newline-delimited JSON, one object
# per token, with a final object carrying done: true and done_reason.
CHAT_PATH = "/api/chat"

_MALFORMED = "The answering service returned an unexpected response."


class OllamaGenerator:
    def __init__(
        self,
        *,
        base_url: str = "http://localhost:11434",
        model: str = "llama3.2:3b",
        max_tokens: int = 8192,
        client: httpx.AsyncClient | None = None,
        timeout: float = 120.0,
    ) -> None:
        # rstrip so a trailing slash in the configured URL does not produce
        # `//api/chat`.
        self._base_url = base_url.rstrip("/")
        self._model = model
        self._max_tokens = max_tokens
        # Injectable, exactly like the Anthropic client: an AsyncClient backed
        # by MockTransport makes every path here testable with no server.
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

    async def astream_answer(self, request: GenerationRequest) -> AsyncIterator[str]:
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
            else (httpx.AsyncClient(timeout=self._timeout), True)
        )

        # The streaming is INLINED here (not delegated to a helper generator)
        # deliberately: when this generator is closed on cancellation,
        # GeneratorExit is raised at the `yield` below, the `async with` exits,
        # and the upstream response is closed. Delegating with
        # `async for ... in self._helper(...)` would leave the helper -- and its
        # open `async with` -- un-closed, so the upstream would leak.
        try:
            async with client.stream(
                "POST", f"{self._base_url}{CHAT_PATH}", json=payload, headers=headers
            ) as response:
                if response.status_code != 200:
                    # Drain so the connection closes cleanly, but never surface
                    # the body -- it may be verbose and is not useful to a user.
                    await response.aread()
                    log.warn(
                        "ollama returned non-success status",
                        status=response.status_code,
                        model=self._model,
                    )
                    raise GenerationFailed(
                        "The answering service returned an error. Please try again shortly."
                    )

                saw_done = False
                async for line in response.aiter_lines():
                    if not line:
                        continue
                    parsed_token, done = self._parse_line(line)
                    if parsed_token:
                        yield parsed_token
                    if done:
                        # Stop at the terminal event. Anything Ollama sends
                        # after done: true is ignored rather than leaking into
                        # the answer.
                        saw_done = True
                        break

                if not saw_done:
                    # The stream ended -- cleanly or by a dropped connection --
                    # without the terminal event, so the answer is incomplete.
                    # Treat a premature end as a failure, not a success with
                    # partial text.
                    log.warn("ollama stream ended without a terminal done event")
                    raise GenerationFailed("The answer ended unexpectedly. Please try again.")

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
            raise GenerationFailed("The answering service timed out. Please try again.") from exc
        except httpx.HTTPError as exc:
            # Any other transport-level failure, including a mid-stream drop
            # (RemoteProtocolError / ReadError) -- a premature EOF.
            log.warn("ollama transport error", error_type=type(exc).__name__)
            raise GenerationFailed(
                "The answering service is temporarily unavailable. Please try again shortly."
            ) from exc
        finally:
            # Close only a client we created. An injected client belongs to the
            # caller. Runs on normal exhaustion AND on cancellation.
            if owns_client:
                await client.aclose()

    def _parse_line(self, line: str) -> tuple[str | None, bool]:
        """Parse one NDJSON line into (token, is_done).

        Every unexpected shape -- non-JSON, a non-object, a message that is not
        a dict, a content that is not a string, or an ``error`` field -- maps to
        GenerationFailed. Nothing is allowed to escape as a raw AttributeError
        or KeyError from an assumed schema.
        """
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as exc:
            log.warn("ollama returned malformed json")
            raise GenerationFailed(_MALFORMED) from exc

        if not isinstance(obj, dict):
            log.warn("ollama returned a non-object line")
            raise GenerationFailed(_MALFORMED)

        # Ollama reports model-side problems as {"error": "..."} once streaming.
        if obj.get("error"):
            log.warn("ollama reported an error mid-stream")
            raise GenerationFailed("The answering service could not complete the answer.")

        token: str | None = None
        message = obj.get("message")
        if message is not None:
            if not isinstance(message, dict):
                log.warn("ollama message field was not an object")
                raise GenerationFailed(_MALFORMED)
            content = message.get("content", "")
            if content is not None and not isinstance(content, str):
                log.warn("ollama content field was not a string")
                raise GenerationFailed(_MALFORMED)
            if content:
                token = content

        done = bool(obj.get("done"))
        if done and obj.get("done_reason") == "length":
            # The analogue of Anthropic's max_tokens stop: the answer was cut
            # off. Logged, not raised -- a truncated answer is still worth
            # showing.
            log.warn("ollama answer truncated at num_predict", max_tokens=self._max_tokens)

        return token, done
