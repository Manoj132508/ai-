"""Structured JSON logging, in the same shape the Node API emits.

Both services writing the same fields is what makes a single `grep` on a
request id reconstruct a whole request across the process boundary. Different
shapes would mean two parsers and two mental models for one trace.
"""

import json
import sys
from datetime import UTC, datetime
from typing import Any


def _emit(level: str, message: str, **fields: Any) -> None:
    line = {
        "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "level": level,
        "message": message,
        **fields,
    }
    stream = sys.stderr if level in ("warn", "error") else sys.stdout
    stream.write(json.dumps(line, default=str) + "\n")
    stream.flush()


def debug(message: str, **fields: Any) -> None:
    _emit("debug", message, **fields)


def info(message: str, **fields: Any) -> None:
    _emit("info", message, **fields)


def warn(message: str, **fields: Any) -> None:
    _emit("warn", message, **fields)


def error(message: str, **fields: Any) -> None:
    _emit("error", message, **fields)
