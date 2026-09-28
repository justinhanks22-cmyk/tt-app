import os
import time
from datetime import timedelta

from app.cleanup import run_cleanup
from app.db import session_scope
from app.models import Job, JobStatus
from app.storage import get_storage
from app.util import new_id, utcnow

TIKTOK = "https://www.tiktok.com/@creator/video/7234567890123456789"


def post(client, url=TIKTOK, ip="1.2.3.4", **kw):
    headers = {"x-internal-proxy-token": "proxy-token", "x-client-ip": ip}
    return client.post("/api/jobs", json={"url": url}, headers=headers, **kw)


def make_complete_job(settings, *, expires_in=timedelta(hours=24), session_hash="s") -> Job:
    storage = get_storage()
    file_id = new_id()
    key = storage.key_for(file_id)
    src = settings.work_dir / "tmp.mp4"
    src.parent.mkdir(parents=True, exist_ok=True)
    src.write_bytes(b"\x00\x00\x00\x18ftypisom" + b"\x00" * 100)
    storage.put(src, key)
    now = utcnow()
    job = Job(
        id=new_id(), status=JobStatus.COMPLETE, platform="tiktok", source_url=TIKTOK,
        session_hash=session_hash, client_hash="c", file_id=file_id, filename="8f2d7c41-a83e-4d7c.mp4",
        storage_key=key, size_bytes=112, width=1080, height=1920, duration=12.5,
        completed_at=now, expires_at=now + expires_in,
    )
    with session_scope() as s:
        s.add(job)
    return job


# --- job API --------------------------------------------------------------------------------
def test_create_and_poll_job(client):
    r = post(client)
    assert r.status_code == 202
    job = r.json()["job"]
    assert job["status"] == "queued" and job["platform"] == "tiktok" and job["platform_name"] == "TikTok"
    assert "vd_session" in r.cookies
    assert "httponly" in r.headers["set-cookie"].lower()
    r = client.get(f"/api/jobs/{job['id']}")
    assert r.status_code == 200 and r.json()["job"]["id"] == job["id"]
    with session_scope() as s:
        stored = s.get(Job, job["id"])
        assert stored.source_url == TIKTOK
        assert "1.2.3.4" not in stored.client_hash  # IPs are only stored as keyed hashes


def test_invalid_url_returns_useful_error(client):
    r = post(client, url="https://example.com/video.mp4")
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "unsupported_url"
    r = client.post("/api/jobs", json={"nope": 1})
    assert r.status_code == 400


def test_unknown_job(client):
    assert client.get(f"/api/jobs/{new_id()}").status_code == 404
    assert client.get("/api/jobs/../../etc/passwd").status_code == 404
    assert client.get("/api/jobs/not-hex").status_code == 404


def test_history_is_per_browser_session(client):
    post(client)
    r = client.get("/api/history")
    assert len(r.json()["jobs"]) == 1
    client.cookies.clear()
    assert client.get("/api/history").json()["jobs"] == []


def test_active_job_limit(client, settings):
    for _ in range(settings.rate_limit_active_jobs):
        assert post(client).status_code == 202
    r = post(client)
    assert r.status_code == 429
    assert post(client, ip="5.6.7.8").status_code == 202  # other clients unaffected


def test_hourly_limit(client, settings, monkeypatch):
    monkeypatch.setattr(settings, "rate_limit_active_jobs", 1000)
    for _ in range(settings.rate_limit_jobs_per_hour):
        assert post(client).status_code == 202
    assert post(client).status_code == 429


def test_client_ip_header_ignored_without_proxy_token(client, settings):
    # Without the shared token the spoofed header is ignored, so all requests share one identity.
    for i in range(settings.rate_limit_active_jobs):
        assert client.post("/api/jobs", json={"url": TIKTOK}, headers={"x-client-ip": f"9.9.9.{i}"}).status_code == 202
    assert client.post("/api/jobs", json={"url": TIKTOK}, headers={"x-client-ip": "9.9.9.99"}).status_code == 429


def test_request_rate_limit(client, settings, monkeypatch):
    monkeypatch.setattr(settings, "rate_limit_requests_per_minute", 5)
    codes = [client.get(f"/api/jobs/{new_id()}").status_code for _ in range(7)]
    assert codes[:5] == [404] * 5 and codes[5:] == [429, 429]


def test_storage_quota(client, settings, monkeypatch):
    monkeypatch.setattr(settings, "storage_quota_gb", 0.01)
    assert post(client).status_code == 503


# --- downloads ------------------------------------------------------------------------------
def _download_url(client, job):
    return client.get(f"/api/jobs/{job.id}").json()["job"]["result"]["download_url"]


def test_download(client, settings):
    job = make_complete_job(settings)
    data = client.get(f"/api/jobs/{job.id}").json()["job"]
    assert data["result"]["width"] == 1080 and data["result"]["size_bytes"] == 112
    url = data["result"]["download_url"]
    assert settings.local_storage_dir.name not in url and job.storage_key not in url
    r = client.get(url)
    assert r.status_code == 200
    assert r.headers["content-type"] == "video/mp4"
    assert r.headers["content-disposition"] == 'attachment; filename="8f2d7c41-a83e-4d7c.mp4"'
    assert r.content.startswith(b"\x00\x00\x00\x18ftyp")


def test_download_rejects_tampering(client, settings):
    job = make_complete_job(settings)
    url = _download_url(client, job)
    assert client.get(url[:-1] + ("0" if url[-1] != "0" else "1")).status_code == 404
    assert client.get(f"/api/download/{job.file_id}").status_code == 404
    assert client.get("/api/download/..%2F..%2Fetc%2Fpasswd?exp=1&sig=x").status_code == 404


def test_expired_download_shows_message(client, settings):
    job = make_complete_job(settings, expires_in=timedelta(seconds=-1))
    # never offered in the API once past expiry, even before cleanup runs
    data = client.get(f"/api/jobs/{job.id}").json()["job"]
    assert data["status"] == "expired" and data["result"] is None
    from app.signing import download_path

    r = client.get(download_path(settings.secret_key, job.file_id, job.expires_at))
    assert r.status_code == 410
    assert "expired" in r.text.lower() and "<html" in r.text


# --- cleanup --------------------------------------------------------------------------------
def test_cleanup_deletes_expired_files(client, settings):
    live = make_complete_job(settings)
    dead = make_complete_job(settings, expires_in=timedelta(seconds=-1))
    live_url = _download_url(client, live)
    live_path = settings.local_storage_dir / live.storage_key
    dead_path = settings.local_storage_dir / dead.storage_key
    from app.signing import download_path

    dead_url = download_path(settings.secret_key, dead.file_id, dead.expires_at)

    stats = run_cleanup(settings, get_storage())
    assert stats["expired"] == 1
    assert live_path.exists() and not dead_path.exists()
    with session_scope() as s:
        row = s.get(Job, dead.id)
        assert row.status == JobStatus.EXPIRED and row.storage_key is None and row.source_url is None
    assert client.get(live_url).status_code == 200
    assert client.get(dead_url).status_code == 410

    # after the retention window the database row is purged entirely
    run_cleanup(settings, get_storage(), now=utcnow() + timedelta(hours=settings.job_record_retention_hours + 1))
    with session_scope() as s:
        assert s.get(Job, dead.id) is None
    assert client.get(dead_url).status_code == 410  # still a friendly message, not an error


def test_cleanup_removes_orphans_and_overdue_files(settings):
    storage = get_storage()
    orphan = settings.local_storage_dir / f"{new_id()}.mp4"
    orphan.write_bytes(b"x")
    old = time.time() - 2 * 3600
    os.utime(orphan, (old, old))
    fresh_orphan = settings.local_storage_dir / f"{new_id()}.mp4"
    fresh_orphan.write_bytes(b"x")  # may be mid-hand-off; left alone for now
    partial = settings.local_storage_dir / f".{new_id()}.mp4.tmp"
    partial.write_bytes(b"x")
    os.utime(partial, (old, old))
    # A file whose DB row still says "complete" but is older than TTL + grace is deleted anyway.
    job = make_complete_job(settings)
    overdue = settings.local_storage_dir / job.storage_key
    very_old = time.time() - (settings.file_ttl_hours + 2) * 3600
    os.utime(overdue, (very_old, very_old))

    stats = run_cleanup(settings, storage)
    assert not orphan.exists() and not partial.exists() and not overdue.exists()
    assert fresh_orphan.exists()
    assert stats["orphans"] == 3


def test_cleanup_recovers_stale_jobs_and_workdirs(settings):
    jid = new_id()
    long_ago = utcnow() - timedelta(hours=2)
    with session_scope() as s:
        s.add(Job(id=jid, status=JobStatus.DOWNLOADING, platform="tiktok", source_url=TIKTOK,
                  session_hash="s", client_hash="c", created_at=long_ago, updated_at=long_ago))
    leftover = settings.work_dir / new_id()
    leftover.mkdir(parents=True)
    os.utime(leftover, (time.time() - 3 * 3600,) * 2)
    stats = run_cleanup(settings, get_storage())
    assert stats["stale"] == 1 and stats["workdirs"] == 1
    with session_scope() as s:
        assert s.get(Job, jid).error_code == "worker_lost"
    assert not leftover.exists()


def test_config_and_health(client):
    cfg = client.get("/api/config").json()
    ids = {p["id"] for p in cfg["platforms"]}
    assert {"tiktok", "instagram", "facebook", "youtube", "twitter"} <= ids
    assert client.get("/healthz").json() == {"ok": True}
