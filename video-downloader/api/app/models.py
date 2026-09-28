"""Persistent job/file record."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Float, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base
from .util import utcnow


class JobStatus:
    QUEUED = "queued"
    LOCATING = "locating"
    DOWNLOADING = "downloading"
    PROCESSING = "processing"
    PREPARING = "preparing"
    COMPLETE = "complete"
    FAILED = "failed"
    EXPIRED = "expired"

    ACTIVE = (LOCATING, DOWNLOADING, PROCESSING, PREPARING)
    PENDING = (QUEUED, *ACTIVE)
    TERMINAL = (COMPLETE, FAILED, EXPIRED)


class Job(Base):
    """One download request and, once complete, the temporary file it produced.

    A job is the unit the worker processes; when it completes it also carries the file record
    (file id, generated filename, storage key, size, expiry). Expired jobs have their file
    deleted and file fields scrubbed, then the whole row is purged after a retention window.
    """

    __tablename__ = "jobs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    status: Mapped[str] = mapped_column(String(16), default=JobStatus.QUEUED, index=True)
    progress: Mapped[float | None] = mapped_column(Float, nullable=True)

    platform: Mapped[str] = mapped_column(String(32))
    source_url: Mapped[str | None] = mapped_column(Text, nullable=True)  # scrubbed on expiry

    session_hash: Mapped[str] = mapped_column(String(32), index=True)
    client_hash: Mapped[str] = mapped_column(String(32), index=True)

    error_code: Mapped[str | None] = mapped_column(String(32), nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    worker_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # --- File record (set when complete) ---------------------------------------
    file_id: Mapped[str | None] = mapped_column(String(32), unique=True, nullable=True)
    filename: Mapped[str | None] = mapped_column(String(64), nullable=True)
    storage_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration: Mapped[float | None] = mapped_column(Float, nullable=True)
    video_codec: Mapped[str | None] = mapped_column(String(16), nullable=True)
    audio_codec: Mapped[str | None] = mapped_column(String(16), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)

    __table_args__ = (Index("ix_jobs_status_created", "status", "created_at"),)
