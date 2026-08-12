"""Configuration, read once and validated at import."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- security -------------------------------------------------------
    # Must match server/.env. This service performs NO authorisation of its
    # own -- it receives an opaque kb_id and trusts that Node authorised the
    # caller (ADR 001). That is only safe because it binds to loopback.
    internal_api_key: str = "dev-internal-key-change-me"
    host: str = "127.0.0.1"
    port: int = 8000

    node_api_url: str = "http://127.0.0.1:4200"

    # --- generation -----------------------------------------------------
    # Optional on purpose. Everything except the final generation step runs
    # locally, so the service must start, index documents and serve semantic
    # search with no key present.
    anthropic_api_key: str | None = None
    llm_model: str = "claude-opus-5"
    llm_effort: str = "medium"
    llm_max_tokens: int = 8192

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

    @property
    def generation_available(self) -> bool:
        """False when no key is configured; the API reports this rather than failing late."""
        return bool(self.anthropic_api_key)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Cached so the environment is read once, and so tests can clear it."""
    return Settings()
