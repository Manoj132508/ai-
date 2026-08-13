"""Configuration, read once and validated at import."""

from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# ai-service/app/core/config.py -> parents[3] is the repository root, where
# .env and (by default) chroma_data live. Anchoring to the module location
# rather than the process CWD is deliberate: under the preview launcher the
# service runs with its working directory set elsewhere, so a bare ".env"
# loads nothing and a real ANTHROPIC_API_KEY becomes invisible, while
# chroma_data is scattered into whatever directory happened to launch it.
_REPO_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        # Absolute, so the key is found no matter where the service is launched.
        env_file=str(_REPO_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        # A validation error must never echo the offending input back -- a bad
        # value for a secret field would otherwise land the key in the
        # traceback and the logs. Combined with SecretStr below, the key cannot
        # leak through a config error.
        hide_input_in_errors=True,
    )

    # --- security -------------------------------------------------------
    # Must match server/.env. This service performs NO authorisation of its
    # own -- it receives an opaque kb_id and trusts that Node authorised the
    # caller (ADR 001). That is only safe because it binds to loopback.
    internal_api_key: str = "dev-internal-key-change-me"
    host: str = "127.0.0.1"
    port: int = 8000

    node_api_url: str = "http://127.0.0.1:4200"

    # --- generation provider --------------------------------------------
    # Ollama by default: a free, local model that needs no API key, so the
    # complete RAG pipeline works offline. 'anthropic' switches to the paid
    # hosted model. Validated below -- an unknown value fails at startup.
    llm_provider: str = "ollama"

    # Shared across providers.
    llm_max_tokens: int = 8192

    # --- ollama (local, default) ----------------------------------------
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.2:3b"

    # --- anthropic (hosted, optional, paid) -----------------------------
    # Optional on purpose. With the ollama default the service must start,
    # index documents and answer questions with no key present. The key is
    # only required when LLM_PROVIDER=anthropic.
    #
    # SecretStr keeps the value out of reprs, logs and tracebacks -- printing
    # the settings object or a validation error shows '**********', never the
    # key. Read the real value only where it is used, via .get_secret_value().
    anthropic_api_key: SecretStr | None = None
    anthropic_model: str = "claude-opus-5"
    llm_effort: str = "medium"  # anthropic-only reasoning-depth lever

    @property
    def anthropic_key_value(self) -> str | None:
        """The plaintext key, or None when unset/blank.

        An empty env value parses to SecretStr(''), which is truthy as an
        object -- so callers must not do bool(anthropic_api_key). This
        normalises blank to None so a missing key reads as missing everywhere.
        """
        if self.anthropic_api_key is None:
            return None
        value = self.anthropic_api_key.get_secret_value()
        return value or None

    # --- embedding and storage -------------------------------------------
    embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    chroma_dir: str = "chroma_data"

    # --- chunking ---------------------------------------------------------
    # 800 chars is ~200 tokens, under MiniLM's 256-token ceiling. Exceeding it
    # truncates SILENTLY -- no error -- so this is a correctness bound.
    chunk_size: int = 800
    chunk_overlap: int = 150

    # --- retrieval ---------------------------------------------------------
    retrieval_top_k: int = 5
    retrieval_score_threshold: float = 0.35

    @model_validator(mode="after")
    def _validate_provider(self) -> "Settings":
        """Reject an unknown provider at construction, so startup fails loudly.

        Catching it here -- rather than at the first /query -- means a typo in
        LLM_PROVIDER stops the service immediately with a clear message, not
        hours later when someone finally asks a question.
        """
        supported = {"ollama", "anthropic"}
        provider = (self.llm_provider or "").strip().lower()
        if provider not in supported:
            raise ValueError(
                f"Unknown LLM_PROVIDER {self.llm_provider!r}. "
                f"Supported: {', '.join(sorted(supported))}."
            )
        self.llm_provider = provider
        return self

    @model_validator(mode="after")
    def _anchor_chroma_dir(self) -> "Settings":
        """Resolve a relative chroma_dir against the repo root, not the CWD.

        The .env ships CHROMA_DIR=chroma_data (relative), and the default is
        relative too. Left as-is, the vector store lands wherever the process
        was launched from -- so indexing and querying could even use different
        directories across restarts. Anchoring it makes the store location
        deterministic.
        """
        if not Path(self.chroma_dir).is_absolute():
            self.chroma_dir = str(_REPO_ROOT / self.chroma_dir)
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached so the environment is read once, and so tests can clear it."""
    return Settings()
