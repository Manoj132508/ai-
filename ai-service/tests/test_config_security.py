"""Boundary tests for key wiring and secret hygiene. Fully offline.

Covers the two failures that a passing test suite had previously hidden: the
Anthropic key was loaded from .env but never reached the SDK, and a secret
could surface in a validation error or a provider-error log.
"""

import sys
import types

import pytest
from app.core.config import Settings
from app.pipeline.generator import AnthropicGenerator, GenerationFailed, GenerationRequest
from app.pipeline.provider_factory import build_generator
from app.pipeline.retriever import RetrievedChunk

CHUNKS = [
    RetrievedChunk(
        chunk_id="d:0", document_id="d", document_name="f.pdf", page=1, text="body", score=0.8
    )
]
REQUEST = GenerationRequest(question="q", chunks=CHUNKS, history=[])


# --- .env Anthropic wiring ---------------------------------------------------


def test_anthropic_key_loads_from_env_file_and_reaches_the_sdk(tmp_path, monkeypatch):
    """The whole chain: a key in a .env file -> Settings (SecretStr) -> the
    adapter -> anthropic.Anthropic(api_key=...). The bug was the last hop: a
    zero-arg client read the process environment, which never had the key."""
    env_file = tmp_path / ".env"
    env_file.write_text("LLM_PROVIDER=anthropic\nANTHROPIC_API_KEY=sk-ant-FROMFILE\n")

    # Make sure a stray process env var cannot mask the file.
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("LLM_PROVIDER", raising=False)

    settings = Settings(_env_file=str(env_file))
    assert settings.anthropic_key_value == "sk-ant-FROMFILE"

    generator = build_generator(settings)
    assert generator._api_key == "sk-ant-FROMFILE"

    # Confirm the key is actually handed to the SDK constructor.
    captured = {}
    fake_anthropic = types.ModuleType("anthropic")
    fake_anthropic.Anthropic = lambda **kwargs: captured.update(kwargs) or object()
    monkeypatch.setitem(sys.modules, "anthropic", fake_anthropic)

    generator._resolve_client()
    assert captured.get("api_key") == "sk-ant-FROMFILE"


def test_anthropic_without_a_key_refuses_to_build_a_client():
    """No key -> GenerationUnavailable, not a client that silently authenticates
    with nothing."""
    generator = AnthropicGenerator(api_key=None)
    with pytest.raises(Exception) as caught:
        generator._resolve_client()
    assert "key" in str(caught.value).lower()


# --- secret hygiene ----------------------------------------------------------


def test_validation_error_does_not_leak_the_key():
    """An invalid provider WITH a key present must not echo the key in the
    error -- SecretStr plus hide_input_in_errors."""
    with pytest.raises(Exception) as caught:
        Settings(llm_provider="not-a-provider", anthropic_api_key="sk-ant-SECRETVALUE")
    assert "sk-ant-SECRETVALUE" not in str(caught.value)


def test_secret_str_masks_the_key_in_repr():
    settings = Settings(anthropic_api_key="sk-ant-SECRETVALUE")
    assert "sk-ant-SECRETVALUE" not in repr(settings)
    assert "sk-ant-SECRETVALUE" not in str(settings.anthropic_api_key)
    # But the real value is still retrievable where needed.
    assert settings.anthropic_key_value == "sk-ant-SECRETVALUE"


def test_provider_error_log_carries_no_key(capsys):
    """When the SDK raises an error that embeds the key, only the exception
    TYPE is logged -- never str(exc)."""

    class BoomStream:
        def __enter__(self):
            raise RuntimeError("401 auth failed for api key sk-ant-LEAKED")

        def __exit__(self, *exc):
            return False

    class BoomMessages:
        def stream(self, **kwargs):
            return BoomStream()

    class BoomClient:
        def __init__(self):
            self.beta = types.SimpleNamespace(messages=BoomMessages())
            self.messages = BoomMessages()

    generator = AnthropicGenerator(client=BoomClient())
    with pytest.raises(GenerationFailed) as caught:
        list(generator.stream_answer(REQUEST))

    # The user-facing message is safe...
    assert "sk-ant-LEAKED" not in str(caught.value)
    # ...and nothing written to stdout/stderr (the structured logs) contains it.
    captured = capsys.readouterr()
    assert "sk-ant-LEAKED" not in captured.out
    assert "sk-ant-LEAKED" not in captured.err
