"""Anthropic generation adapter.

The client is INJECTABLE, which is the whole design. Constructing the SDK
client inside the streaming call would make every test of prompt assembly,
parameter selection and stream handling require a network round trip and a
funded API key. Passing it in means the entire contract is verifiable offline,
and the one test that does hit the real API is a separate, skippable case.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Iterator

from app.core import logging as log

# Shared types now live in base so both adapters depend on the interface, not
# on each other. Re-exported here so existing imports
# (`from app.pipeline.generator import GenerationRequest, ...`) keep working.
from app.pipeline.base import (  # noqa: F401
    GenerationFailed,
    GenerationRequest,
    GenerationUnavailable,
    TextGenerator,
    sync_to_async_stream,
)
from app.pipeline.prompt import SYSTEM_PROMPT, build_history_messages, build_user_message


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
        api_key: str | None = None,
        model: str = "claude-opus-5",
        effort: str = "medium",
        max_tokens: int = 8192,
        enable_fallbacks: bool = True,
    ) -> None:
        self._client = client
        self._api_key = api_key
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

        # The key is passed EXPLICITLY. It comes from the settings layer, which
        # loads it from the repo-root .env into a SecretStr -- it is NOT in the
        # process environment, so a zero-argument anthropic.Anthropic() would
        # find no key and every request would fail auth. This is the wiring the
        # zero-arg form silently missed.
        if not self._api_key:
            raise GenerationUnavailable("No Anthropic API key is configured.")
        self._client = anthropic.Anthropic(api_key=self._api_key)
        return self._client

    def build_request_kwargs(self, request: GenerationRequest) -> dict:
        """The exact keyword arguments sent to the API.

        Split out so tests can assert on the request WITHOUT executing it --
        the prompt, the model, the effort and the beta flags are all checkable
        as data.
        """
        messages = build_history_messages(request.history)
        messages.append(
            {"role": "user", "content": build_user_message(request.question, request.chunks)}
        )

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

    def astream_answer(self, request: GenerationRequest) -> AsyncIterator[str]:
        """Async entry point used by the orchestration layer.

        The Anthropic SDK stream is synchronous, so it runs in a threadpool via
        sync_to_async_stream -- the event loop stays free to flush each token,
        and all of the stop_reason / refusal / fallback logic below is reused
        unchanged. Cancellation is best-effort for this path (see the helper);
        the Ollama default cancels promptly.
        """
        return sync_to_async_stream(self.stream_answer(request))

    def stream_answer(self, request: GenerationRequest) -> Iterator[str]:
        """Yields answer text as it is generated (synchronous SDK stream).

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
            # Only the exception TYPE is logged, never str(exc). A provider
            # error can embed request internals -- an auth failure in
            # particular may echo the key -- so the raw text must not reach the
            # logs. The user gets a generic message, the same rule as the Node
            # error handler.
            log.error("llm request failed", error_type=type(exc).__name__)
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
