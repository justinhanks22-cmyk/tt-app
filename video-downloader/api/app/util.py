"""Small shared helpers: time, random identifiers, hashing."""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from datetime import datetime, timezone

HEX32 = re.compile(r"^[0-9a-f]{32}$")


def utcnow() -> datetime:
    """Naive UTC 'now'. All timestamps are stored as naive UTC (portable across SQLite and Postgres)."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def iso(dt: datetime | None) -> str | None:
    return None if dt is None else dt.replace(microsecond=0).isoformat() + "Z"


def new_id() -> str:
    """128-bit cryptographically random identifier (32 hex chars)."""
    return secrets.token_hex(16)


def new_download_filename() -> str:
    """Random, non-identifying filename such as '8f2d7c41-a83e-4d7c.mp4'."""
    h = secrets.token_hex(8)
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}.mp4"


def keyed_hash(secret: str, value: str) -> str:
    """Keyed hash for values we must correlate but never store in clear (IP, session cookie)."""
    return hmac.new(secret.encode(), value.encode(), hashlib.sha256).hexdigest()[:32]
