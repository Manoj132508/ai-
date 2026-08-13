"""Provider selection, validation and health. Fully offline."""

from types import SimpleNamespace

import httpx
import pytest
from app.core.config import Settings
from app.pipeline.generator import AnthropicGenerator
from app.pipeline.ollama_generator import OllamaGenerator
from app.pipeline.provider_factory import (
    UnknownProviderError,
    build_generator,
    generation_configured,
    provider_health,
)


def make_settings(**overrides) -> Settings:
    """A Settings built from explicit values, not the ambient .env, so tests
    are hermetic regardless of the developer's local configuration."""
    base = dict(
        llm_provider="ollama",
        ollama_base_url="http://localhost:11434",
        ollama_model="llama3.2:3b",
        anthropic_api_key=None,
        anthropic_model="claude-opus-5",
        llm_effort="medium",
        llm_max_tokens=8192,
    )
    base.update(overrides)
    return Settings(**base)


# --- selection ---------------------------------------------------------------


def test_default_provider_is_ollama():
    assert make_settings().llm_provider == "ollama"


def test_builds_ollama_adapter():
    gen = build_generator(make_settings(llm_provider="ollama"))
    assert isinstance(gen, OllamaGenerator)


def test_builds_anthropic_adapter():
    gen = build_generator(make_settings(llm_provider="anthropic", anthropic_api_key="sk-ant-x"))
    assert isinstance(gen, AnthropicGenerator)


def test_anthropic_adapter_is_wired_with_the_key():
    """The key from settings (a SecretStr from .env) must be passed to the
    adapter -- the bug was that it was loaded but never handed to the SDK."""
    gen = build_generator(
        make_settings(llm_provider="anthropic", anthropic_api_key="sk-ant-REAL")
    )
    assert gen._api_key == "sk-ant-REAL"


def test_provider_is_case_and_whitespace_insensitive():
    # The config validator normalises, but the factory is defensive too.
    assert make_settings(llm_provider="  Ollama ").llm_provider == "ollama"


# --- unknown provider rejection ----------------------------------------------


def test_unknown_provider_rejected_at_config():
    """A typo in LLM_PROVIDER fails at Settings construction (startup), not at
    the first query."""
    with pytest.raises(ValueError, match="Unknown LLM_PROVIDER"):
        make_settings(llm_provider="gpt4all")


def test_unknown_provider_rejected_by_factory():
    """Belt and suspenders: even a settings-like object that bypassed the
    validator is rejected by the factory rather than silently defaulting."""
    fake = SimpleNamespace(llm_provider="banana")
    with pytest.raises(UnknownProviderError, match="Unknown LLM_PROVIDER"):
        build_generator(fake)


def test_no_silent_fallback_anthropic_without_key_still_builds_anthropic():
    """Choosing anthropic without a key must NOT quietly hand back ollama."""
    gen = build_generator(make_settings(llm_provider="anthropic", anthropic_api_key=None))
    assert isinstance(gen, AnthropicGenerator)


# --- generation_configured (config-level, no network) ------------------------


def test_ollama_is_always_configured():
    # Reachability is a runtime question handled by the adapter; at config
    # level ollama needs nothing.
    assert generation_configured(make_settings(llm_provider="ollama")) is True


def test_anthropic_requires_a_key():
    no_key = make_settings(llm_provider="anthropic", anthropic_api_key=None)
    with_key = make_settings(llm_provider="anthropic", anthropic_api_key="sk-ant")
    assert generation_configured(no_key) is False
    assert generation_configured(with_key) is True


# --- health ------------------------------------------------------------------


def _tags(*model_names):
    return httpx.Response(200, json={"models": [{"name": n} for n in model_names]})


def test_health_ollama_available_when_server_up_and_model_present(monkeypatch):
    monkeypatch.setattr(httpx, "get", lambda *a, **k: _tags("llama3.2:3b", "other:model"))
    health = provider_health(make_settings(llm_provider="ollama", ollama_model="llama3.2:3b"))
    assert health == {"provider": "ollama", "generation_available": True}


def test_health_ollama_unavailable_when_model_absent(monkeypatch):
    """The reported bug: server reachable but the configured model not pulled
    must report unavailable, not available."""
    monkeypatch.setattr(httpx, "get", lambda *a, **k: _tags("some-other-model:latest"))
    health = provider_health(make_settings(llm_provider="ollama", ollama_model="llama3.2:3b"))
    assert health["generation_available"] is False


def test_health_ollama_model_without_tag_matches_latest(monkeypatch):
    monkeypatch.setattr(httpx, "get", lambda *a, **k: _tags("mistral:latest"))
    health = provider_health(make_settings(llm_provider="ollama", ollama_model="mistral"))
    assert health["generation_available"] is True


def test_health_reports_ollama_unreachable(monkeypatch):
    def refuse(*a, **k):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(httpx, "get", refuse)
    health = provider_health(make_settings(llm_provider="ollama"))
    assert health == {"provider": "ollama", "generation_available": False}


def test_health_reports_anthropic_key_presence():
    with_key = provider_health(
        make_settings(llm_provider="anthropic", anthropic_api_key="sk-ant-secret")
    )
    without = provider_health(make_settings(llm_provider="anthropic", anthropic_api_key=None))
    assert with_key["generation_available"] is True
    assert without["generation_available"] is False


def test_health_never_exposes_the_key():
    """generation_available is a boolean; the key itself is never in the output."""
    health = provider_health(
        make_settings(llm_provider="anthropic", anthropic_api_key="sk-ant-VERYSECRET")
    )
    assert "sk-ant-VERYSECRET" not in repr(health)
    assert set(health.keys()) == {"provider", "generation_available"}
    assert isinstance(health["generation_available"], bool)
