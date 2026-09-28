"""The processing pipeline for one job: locate → download → process → prepare → complete."""

from __future__ import annotations

import logging
import shutil
import time
from datetime import timedelta
from pathlib import Path

from sqlalchemy import update

from ..config import Settings
from ..db import session_scope
from ..errors import JobError
from ..media import ffmpeg, ytdlp
from ..models import Job, JobStatus
from ..storage import Storage
from ..url_validation import validate_url
from ..util import new_download_filename, new_id, utcnow

log = logging.getLogger(__name__)


def update_job(job_id: str, **fields) -> None:
    fields["updated_at"] = utcnow()
    with session_scope() as s:
        s.execute(update(Job).where(Job.id == job_id).values(**fields))


def free_disk_bytes(path: Path) -> int:
    path.mkdir(parents=True, exist_ok=True)
    return shutil.disk_usage(path).free


class _Deadline:
    def __init__(self, seconds: float):
        self.end = time.monotonic() + seconds

    def remaining(self, cap: float | None = None) -> float:
        left = self.end - time.monotonic()
        if left <= 0:
            raise JobError("timeout")
        return min(left, cap) if cap else left


def process_job(job_id: str, settings: Settings, storage: Storage) -> None:
    workdir = settings.work_dir / job_id
    deadline = _Deadline(settings.processing_timeout_seconds)
    try:
        with session_scope() as s:
            job = s.get(Job, job_id)
            if job is None or not job.source_url:
                return
            source_url = job.source_url

        # Re-validate at processing time (also re-checks DNS → public addresses only).
        target = validate_url(
            source_url,
            allow_http=settings.allow_http,
            enable_other=settings.enable_other_platforms,
            extra_domains=settings.extra_domains,
        )
        needed = settings.max_file_size_bytes * 2 + settings.min_free_disk_mb * 1024 * 1024
        if free_disk_bytes(settings.work_dir) < needed:
            raise JobError("server_busy")
        workdir.mkdir(parents=True, exist_ok=False)

        # 1. Finding video
        update_job(job_id, status=JobStatus.LOCATING, progress=None)
        located = ytdlp.locate(target.url, target.platform, workdir, settings, deadline.remaining(settings.locate_timeout_seconds))

        # 2. Downloading
        update_job(job_id, status=JobStatus.DOWNLOADING, progress=0.0)
        last = {"t": 0.0, "p": 0.0}

        def on_progress(p: float) -> None:
            now = time.monotonic()
            if now - last["t"] >= 1.0 and p - last["p"] >= 0.01:
                last.update(t=now, p=p)
                update_job(job_id, progress=round(p, 3))

        source = ytdlp.download(located, workdir, settings, deadline.remaining(), on_progress)

        # 3. Processing (merge/remux/convert + strip metadata)
        update_job(job_id, status=JobStatus.PROCESSING, progress=None)
        output = workdir / "export.mp4"
        plan, info = ffmpeg.export_mp4(source, output, settings, deadline.remaining())
        source.unlink(missing_ok=True)
        log.info("job %s exported (copy_video=%s copy_audio=%s)", job_id, plan.copy_video, plan.copy_audio)

        # 4. Preparing download
        update_job(job_id, status=JobStatus.PREPARING, progress=None)
        file_id = new_id()
        key = storage.key_for(file_id)
        storage.put(output, key)

        now = utcnow()
        update_job(
            job_id,
            status=JobStatus.COMPLETE,
            progress=1.0,
            file_id=file_id,
            filename=new_download_filename(),
            storage_key=key,
            size_bytes=info.size,
            width=info.width,
            height=info.height,
            duration=info.duration,
            video_codec=(info.video or {}).get("codec_name"),
            audio_codec=(info.audio or {}).get("codec_name"),
            completed_at=now,
            expires_at=now + timedelta(hours=settings.file_ttl_hours),
        )
    except JobError as exc:
        log.info("job %s failed: %s", job_id, exc.code)
        update_job(job_id, status=JobStatus.FAILED, progress=None, error_code=exc.code, error_message=exc.message)
    except Exception:
        log.exception("job %s crashed", job_id)
        err = JobError("internal_error")
        update_job(job_id, status=JobStatus.FAILED, progress=None, error_code=err.code, error_message=err.message)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
