"""Shared-secret check for the internal API."""

import secrets

from app.core.config import get_settings
from fastapi import Header, HTTPException, status

INTERNAL_HEADER = "X-Internal-Key"


async def require_internal_key(x_internal_key: str | None = Header(default=None)) -> None:
    """Rejects any caller without the shared secret.

    This is not authentication of a *user* -- this service has no user model.
    It authenticates the *caller* as being the Node API, which is a much
    weaker claim and deliberately so: the real protection is that the service
    binds to loopback and is unreachable from outside the host (ADR 001).

    ``secrets.compare_digest`` rather than ``==``: a plain comparison exits at
    the first differing byte, so response time leaks how much of the secret a
    guess got right.
    """
    settings = get_settings()

    if x_internal_key is None or not secrets.compare_digest(
        x_internal_key, settings.internal_api_key
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing internal key.",
        )
