"""Application settings, loaded from environment variables (and an optional .env file)."""

from __future__ import annotations

import logging
import shutil
import sys
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger(__name__)

INSECURE_DEV_SECRET = "dev-insecure-secret-change-me"


class Settings(BaseSettings):
    # ../.env is the shared project file (also used by Docker Compose); ./.env overrides it.
    model_config = SettingsConfigDict(env_file=("../.env", ".env"), extra="ignore")

    environment: Literal["development", "production", "test"] = "development"

    # --- Database -------------------------------------------------------------
    database_url: str = "sqlite:///./data/app.db"

    # --- Storage ---------------------------------------------------------------
    storage_backend: Literal["local", "s3"] = "local"
    local_storage_dir: Path = Path("./data/files")
    work_dir: Path = Path("./data/work")
    s3_bucket: str = ""
    s3_prefix: str = "videos/"
    s3_region: str = "auto"
    s3_endpoint_url: str | None = None
    s3_access_key_id: str | None = None
    s3_secret_access_key: str | None = None
    s3_presign_seconds: int = 3600

    # --- Security --------------------------------------------------------------
    secret_key: str = INSECURE_DEV_SECRET
    # Shared secret the Next.js proxy sends so the API can trust its X-Client-IP header.
    internal_proxy_token: str = ""
    cookie_secure: bool = False
    allow_http: bool = False
    enable_other_platforms: bool = True
    extra_allowed_domains: str = ""  # comma separated, e.g. "example-video.com"

    # --- Limits ---------------------------------------------------------------
    file_ttl_hours: float = 24.0
    job_record_retention_hours: float = 24.0
    max_file_size_mb: int = 1024
    max_duration_seconds: int = 3 * 60 * 60
    processing_timeout_seconds: int = 15 * 60
    locate_timeout_seconds: int = 90
    storage_quota_gb: float = 20.0
    min_free_disk_mb: int = 2048
    max_queue_length: int = 50
    rate_limit_jobs_per_hour: int = 20
    rate_limit_active_jobs: int = 3
    rate_limit_requests_per_minute: int = 120

    # --- Worker ---------------------------------------------------------------
    run_embedded_worker: bool = True
    worker_concurrency: int = 2
    worker_poll_seconds: float = 1.0
    cleanup_interval_seconds: int = 300

    # --- Media tools ----------------------------------------------------------
    # "modern": keep H.264/HEVC/VP9/AV1 video as-is inside MP4 (plays in current browsers/phones).
    # "h264":   guarantee H.264 + AAC, re-encoding video only when the source isn't H.264.
    video_compat: Literal["modern", "h264"] = "modern"
    x264_preset: str = "veryfast"
    x264_crf: int = 18
    ytdlp_command: str = ""  # default: "<python> -m yt_dlp"
    ytdlp_js_runtime: str = "auto"  # "auto" | "none" | "deno" | "node" | "node:/path/to/node"
    ffmpeg_path: str = "ffmpeg"
    ffprobe_path: str = "ffprobe"

    @field_validator("s3_prefix")
    @classmethod
    def _prefix(cls, v: str) -> str:
        v = v.strip("/")
        return f"{v}/" if v else ""

    # --- Derived --------------------------------------------------------------
    @property
    def max_file_size_bytes(self) -> int:
        return self.max_file_size_mb * 1024 * 1024

    @property
    def extra_domains(self) -> list[str]:
        return [d.strip().lower().strip(".") for d in self.extra_allowed_domains.split(",") if d.strip()]

    @property
    def ytdlp_base_command(self) -> list[str]:
        if self.ytdlp_command.strip():
            import shlex

            return shlex.split(self.ytdlp_command)
        return [sys.executable, "-m", "yt_dlp"]

    @property
    def ytdlp_js_runtime_args(self) -> list[str]:
        rt = self.ytdlp_js_runtime.strip()
        if rt == "none":
            return []
        if rt == "auto":
            if shutil.which("deno"):
                return []  # deno is yt-dlp's default runtime
            node = shutil.which("node")
            return ["--js-runtimes", f"node:{node}"] if node else []
        return ["--js-runtimes", rt]

    def validate_for_runtime(self) -> None:
        if self.secret_key == INSECURE_DEV_SECRET:
            if self.environment == "production":
                raise RuntimeError("SECRET_KEY must be set in production")
            log.warning("SECRET_KEY is not set; using an insecure development key")
        if self.storage_backend == "s3" and not self.s3_bucket:
            raise RuntimeError("S3_BUCKET is required when STORAGE_BACKEND=s3")


@lru_cache
def get_settings() -> Settings:
    return Settings()
