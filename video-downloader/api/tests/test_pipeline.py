"""End-to-end job processing with a stubbed yt-dlp (no network) and real FFmpeg."""

import sys
from pathlib import Path

import pytest

from app.config import get_settings
from app.db import session_scope
from app.jobs.processor import process_job
from app.jobs.runner import claim_next_job
from app.models import Job, JobStatus
from app.storage import get_storage
from app.util import new_id

from .conftest import needs_ffmpeg

pytestmark = needs_ffmpeg
FAKE = Path(__file__).with_name("fake_ytdlp.py")


@pytest.fixture
def fake_ytdlp(settings, monkeypatch, sample_videos):
    monkeypatch.setenv("YTDLP_COMMAND", f"{sys.executable} {FAKE}")
    monkeypatch.setenv("FAKE_YTDLP_SOURCE", str(sample_videos["vp9_opus"]))
    get_settings.cache_clear()
    return get_settings()


def _queue(url="https://www.tiktok.com/@creator/video/1") -> str:
    jid = new_id()
    with session_scope() as s:
        s.add(Job(id=jid, platform="tiktok", source_url=url, session_hash="s", client_hash="c"))
    return jid


def _get(jid) -> Job:
    with session_scope() as s:
        return s.get(Job, jid)


def test_full_pipeline(fake_ytdlp):
    jid = _queue()
    assert claim_next_job("w1") == jid
    assert claim_next_job("w2") is None  # a job can only be claimed once
    process_job(jid, fake_ytdlp, get_storage())
    job = _get(jid)
    assert job.status == JobStatus.COMPLETE, job.error_message
    assert (job.width, job.height) == (320, 240)
    assert job.video_codec == "vp9" and job.audio_codec == "aac"
    assert job.filename.endswith(".mp4") and "creator" not in job.filename
    assert job.expires_at is not None and (job.expires_at - job.completed_at).total_seconds() == 24 * 3600
    stored = fake_ytdlp.local_storage_dir / job.storage_key
    assert stored.is_file() and stored.stat().st_size == job.size_bytes
    assert b"creator" not in stored.read_bytes()
    # the temporary working directory is always removed
    assert not (fake_ytdlp.work_dir / jid).exists()


@pytest.mark.parametrize(
    "mode, code",
    [("private", "restricted"), ("generic", "unsupported_url"), ("live", "live_stream"), ("huge", "too_large")],
)
def test_pipeline_failures(fake_ytdlp, monkeypatch, mode, code):
    monkeypatch.setenv("FAKE_YTDLP_MODE", mode)
    jid = _queue()
    process_job(jid, fake_ytdlp, get_storage())
    job = _get(jid)
    assert job.status == JobStatus.FAILED
    assert job.error_code == code
    assert job.storage_key is None
    assert not (fake_ytdlp.work_dir / jid).exists()


def test_processing_timeout(fake_ytdlp, monkeypatch):
    monkeypatch.setattr(fake_ytdlp, "processing_timeout_seconds", 0)
    jid = _queue()
    process_job(jid, fake_ytdlp, get_storage())
    assert _get(jid).error_code == "timeout"
