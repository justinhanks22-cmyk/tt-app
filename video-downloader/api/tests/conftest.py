from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import url_validation
from app.config import get_settings
from app.db import init_engine
from app.storage import get_storage

HAS_FFMPEG = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None
needs_ffmpeg = pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe not installed")


@pytest.fixture
def settings(tmp_path, monkeypatch):
    env = {
        "ENVIRONMENT": "test",
        "DATABASE_URL": f"sqlite:///{tmp_path}/test.db",
        "LOCAL_STORAGE_DIR": str(tmp_path / "files"),
        "WORK_DIR": str(tmp_path / "work"),
        "SECRET_KEY": "test-secret",
        "INTERNAL_PROXY_TOKEN": "proxy-token",
        "RUN_EMBEDDED_WORKER": "false",
        "MIN_FREE_DISK_MB": "1",
        "MAX_FILE_SIZE_MB": "50",
    }
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    get_settings.cache_clear()
    get_storage.cache_clear()
    s = get_settings()
    init_engine(s.database_url)
    yield s
    get_settings.cache_clear()
    get_storage.cache_clear()


@pytest.fixture(autouse=True)
def no_dns(monkeypatch):
    """Tests never hit the network: pretend every allow-listed host resolves publicly."""
    monkeypatch.setattr(url_validation, "resolve_public", lambda host: None)


@pytest.fixture
def client(settings):
    from app.main import create_app

    with TestClient(create_app(settings)) as c:
        yield c


@pytest.fixture(scope="session")
def sample_videos(tmp_path_factory) -> dict[str, Path]:
    """Small generated clips with identifying metadata baked in."""
    if not HAS_FFMPEG:
        pytest.skip("ffmpeg not installed")
    d = tmp_path_factory.mktemp("media")
    meta = [
        "-metadata", "title=creator-name funny video",
        "-metadata", "artist=@creator",
        "-metadata", "comment=https://www.tiktok.com/@creator/video/123",
        "-metadata", "creation_time=2024-01-01T00:00:00Z",
    ]
    src = ["-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25", "-f", "lavfi", "-i", "sine=frequency=440"]
    out = {
        "h264_aac": (["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"], "mkv"),
        "vp9_opus": (["-c:v", "libvpx-vp9", "-b:v", "300k", "-c:a", "libopus"], "webm"),
        "mpeg4_mp3": (["-c:v", "mpeg4", "-c:a", "libmp3lame"], "avi"),
    }
    paths = {}
    for name, (codec, ext) in out.items():
        path = d / f"{name}.{ext}"
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", *src, "-t", "2", *codec, *meta, str(path)],
            check=True,
        )
        paths[name] = path
    return paths
