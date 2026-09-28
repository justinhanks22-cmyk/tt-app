from __future__ import annotations

import os
import shutil
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path

from starlette.responses import FileResponse, Response

from .base import KEY_RE, Storage, check_key


class LocalStorage(Storage):
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def key_for(self, file_id: str) -> str:
        return check_key(f"{file_id}.mp4")

    def _path(self, key: str) -> Path:
        path = (self.root / check_key(key)).resolve()
        if path.parent != self.root:  # defence in depth against traversal
            raise ValueError("storage key escapes storage root")
        return path

    def put(self, local_path: Path, key: str) -> None:
        dst = self._path(key)
        tmp = dst.with_name(f".{dst.name}.tmp")
        shutil.move(str(local_path), tmp)
        os.chmod(tmp, 0o600)
        os.replace(tmp, dst)

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    def download_response(self, key: str, filename: str, expires_at: datetime, head: bool = False) -> Response:
        return FileResponse(
            self._path(key),
            media_type="video/mp4",
            filename=filename,  # sets Content-Disposition: attachment; filename="..."
            headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"},
        )  # Starlette answers HEAD requests without a body and supports Range requests

    def iter_objects(self) -> Iterator[tuple[str, datetime]]:
        for entry in os.scandir(self.root):
            if entry.is_file() and KEY_RE.fullmatch(entry.name):
                yield entry.name, _mtime(entry)

    def sweep_partial(self, older_than: datetime) -> int:
        count = 0
        for entry in os.scandir(self.root):
            if entry.is_file() and entry.name.startswith(".") and entry.name.endswith(".tmp"):
                if _mtime(entry) <= older_than:
                    os.unlink(entry.path)
                    count += 1
        return count


def _mtime(entry: os.DirEntry) -> datetime:
    return datetime.fromtimestamp(entry.stat().st_mtime, timezone.utc).replace(tzinfo=None)
