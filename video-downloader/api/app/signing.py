"""HMAC-signed, unguessable download links. The link never contains a storage path."""

from __future__ import annotations

import hashlib
import hmac
from datetime import datetime, timezone
from enum import Enum


class LinkState(Enum):
    VALID = "valid"
    EXPIRED = "expired"
    INVALID = "invalid"


def _sig(secret: str, file_id: str, exp: int) -> str:
    return hmac.new(secret.encode(), f"download:{file_id}:{exp}".encode(), hashlib.sha256).hexdigest()[:40]


def _ts(dt: datetime) -> int:
    return int(dt.replace(tzinfo=timezone.utc).timestamp())


def download_path(secret: str, file_id: str, expires_at: datetime) -> str:
    exp = _ts(expires_at)
    return f"/api/download/{file_id}?exp={exp}&sig={_sig(secret, file_id, exp)}"


def check_link(secret: str, file_id: str, exp: str, sig: str, now: datetime) -> LinkState:
    try:
        exp_int = int(exp)
    except (TypeError, ValueError):
        return LinkState.INVALID
    if not sig or not hmac.compare_digest(_sig(secret, file_id, exp_int), sig):
        return LinkState.INVALID
    if exp_int <= _ts(now):
        return LinkState.EXPIRED
    return LinkState.VALID
