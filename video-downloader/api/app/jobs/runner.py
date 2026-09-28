"""Database-backed job queue worker.

Jobs are rows in the `jobs` table. Any number of worker processes (each with N threads) claim
queued jobs with an atomic conditional UPDATE, so the worker can run inside the API process
(development) or as separate containers/machines (production) without a separate broker.
"""

from __future__ import annotations

import logging
import os
import socket
import threading

from sqlalchemy import select, update

from ..cleanup import run_cleanup
from ..config import Settings
from ..db import session_scope
from ..models import Job, JobStatus
from ..storage import Storage
from ..util import utcnow
from .processor import process_job

log = logging.getLogger(__name__)


def claim_next_job(worker_id: str) -> str | None:
    with session_scope() as s:
        candidates = s.scalars(
            select(Job.id).where(Job.status == JobStatus.QUEUED).order_by(Job.created_at).limit(5)
        ).all()
        for job_id in candidates:
            now = utcnow()
            result = s.execute(
                update(Job)
                .where(Job.id == job_id, Job.status == JobStatus.QUEUED)
                .values(status=JobStatus.LOCATING, worker_id=worker_id, started_at=now, updated_at=now)
            )
            if result.rowcount == 1:
                s.commit()
                return job_id
    return None


class Worker:
    def __init__(self, settings: Settings, storage: Storage, *, concurrency: int | None = None, cleanup: bool = True):
        self.settings = settings
        self.storage = storage
        self.concurrency = concurrency or settings.worker_concurrency
        self.cleanup = cleanup
        self.worker_id = f"{socket.gethostname()}:{os.getpid()}"
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._threads: list[threading.Thread] = []

    def start(self) -> None:
        self.settings.work_dir.mkdir(parents=True, exist_ok=True)
        for i in range(self.concurrency):
            t = threading.Thread(target=self._loop, name=f"job-worker-{i}", daemon=True)
            t.start()
            self._threads.append(t)
        if self.cleanup:
            t = threading.Thread(target=self._cleanup_loop, name="cleanup", daemon=True)
            t.start()
            self._threads.append(t)
        log.info("worker %s started with %d thread(s)", self.worker_id, self.concurrency)

    def notify(self) -> None:
        """Wake idle threads immediately (used by the embedded worker when a job is created)."""
        self._wake.set()

    def stop(self, timeout: float = 10) -> None:
        self._stop.set()
        self._wake.set()
        for t in self._threads:
            t.join(timeout=timeout)

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                job_id = claim_next_job(self.worker_id)
            except Exception:
                log.exception("failed to claim job")
                job_id = None
            if job_id:
                process_job(job_id, self.settings, self.storage)
                continue
            self._wake.wait(self.settings.worker_poll_seconds)
            self._wake.clear()

    def _cleanup_loop(self) -> None:
        while not self._stop.is_set():
            try:
                stats = run_cleanup(self.settings, self.storage)
                if any(stats.values()):
                    log.info("cleanup: %s", stats)
            except Exception:
                log.exception("cleanup failed")
            self._stop.wait(self.settings.cleanup_interval_seconds)
