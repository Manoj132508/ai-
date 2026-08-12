"""Anthropic generation adapter.

The client is INJECTABLE, which is the whole design. Constructing the SDK
client inside the streaming call would make every test of prompt assembly,
parameter selection and stream handling require a network round trip and a
funded API key. Passing it in means the entire contract is verifiable offline,
and the one test that does hit the real API is a separate, skippable case.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass

from app.core import logging as log
from app.pipeline.prompt import SYSTEM_PROMPT, build_history_messages, build_user_message
from app.pipeline.retriever import RetrievedChunk


class GenerationUnavailable(Exception):
    """No API key configured. Raised rather than degrading into a fake answer."""


class GenerationFailed(Exception):
    """The model call failed or was declined. Message is safe to show a user."""


@dataclass(frozen=True)
class GenerationRequest:
    question: str
    chunks: list[RetrievedChunk]
    history: list[dict]


class AnthropicGenerator:
    """Streams a grounded answer from Claude.

    Notes on the request shape, all of which are Claude Opus 5 specifics:

    * **Thinking is on by default.** Omitting the parameter runs adaptive
      thinking, and ``max_tokens`` caps thinking PLUS answer text together --
      so a budget sized only for the answer truncates mid-sentence.
    * **Effort** is the latency lever. Answering from supplied text is not a
      heavy reasoning task, so ``medium`` is a reasonable default; it is
      configurable because the right setting is an evaluation result, not a
      guess.
    * **Refusals arrive as HTTP 200** with ``stop_reason == "refusal"``, not as
      an exception. Code that reads the text without checking would return an
      empty answer and call it success.
    * **Server-side fallbacks** re-run a declined request on another model
      inside the same call, so a false-positive refusal on a legitimate
      document does not surface to the user.
    """

    BETA_FALLBACK = "server-side-fallback-2026-07-01"

    def __init__(
        self,
        *,
        client=None,
        model: str = "claude-opus-5",
        effort: str = "medium",
        max_tokens: int = 8192,
        enable_fallbacks: bool = True,
    ) -> None:
        self._client = client
        self._model = model
        self._effort = effort
        self._max_tokens = max_tokens
        self._enable_fallbacks = enable_fallbacks

    def _resolve_client(self):
        if self._client is not None:
            return self._client
        try:
            import anthropic
        except ImportError as exc:  # pragma: no cover - dependency guard
            raise GenerationUnavailable("The anthropic package is not installed.") from exc

        # Zero-argument constructor: the SDK reads ANTHROPIC_API_KEY from the
        # environment itself, so the key is never handled in our code.
        self._client = anthropic.Anthropic()
        return self._client

    def build_request_kwargs(self, request: GenerationRequest) -> dict:
        """The exact keyword arguments sent to the API.

        Split out so tests can assert on the request WITHOUT executing it --
        the prompt, the model, the effort and the beta flags are all checkable
        as data.
        """
        messages = build_history_messages(request.history)
        messages.append({"role": "user", "content": build_user_message(request.question, request.chunks)})

        kwargs: dict = {
            "model": self._model,
            "max_tokens": self._max_tokens,
            "system": SYSTEM_PROMPT,
            "messages": messages,
            "output_config": {"effort": self._effort},
        }

        if self._enable_fallbacks:
            kwargs["betas"] = [self.BETA_FALLBACK]
            kwargs["fallbacks"] = "default"

        return kwargs

    def stream_answer(self, request: GenerationRequest) -> Iterator[str]:
        """Yields answer text as it is generated.

        Streaming rather than a single response: a grounded answer can take
        several seconds, and a user watching a blank screen assumes it has
        hung. It also lets the Node layer forward tokens straight through to
        the browser.
        """
        client = self._resolve_client()
        kwargs = self.build_request_kwargs(request)

        # The beta endpoint is required for the fallbacks parameter.
        endpoint = client.beta.messages if self._enable_fallbacks else client.messages

        try:
            with endpoint.stream(**kwargs) as stream:
                yield from stream.text_stream

                final = stream.get_final_message()
        except GenerationFailed:
            raise
        except Exception as exc:
            # The raw exception may carry request internals, so it is logged
            # and a generic message is raised for display -- the same rule as
            # the Node error handler.
            # `detail=`, not `message=`: the logger takes the message
            # positionally, so a `message` keyword collides with it.
            log.error("llm request failed", error_type=type(exc).__name__, detail=str(exc))
            raise GenerationFailed(
                "The answering service is temporarily unavailable. Please try again shortly."
            ) from exc

        if getattr(final, "stop_reason", None) == "refusal":
            category = getattr(getattr(final, "stop_details", None), "category", None)
            log.warn("model declined the request", category=category)
            raise GenerationFailed(
                "The answering service declined to answer this question."
            )

        if getattr(final, "stop_reason", None) == "max_tokens":
            # The answer is cut off. Better to say so than to present a
            # sentence that stops mid-word as if it were complete.
            log.warn("answer truncated at max_tokens", max_tokens=self._max_tokens)
