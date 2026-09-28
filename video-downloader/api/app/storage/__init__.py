"""Storage backends for finished files: local filesystem (dev) or S3-compatible object storage (prod)."""

from __future__ import annotations

from functools import lru_cache

from ..config import Settings, get_settings
from .base import Storage


def build_storage(settings: Settings) -> Storage:
    if settings.storage_backend == "s3":
        from .s3 import S3Storage

        return S3Storage(settings)
    from .local import LocalStorage

    return LocalStorage(settings.local_storage_dir)


@lru_cache
def get_storage() -> Storage:
    return build_storage(get_settings())


__all__ = ["Storage", "build_storage", "get_storage"]
