from __future__ import annotations

import re
from abc import ABC, abstractmethod
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path

from starlette.responses import Response

# Storage keys are generated server-side only; anything else is refused (path traversal guard).
KEY_RE = re.compile(r"^(?:[a-z0-9_-]+/)*[0-9a-f]{32}\.mp4$")


def check_key(key: str) -> str:
    if not KEY_RE.fullmatch(key) or ".." in key:
        raise ValueError(f"invalid storage key: {key!r}")
    return key


class Storage(ABC):
    @abstractmethod
    def key_for(self, file_id: str) -> str: ...

    @abstractmethod
    def put(self, local_path: Path, key: str) -> None:
        """Move/upload a finished file into storage."""

    @abstractmethod
    def delete(self, key: str) -> None:
        """Delete permanently. Must not fail if the object is already gone."""

    @abstractmethod
    def exists(self, key: str) -> bool: ...

    @abstractmethod
    def download_response(self, key: str, filename: str, expires_at: datetime, head: bool = False) -> Response:
        """A response that delivers the file as an attachment without exposing where it's stored."""

    @abstractmethod
    def iter_objects(self) -> Iterator[tuple[str, datetime]]:
        """(key, last_modified as naive UTC) for every stored object, used by the orphan sweep."""

    def sweep_partial(self, older_than: datetime) -> int:
        """Remove half-written objects left by a crash. Returns how many were removed."""
        return 0
