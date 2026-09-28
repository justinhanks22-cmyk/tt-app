"""HTTP API consumed by the Next.js frontend (via its same-origin /api proxy)."""

from __future__ import annotations

import hmac
import re
import secrets
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..config import Settings, get_settings
from ..db import session_scope
from ..errors import JobError
from ..jobs.processor import free_disk_bytes
from ..models import Job, JobStatus
from ..platforms import display_name, enabled_platforms
from ..signing import LinkState, check_link, download_path
from ..storage import get_storage
from ..url_validation import validate_url
from ..util import HEX32, iso, keyed_hash, new_id, utcnow
from . import pages
from .ratelimit import SlidingWindowLimiter

router = APIRouter()

SESSION_COOKIE = "vd_session"
_SESSION_RE = re.compile(r"^[A-Za-z0-9_-]{32,64}$")
_limiters: dict[str, SlidingWindowLimiter] = {}


# --- helpers -------------------------------------------------------------------------------
def client_ip(request: Request, settings: Settings) -> str:
    """The end user's IP. Only trusted from the frontend proxy when it proves the shared token."""
    token = request.headers.get("x-internal-proxy-token", "")
    if settings.internal_proxy_token and hmac.compare_digest(token, settings.internal_proxy_token):
        forwarded = request.headers.get("x-client-ip", "").strip()
        if forwarded:
            return forwarded[:64]
    return request.client.host if request.client else "unknown"


def _session_id(request: Request) -> str | None:
    value = request.cookies.get(SESSION_COOKIE, "")
    return value if _SESSION_RE.fullmatch(value) else None


def _error(status: int, code: str, message: str, headers: dict[str, str] | None = None) -> JSONResponse:
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status, headers=headers)


def rate_limit(request: Request, settings: Settings = Depends(get_settings)) -> None:
    limiter = _limiters.get("requests")
    if limiter is None or limiter.limit != settings.rate_limit_requests_per_minute:
        limiter = _limiters["requests"] = SlidingWindowLimiter(settings.rate_limit_requests_per_minute, 60)
    retry = limiter.hit(client_ip(request, settings))
    if retry is not None:
        raise HTTPException(
            status_code=429,
            detail={"code": "rate_limited", "message": "Too many requests. Please slow down."},
            headers={"Retry-After": str(int(retry) + 1)},
        )


def serialize_job(job: Job, settings: Settings) -> dict[str, Any]:
    data: dict[str, Any] = {
        "id": job.id,
        "status": job.status,
        "progress": job.progress,
        "platform": job.platform,
        "platform_name": display_name(job.platform),
        "created_at": iso(job.created_at),
        "error": None,
        "result": None,
        "expires_at": iso(job.expires_at),
    }
    if job.status == JobStatus.FAILED:
        data["error"] = {"code": job.error_code, "message": job.error_message}
    if job.status == JobStatus.COMPLETE and job.file_id and job.expires_at:
        if job.expires_at <= utcnow():
            data["status"] = JobStatus.EXPIRED  # cleanup hasn't run yet; never offer an expired file
        else:
            data["result"] = {
                "filename": job.filename,
                "size_bytes": job.size_bytes,
                "width": job.width,
                "height": job.height,
                "duration": job.duration,
                "download_url": download_path(settings.secret_key, job.file_id, job.expires_at),
            }
    return data


# --- routes ------------------------------------------------------------------------------
class CreateJobRequest(BaseModel):
    url: str = Field(max_length=4096)


@router.post("/api/jobs", status_code=202, dependencies=[Depends(rate_limit)])
def create_job(body: CreateJobRequest, request: Request, response: Response, settings: Settings = Depends(get_settings)):
    if not request.headers.get("content-type", "").startswith("application/json"):
        return _error(415, "invalid_request", "Expected a JSON request.")
    try:
        target = validate_url(
            body.url,
            allow_http=settings.allow_http,
            enable_other=settings.enable_other_platforms,
            extra_domains=settings.extra_domains,
        )
    except JobError as exc:
        return _error(400, exc.code, exc.message)

    session_id = _session_id(request)
    new_session = session_id is None
    if session_id is None:
        session_id = secrets.token_urlsafe(32)
    session_hash = keyed_hash(settings.secret_key, "session:" + session_id)
    client_hash = keyed_hash(settings.secret_key, "ip:" + client_ip(request, settings))
    now = utcnow()

    with session_scope() as s:
        active = s.scalar(
            select(func.count()).select_from(Job).where(Job.client_hash == client_hash, Job.status.in_(JobStatus.PENDING))
        )
        if active >= settings.rate_limit_active_jobs:
            return _error(429, "rate_limited", "You already have videos processing. Please wait for them to finish.")
        recent = s.scalar(
            select(func.count())
            .select_from(Job)
            .where(Job.client_hash == client_hash, Job.created_at >= now - timedelta(hours=1))
        )
        if recent >= settings.rate_limit_jobs_per_hour:
            return _error(429, "rate_limited", "Hourly download limit reached. Please try again later.", {"Retry-After": "600"})
        queued = s.scalar(select(func.count()).select_from(Job).where(Job.status == JobStatus.QUEUED))
        stored = s.scalar(select(func.coalesce(func.sum(Job.size_bytes), 0)).where(Job.status == JobStatus.COMPLETE))
        if queued >= settings.max_queue_length or (
            stored + settings.max_file_size_bytes > settings.storage_quota_gb * 1024**3
        ):
            err = JobError("server_busy")
            return _error(503, err.code, err.message, {"Retry-After": "120"})
    if settings.run_embedded_worker and free_disk_bytes(settings.work_dir) < settings.min_free_disk_mb * 1024 * 1024:
        err = JobError("server_busy")
        return _error(503, err.code, err.message, {"Retry-After": "120"})

    job = Job(
        id=new_id(),
        status=JobStatus.QUEUED,
        platform=target.platform.id,
        source_url=target.url,
        session_hash=session_hash,
        client_hash=client_hash,
        created_at=now,
        updated_at=now,
    )
    with session_scope() as s:
        s.add(job)

    worker = getattr(request.app.state, "worker", None)
    if worker is not None:
        worker.notify()
    if new_session:
        # Session cookie (no Max-Age): "my videos" lasts for this browser session, no account needed.
        response.set_cookie(
            SESSION_COOKIE, session_id, httponly=True, samesite="lax", secure=settings.cookie_secure, path="/"
        )
    return {"job": serialize_job(job, settings)}


@router.get("/api/jobs/{job_id}", dependencies=[Depends(rate_limit)])
def get_job(job_id: str, settings: Settings = Depends(get_settings)):
    if not HEX32.fullmatch(job_id):
        return _error(404, "not_found", "Job not found.")
    with session_scope() as s:
        job = s.get(Job, job_id)
    if job is None:
        return _error(404, "not_found", "This job no longer exists. Files are deleted after 24 hours.")
    return {"job": serialize_job(job, settings)}


@router.get("/api/history", dependencies=[Depends(rate_limit)])
def history(request: Request, settings: Settings = Depends(get_settings)):
    session_id = _session_id(request)
    if session_id is None:
        return {"jobs": []}
    session_hash = keyed_hash(settings.secret_key, "session:" + session_id)
    with session_scope() as s:
        jobs = s.scalars(
            select(Job).where(Job.session_hash == session_hash).order_by(Job.created_at.desc()).limit(50)
        ).all()
    return {"jobs": [serialize_job(j, settings) for j in jobs]}


@router.api_route("/api/download/{file_id}", methods=["GET", "HEAD"], dependencies=[Depends(rate_limit)])
def download(file_id: str, request: Request, exp: str = "", sig: str = "", settings: Settings = Depends(get_settings)):
    if not HEX32.fullmatch(file_id):
        return pages.not_found_page()
    now = utcnow()
    state = check_link(settings.secret_key, file_id, exp, sig, now)
    if state is LinkState.INVALID:
        return pages.not_found_page()
    if state is LinkState.EXPIRED:
        return pages.expired_page()
    with session_scope() as s:
        job = s.scalar(select(Job).where(Job.file_id == file_id))
    if (
        job is None
        or job.status != JobStatus.COMPLETE
        or not job.storage_key
        or not job.filename
        or job.expires_at is None
        or job.expires_at <= now
    ):
        return pages.expired_page()
    resp = get_storage().download_response(job.storage_key, job.filename, job.expires_at, head=request.method == "HEAD")
    resp.headers["X-Robots-Tag"] = "noindex"
    return resp


@router.get("/api/config")
def public_config(settings: Settings = Depends(get_settings)):
    return {
        "platforms": [
            {"id": p.id, "name": p.name, "primary": p.primary}
            for p in enabled_platforms(settings.enable_other_platforms)
        ],
        "max_file_size_mb": settings.max_file_size_mb,
        "max_duration_seconds": settings.max_duration_seconds,
        "file_ttl_hours": settings.file_ttl_hours,
    }


@router.get("/healthz")
def healthz():
    with session_scope() as s:
        s.execute(select(1))
    return {"ok": True}
