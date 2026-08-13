"""Selects and builds the generation provider.

This is the ONLY place that knows which providers exist. main.py asks the
factory for a generator and never names a provider or touches a provider SDK,
so ``stream_answer`` stays provider-agnostic and a new provider is added here
alone.
"""

from __future__ import annotations

import httpx
from app.core import logging as log
from app.pipeline.base import TextGenerator
from app.pipeline.generator import AnthropicGenerator
from app.pipeline.ollama_generator import OllamaGenerator

OLLAMA = "ollama"
ANTHROPIC = "anthropic"
SUPPORTED_PROVIDERS = (OLLAMA, ANTHROPIC)


class UnknownProviderError(ValueError):
    """Configured LLM_PROVIDER is not one we support. Fails at startup, loudly."""


def build_generator(settings) -> TextGenerator:
    """Construct the adapter for the configured provider.

    Raises UnknownProviderError for anything unsupported -- there is NO silent
    fallback between providers, in either direction. Choosing a provider that
    cannot run (e.g. anthropic without a key, or ollama not started) surfaces
    at generation time as LLM_UNAVAILABLE, not as a swap to the other one.
    """
    provider = (settings.llm_provider or "").strip().lower()

    if provider == OLLAMA:
        return OllamaGenerator(
            base_url=settings.ollama_base_url,
            model=settings.ollama_model,
            max_tokens=settings.llm_max_tokens,
        )

    if provider == ANTHROPIC:
        return AnthropicGenerator(
            # The key is passed EXPLICITLY from settings (loaded from .env into
            # a SecretStr). The SDK cannot read it from the environment, so
            # without this the Anthropic provider would authenticate with no
            # key and fail every request.
            api_key=settings.anthropic_key_value,
            model=settings.anthropic_model,
            effort=settings.llm_effort,
            max_tokens=settings.llm_max_tokens,
        )

    raise UnknownProviderError(
        f"Unknown LLM_PROVIDER {provider!r}. Supported: {', '.join(SUPPORTED_PROVIDERS)}."
    )


def generation_configured(settings) -> bool:
    """Config-level check, no network I/O -- used to gate the query path.

    Anthropic needs a key to have any chance of working, so a missing key is a
    definite 'not configured' we can report before calling anything. Ollama is
    a local server whose availability is a RUNTIME question, so it is always
    'configured' here; an unreachable server is caught at call time and mapped
    to LLM_UNAVAILABLE by the adapter.
    """
    provider = (settings.llm_provider or "").strip().lower()
    if provider == ANTHROPIC:
        return bool(settings.anthropic_key_value)
    if provider == OLLAMA:
        return True
    return False


def _normalise_model(name: str) -> str:
    """A bare model reference (no tag) resolves to ':latest' in Ollama."""
    return name if ":" in name else f"{name}:latest"


def _ollama_model_available(settings) -> bool:
    """True only when the local server responds AND the configured model is
    actually pulled.

    Reachability alone is not enough: a running server with the model missing
    would report 'available' and then fail every generation with a model-not-
    found error. /api/tags lists the pulled models; the configured one must be
    among them.
    """
    url = f"{settings.ollama_base_url.rstrip('/')}/api/tags"
    try:
        response = httpx.get(url, timeout=1.5)
        if response.status_code != 200:
            return False
        names = {m.get("name", "") for m in response.json().get("models", [])}
    except (httpx.HTTPError, ValueError):
        return False

    wanted = _normalise_model(settings.ollama_model)
    return any(_normalise_model(n) == wanted for n in names)


def provider_health(settings) -> dict:
    """Health facts for /health. Never includes a key or any secret value.

    generation_available means 'a real answer could be produced right now':
    for ollama, that the local server responds AND the configured model is
    pulled; for anthropic, that a key is present. It is a boolean only -- the
    actual key is never read out.
    """
    provider = (settings.llm_provider or "").strip().lower()

    if provider == ANTHROPIC:
        available = bool(settings.anthropic_key_value)
    elif provider == OLLAMA:
        available = _ollama_model_available(settings)
    else:
        available = False
        log.warn("health probed with unknown provider", provider=provider)

    return {"provider": provider, "generation_available": available}
