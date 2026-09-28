"""Expiry and garbage collection. Safe to run from several processes at once (all steps idempotent).

Run periodically by every worker process, and runnable on its own from cron / a scheduled job:

    python -m app.cleanup
"""

from __future__ import annotations

import logging
import os
import shutil
import time
from datetime import datetime, timedelta

from sqlalchemy import delete, or_, select, update

from .config import Settings
from .db import session_scope
from .errors import JobError
from .models import Job, JobStatus
from .storage import Storage
from .util import utcnow

log = logging.getLogger(__name__)

# Grace period before an unreferenced object is treated as an orphan (it may be mid-hand-off).
ORPHAN_GRACE = timedelta(hours=1)


def expire_files(settings: Settings, storage: Storage, now: datetime) -> int:
    """Delete files whose 24 h lifetime is over and scrub the job's file/source fields."""
    with session_scope() as s:
        due = s.execute(
            select(Job.id, Job.storage_key).where(Job.status == JobStatus.COMPLETE, Job.expires_at <= now)
        ).all()
    count = 0
    for job_id, key in due:
        if key:
            storage.delete(key)  # delete from storage first; a failure leaves the row to retry
        with session_scope() as s:
            s.execute(
                update(Job)
                .where(Job.id == job_id, Job.status == JobStatus.COMPLETE)
                .values(
                    status=JobStatus.EXPIRED,
                    storage_key=None,
                    filename=None,
                    source_url=None,
                    updated_at=now,
                )
            )
        count += 1
    return count


def purge_records(settings: Settings, now: datetime) -> int:
    """Remove expired/failed job rows entirely once the retention window has passed."""
    cutoff = now - timedelta(hours=settings.job_record_retention_hours)
    with session_scope() as s:
        result = s.execute(
            delete(Job).where(
                or_(
                    (Job.status == JobStatus.EXPIRED) & (Job.expires_at <= cutoff),
                    (Job.status == JobStatus.FAILED) & (Job.updated_at <= cutoff),
                )
            )
        )
        return result.rowcount or 0


def recover_stale_jobs(settings: Settings, now: datetime) -> int:
    """Fail jobs whose worker died (no progress update for longer than the processing timeout)."""
    cutoff = now - timedelta(seconds=settings.processing_timeout_seconds + 120)
    err = JobError("worker_lost")
    with session_scope() as s:
        result = s.execute(
            update(Job)
            .where(Job.status.in_(JobStatus.ACTIVE), Job.updated_at <= cutoff)
            .values(status=JobStatus.FAILED, error_code=err.code, error_message=err.message, progress=None, updated_at=now)
        )
        stale = result.rowcount or 0
        # Jobs that sat in the queue far too long (no worker running) are failed too.
        queue_cutoff = now - timedelta(hours=1)
        busy = JobError("server_busy")
        result = s.execute(
            update(Job)
            .where(Job.status == JobStatus.QUEUED, Job.created_at <= queue_cutoff)
            .values(status=JobStatus.FAILED, error_code=busy.code, error_message=busy.message, updated_at=now)
        )
        return stale + (result.rowcount or 0)


def sweep_orphans(settings: Settings, storage: Storage, now: datetime) -> int:
    """Delete stored objects that no live job references, and anything older than the TTL.

    This is the backstop that guarantees files don't outlive their TTL even if the database
    and storage ever disagree (crash between upload and DB update, restored backup, etc.).
    """
    with session_scope() as s:
        live = set(
            s.scalars(select(Job.storage_key).where(Job.status == JobStatus.COMPLETE, Job.storage_key.is_not(None)))
        )
    hard_limit = now - timedelta(hours=settings.file_ttl_hours) - ORPHAN_GRACE
    count = 0
    for key, modified in storage.iter_objects():
        if (key not in live and modified <= now - ORPHAN_GRACE) or modified <= hard_limit:
            try:
                storage.delete(key)
                count += 1
            except (ValueError, OSError):
                log.warning("could not delete orphan %r", key)
    count += storage.sweep_partial(now - ORPHAN_GRACE)
    return count


def sweep_workdirs(settings: Settings, now: datetime) -> int:
    """Remove temporary download directories left behind by crashed workers."""
    root = settings.work_dir
    if not root.is_dir():
        return 0
    with session_scope() as s:
        active = set(s.scalars(select(Job.id).where(Job.status.in_(JobStatus.PENDING))))
    max_age = settings.processing_timeout_seconds + 600
    count = 0
    for entry in os.scandir(root):
        if entry.name.startswith(".") or not entry.is_dir() or entry.name in active:
            continue
        if time.time() - entry.stat().st_mtime > max_age:
            shutil.rmtree(entry.path, ignore_errors=True)
            count += 1
    return count


def run_cleanup(settings: Settings, storage: Storage, now: datetime | None = None) -> dict[str, int]:
    now = now or utcnow()
    return {
        "expired": expire_files(settings, storage, now),
        "purged": purge_records(settings, now),
        "stale": recover_stale_jobs(settings, now),
        "orphans": sweep_orphans(settings, storage, now),
        "workdirs": sweep_workdirs(settings, now),
    }


def main() -> None:  # pragma: no cover - CLI
    from .config import get_settings
    from .db import init_engine
    from .storage import get_storage

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = get_settings()
    settings.validate_for_runtime()
    init_engine(settings.database_url)
    print(run_cleanup(settings, get_storage()))


if __name__ == "__main__":  # pragma: no cover
    main()
