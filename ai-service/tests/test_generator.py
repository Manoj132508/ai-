"""Generation adapter and prompt assembly.

NO LIVE API CALL. Every test here injects a fake client, so the full request
shape -- model, effort, beta flags, system prompt, message ordering -- is
verified as data. The single test that hits the real API is marked `live_api`
and skips cleanly without a key.
"""

import os

import pytest

from app.pipeline.generator import (
    AnthropicGenerator,
    GenerationFailed,
    GenerationRequest,
)
from app.pipeline.prompt import (
    REFUSAL_TEXT,
    SYSTEM_PROMPT,
    build_history_messages,
    build_sources_block,
    build_user_message,
)
from app.pipeline.retriever import RetrievedChunk

CHUNKS = [
    RetrievedChunk(
        chunk_id="doc1:4", document_id="doc1", document_name="handbook.pdf", page=12,
        text="Termination by the employee requires 30 days written notification.", score=0.78,
    ),
    RetrievedChunk(
        chunk_id="doc1:5", document_id="doc1", document_name="handbook.pdf", page=14,
        text="During probation, either party may terminate with 7 days notice.", score=0.71,
    ),
]


# --- fake client -------------------------------------------------------------


class _FakeStream:
    def __init__(self, texts, final):
        self._texts = texts
        self._final = final

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    @property
    def text_stream(self):
        yield from self._texts

    def get_final_message(self):
        return self._final


class _FinalMessage:
    def __init__(self, stop_reason="end_turn", category=None):
        self.stop_reason = stop_reason
        self.stop_details = type("Details", (), {"category": category})() if category else None


class _FakeMessages:
    def __init__(self, texts, final, raises=None):
        self.texts = texts
        self.final = final
        self.raises = raises
        self.captured = None

    def stream(self, **kwargs):
        self.captured = kwargs
        if self.raises:
            raise self.raises
        return _FakeStream(self.texts, self.final)


class FakeClient:
    def __init__(self, texts=("You must give ", "30 days notice. [1]"), final=None, raises=None):
        self.messages = _FakeMessages(list(texts), final or _FinalMessage(), raises)
        self.beta = type("Beta", (), {"messages": self.messages})()


# --- prompt assembly ----------------------------------------------------------


def test_sources_are_numbered_from_one():
    """The model writes [2]; that must map to chunks[1] with no lookup table."""
    block = build_sources_block(CHUNKS)
    assert block.startswith("[1] (handbook.pdf, page 12)")
    assert "[2] (handbook.pdf, page 14)" in block


def test_sources_come_before_the_question():
    """Long stable content first: it caches, and instructions after a long
    context are followed more reliably than ones buried above it."""
    message = build_user_message("How much notice?", CHUNKS)
    assert message.index("Sources:") < message.index("Question:")
    assert message.rstrip().endswith("Question: How much notice?")


def test_system_prompt_states_the_refusal_verbatim():
    """The exact string the retriever also emits, so the two paths cannot drift."""
    assert REFUSAL_TEXT in SYSTEM_PROMPT
    assert "ONLY" in SYSTEM_PROMPT
    assert "[1]" in SYSTEM_PROMPT


def test_history_is_trimmed_and_starts_on_a_user_turn():
    history = [{"role": "user", "content": f"q{i}"} for i in range(10)]
    history += [{"role": "assistant", "content": "a"}]

    trimmed = build_history_messages(history, limit=2)
    assert len(trimmed) <= 4
    # The API rejects a message list that opens on an assistant turn, which a
    # naive window can easily produce.
    assert trimmed[0]["role"] == "user"


def test_history_drops_malformed_turns():
    history = [
        {"role": "user", "content": "kept"},
        {"role": "system", "content": "not a conversational role"},
        {"role": "assistant", "content": ""},
    ]
    assert build_history_messages(history) == [{"role": "user", "content": "kept"}]


# --- request shape (no network) -----------------------------------------------


def test_request_carries_model_effort_and_fallbacks():
    generator = AnthropicGenerator(client=FakeClient(), model="claude-opus-5", effort="medium")
    kwargs = generator.build_request_kwargs(
        GenerationRequest(question="How much notice?", chunks=CHUNKS, history=[])
    )

    assert kwargs["model"] == "claude-opus-5"
    assert kwargs["output_config"] == {"effort": "medium"}
    assert kwargs["system"] == SYSTEM_PROMPT

    # Server-side fallbacks: a false-positive safety refusal on a legitimate
    # document is re-run on another model inside the same call instead of
    # surfacing to the user.
    assert kwargs["fallbacks"] == "default"
    assert AnthropicGenerator.BETA_FALLBACK in kwargs["betas"]


def test_thinking_is_left_at_the_model_default():
    """Opus 5 thinks by default; max_tokens caps thinking PLUS answer text.

    Asserted so nobody adds `thinking: disabled` without noticing it is a
    behaviour change, and so the max_tokens budget is visibly generous enough
    to cover both.
    """
    generator = AnthropicGenerator(client=FakeClient(), max_tokens=8192)
    kwargs = generator.build_request_kwargs(GenerationRequest("q", CHUNKS, []))

    assert "thinking" not in kwargs, "omitted means adaptive on Opus 5"
    assert kwargs["max_tokens"] >= 4096, "must cover thinking as well as the answer"


def test_last_message_is_the_question_with_sources():
    generator = AnthropicGenerator(client=FakeClient())
    kwargs = generator.build_request_kwargs(
        GenerationRequest(
            "How much notice?", CHUNKS,
            [{"role": "user", "content": "earlier"}, {"role": "assistant", "content": "reply"}],
        )
    )

    assert [m["role"] for m in kwargs["messages"]] == ["user", "assistant", "user"]
    assert "Sources:" in kwargs["messages"][-1]["content"]
    assert "handbook.pdf" in kwargs["messages"][-1]["content"]


# --- streaming behaviour --------------------------------------------------------


def test_streams_text_deltas_in_order():
    client = FakeClient(texts=["You must give ", "30 days ", "notice. [1]"])
    generator = AnthropicGenerator(client=client)

    output = list(generator.stream_answer(GenerationRequest("q", CHUNKS, [])))

    assert output == ["You must give ", "30 days ", "notice. [1]"]
    assert client.messages.captured is not None, "the fake client was actually used"


def test_uses_the_beta_endpoint_when_fallbacks_are_enabled():
    client = FakeClient()
    list(AnthropicGenerator(client=client).stream_answer(GenerationRequest("q", CHUNKS, [])))
    # Same fake backs both, but the captured kwargs prove the beta flags went out.
    assert "betas" in client.messages.captured


def test_a_refusal_raises_rather_than_returning_empty():
    """stop_reason == "refusal" arrives as HTTP 200, not an exception.

    Code that reads the text without checking would hand back an empty answer
    and report success.
    """
    client = FakeClient(texts=[], final=_FinalMessage(stop_reason="refusal", category="cyber"))
    generator = AnthropicGenerator(client=client)

    with pytest.raises(GenerationFailed, match="declined"):
        list(generator.stream_answer(GenerationRequest("q", CHUNKS, [])))


def test_api_errors_become_a_safe_message():
    """The raw exception may carry request internals; it is logged, not shown."""
    client = FakeClient(raises=RuntimeError("connection to 10.0.1.14 refused; key sk-ant-xyz"))
    generator = AnthropicGenerator(client=client)

    with pytest.raises(GenerationFailed) as caught:
        list(generator.stream_answer(GenerationRequest("q", CHUNKS, [])))

    assert "10.0.1.14" not in str(caught.value)
    assert "sk-ant" not in str(caught.value)
    assert "temporarily unavailable" in str(caught.value)


def test_fallbacks_can_be_disabled():
    generator = AnthropicGenerator(client=FakeClient(), enable_fallbacks=False)
    kwargs = generator.build_request_kwargs(GenerationRequest("q", CHUNKS, []))
    assert "fallbacks" not in kwargs
    assert "betas" not in kwargs


# --- the one live test ------------------------------------------------------------


@pytest.mark.live_api
@pytest.mark.skipif(
    not os.environ.get("ANTHROPIC_API_KEY"),
    reason="no ANTHROPIC_API_KEY; live generation test skipped",
)
def test_live_generation_answers_from_the_sources():
    """Hits the real API. Skipped automatically when no key is configured.

    Deliberately narrow: it asserts the answer is grounded in the supplied
    source rather than checking wording, because model output is not a stable
    string to assert on.
    """
    generator = AnthropicGenerator(model="claude-opus-5", effort="low", max_tokens=2048)
    answer = "".join(
        generator.stream_answer(
            GenerationRequest("How much notice must an employee give?", CHUNKS, [])
        )
    )

    assert answer.strip()
    assert "30" in answer, "the figure comes from source [1]"
    assert "[1]" in answer, "the system prompt requires a citation"
