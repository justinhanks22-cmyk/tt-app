# Video Downloader

Paste the URL of a public social-media video. The app downloads the best available quality,
merges video and audio into one MP4 without re-encoding when possible, removes all file metadata,
gives the file a random name, and offers it through a signed download link. **Every file is
permanently deleted 24 hours after it is created.**

Only publicly accessible content is supported. The app does not bypass DRM, paywalls,
private accounts, login walls, geo-restrictions or bot checks. When a platform refuses a request,
the user sees a clear error. Only download videos you own or have permission to save.

```
Next.js (TypeScript + Tailwind)  ──/api proxy──▶  FastAPI  ◀── DB job queue ──▶  worker(s): yt-dlp + FFmpeg
          ▲                                          │                                 │
     Caddy (HTTPS, edge)                   SQLite / Postgres                 local disk / S3 / R2
```

---

## Contents

1. [Architecture](#architecture)
2. [Local development](#local-development)
3. [Docker](#docker)
4. [Deployment](#deployment)
5. [How the 24-hour deletion works](#how-the-24-hour-deletion-works)
6. [Where files are stored](#where-files-are-stored)
7. [Security](#security)
8. [Supported platforms and known limitations](#supported-platforms-and-known-limitations)
9. [Configuration reference](#configuration-reference)
10. [Tests](#tests)
11. [Third-party software and licences](#third-party-software-and-licences)

---

## Architecture

```
video-downloader/
├── api/                          Python 3.11+ — FastAPI service + media worker (one image, two roles)
│   ├── app/
│   │   ├── main.py               FastAPI app; optionally runs the worker in-process
│   │   ├── worker_main.py        standalone worker process (python -m app.worker_main)
│   │   ├── cleanup.py            expiry + garbage collection (also: python -m app.cleanup)
│   │   ├── config.py             all settings (env vars / .env)
│   │   ├── models.py             `jobs` table (job + file record)
│   │   ├── platforms.py          supported platforms: domains + allowed yt-dlp extractors
│   │   ├── url_validation.py     URL normalisation, allow-list, SSRF checks
│   │   ├── errors.py             user-facing error codes, yt-dlp error classification
│   │   ├── signing.py            HMAC-signed download links
│   │   ├── api/routes.py         HTTP endpoints, rate limits, quotas
│   │   ├── jobs/runner.py        DB-backed queue: atomic claim, worker threads, cleanup loop
│   │   ├── jobs/processor.py     pipeline: locate → download → process → prepare → complete
│   │   ├── media/ytdlp.py        yt-dlp subprocess wrapper (format selection, progress, limits)
│   │   ├── media/ffmpeg.py       probe, copy-vs-encode plan, export + metadata stripping, validation
│   │   ├── media/proc.py         safe subprocess runner (argv arrays, timeouts, process-group kill)
│   │   └── storage/              local filesystem and S3-compatible backends
│   ├── tests/                    pytest suite (offline; stub yt-dlp + real FFmpeg)
│   └── Dockerfile
├── web/                          Next.js 16 (App Router), TypeScript, Tailwind CSS 4
│   ├── app/page.tsx              home: URL input → live stages → result card
│   ├── app/history/page.tsx      "My videos" for this browser session
│   ├── app/api/[...path]/route.ts  same-origin proxy to the API (allow-listed routes only)
│   ├── components/               Downloader, StageList, ResultCard, Countdown, History, Nav
│   ├── lib/                      API client, formatting helpers
│   └── Dockerfile
├── docker-compose.yml            Caddy + web + api + worker + Postgres
├── Caddyfile                     edge proxy / automatic HTTPS
├── .env.example
└── Makefile
```

### Request flow

1. **Browser → Next.js.** The user pastes a URL and the page calls `POST /api/jobs`. Next.js
   forwards only allow-listed API routes to the FastAPI service over the private network,
   together with the client IP and a shared proxy token.
2. **API.** It validates and normalises the URL (scheme, allow-listed domain, DNS resolves only
   to public IPs, tracking parameters removed) and detects the platform. It enforces rate limits,
   quotas and free-disk checks, then inserts a `queued` job and returns `202` right away. The
   browser never waits on one long request.
3. **Worker.** It claims the job with an atomic `UPDATE … WHERE status='queued'`, so any number
   of worker processes on any number of machines can share the queue safely. It then runs:

   | status | UI stage | what happens |
   |---|---|---|
   | `queued` | Finding video (waiting in queue) | waiting for a free worker thread |
   | `locating` | Finding video | `yt-dlp --dump-single-json`: metadata + chosen formats. Checks the extractor matches the platform, not live, not DRM, duration and estimated size within limits |
   | `downloading` | Downloading (with %) | `yt-dlp --load-info-json`: best video + best audio, merged losslessly into MKV; byte-level size watchdog |
   | `processing` | Processing | FFmpeg: stream-copy into MP4 (re-encode only when needed), strip all metadata, `+faststart` |
   | `preparing` | Preparing download | validate output (real MP4, has video, within limits, no leftover tags), random filename, move/upload to storage |
   | `complete` | Your video is ready | expiry = completion + 24 h |
   | `expired` | — | file deleted by cleanup; row scrubbed, then purged |
   | `failed` | error card | useful error code + message (see below) |

4. **Browser.** The page polls `GET /api/jobs/{id}` every second, then shows the result card
   with the resolution, size, duration, **Download MP4** button and a countdown. The
   download link is `/api/download/{file_id}?exp=…&sig=…`, HMAC-signed and valid only until
   expiry. It never contains a path.

### Quality and format choices

* Format selection: `-f "bv*+ba/b" -S "res,fps,+vcodec:avc,+acodec:m4a"`. Highest resolution
  and frame rate always win. At equal resolution/fps, H.264 + AAC are preferred because they go
  into MP4 without re-encoding and play everywhere.
* Export (FFmpeg): `-map_metadata -1 -map_chapters -1 -fflags +bitexact …`, with `-c copy`
  wherever the codec allows it.
  * **`VIDEO_COMPAT=modern`** (default): H.264, HEVC (tagged `hvc1` for Apple), VP9 and AV1 video
    are copied untouched. Anything else (e.g. MPEG-4 Part 2, VP8) is re-encoded to H.264 at CRF 18.
  * **`VIDEO_COMPAT=h264`**: guarantees H.264 8-bit 4:2:0 for maximum compatibility with old
    devices. This re-encodes VP9/AV1/HEVC sources, which costs CPU and some quality.
  * Audio: AAC/MP3 are copied. Opus/Vorbis/FLAC/AC-3 are converted to AAC 192 kbps (small
    cost, big compatibility gain on iOS/Safari).
  * Resolution, frame rate and rotation are never changed.
* Metadata removed: global tags (title, artist, comment/description, date, creation time,
  source URL, encoder), per-stream tags, chapters, subtitle and data tracks. When re-encoding,
  the MP4 compressor name and the x264 SEI version banner are also removed. What remains is
  only what the MP4 format itself requires (`major_brand`, `compatible_brands`, generic
  `VideoHandler`/`SoundHandler`, language `und`). The pipeline refuses to publish a file that
  still has extra container tags.

### Scaling and separating the worker

The worker is just another process using the same database and storage:

* **Development:** `RUN_EMBEDDED_WORKER=true`, so the API process also runs worker threads and cleanup.
* **Production:** `RUN_EMBEDDED_WORKER=false` on the API, plus one or more
  `python -m app.worker_main` processes (the `worker` service in Compose). Scale with
  `docker compose up -d --scale worker=3`, or run workers on other machines pointing at the
  same Postgres and S3/R2 bucket. No broker is needed. If you outgrow the DB-backed queue,
  `jobs/runner.py` is the only file that knows about claiming work.

---

## Local development

Requirements: **Python 3.11+**, **Node.js 20.9+** (22 recommended), **FFmpeg** (with ffprobe),
and optionally **Deno** or Node for YouTube's JavaScript challenges (`YTDLP_JS_RUNTIME=auto`
uses deno if installed, otherwise node).

```bash
# 0. system packages (examples)
sudo apt-get install -y ffmpeg          # Debian/Ubuntu
brew install ffmpeg                     # macOS

cd video-downloader
cp .env.example .env                    # defaults work for local dev (SQLite + ./api/data)

# 1. API + embedded worker  →  http://127.0.0.1:8000
cd api
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 8000

# 2. Web app (second terminal)  →  http://localhost:3000
cd video-downloader/web
npm ci
npm run dev
```

Open <http://localhost:3000>. The web app proxies `/api/*` to `API_INTERNAL_URL`
(default `http://127.0.0.1:8000`). Local data lives in `api/data/` (`app.db`, `files/`, `work/`).

Useful commands:

```bash
cd api && python3 -m pytest              # backend tests (offline, ~5 s)
cd api && python3 -m app.cleanup         # run one cleanup pass now
cd api && python3 -m app.worker_main     # separate worker (set RUN_EMBEDDED_WORKER=false for the API)
cd web && npm run typecheck && npm run build
```

`make install`, `make dev-api`, `make dev-web` and `make test` wrap the same commands.

Keep yt-dlp current, because platforms change often and fixes ship frequently:
`pip install -U "yt-dlp[default]"` (or rebuild the Docker image).

---

## Docker

```bash
cd video-downloader
cp .env.example .env
# edit .env: set SECRET_KEY, INTERNAL_PROXY_TOKEN, POSTGRES_PASSWORD, e.g.
#   sed -i "s/^SECRET_KEY=.*/SECRET_KEY=$(openssl rand -hex 32)/" .env
#   sed -i "s/^INTERNAL_PROXY_TOKEN=.*/INTERNAL_PROXY_TOKEN=$(openssl rand -hex 32)/" .env
#   sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 16)/" .env
docker compose up -d --build
open http://localhost:8080               # or visit it in your browser
docker compose logs -f worker            # watch jobs being processed
docker compose up -d --scale worker=3    # more parallel processing
docker compose down                      # stop (add -v to also delete volumes/data)
```

Services: `caddy` (only published service; ports `HTTP_PORT`/`HTTPS_PORT`), `web`
(Next.js standalone), `api` (FastAPI), `worker` (same image, `python -m app.worker_main`),
`db` (Postgres 16). Files go to the `media` volume, or to S3/R2 if `STORAGE_BACKEND=s3`.
The API is not exposed outside the Compose network.

---

## Deployment

**Don't run the media worker on serverless functions (e.g. Vercel/Netlify functions).**
Downloads and FFmpeg runs routinely exceed serverless execution time, memory and `/tmp` disk
limits, and yt-dlp needs a persistent binary environment. Use a VPS or container host.

### Recommended: one VPS with Docker Compose

Works on any VM with 2+ vCPU, 2–4 GB RAM and enough disk for `STORAGE_QUOTA_GB` plus working space.

```bash
# on the server
git clone <your repo> && cd <repo>/video-downloader
cp .env.example .env
#  set: SECRET_KEY, INTERNAL_PROXY_TOKEN, POSTGRES_PASSWORD (random values, see above)
#       ENVIRONMENT=production, COOKIE_SECURE=true
#       SITE_ADDRESS=dl.example.com   HTTP_PORT=80   HTTPS_PORT=443
#  optional S3/R2: STORAGE_BACKEND=s3 and the S3_* values
docker compose up -d --build
```

Point the domain's DNS A/AAAA record at the server. Caddy obtains and renews HTTPS certificates
automatically. To update, run `git pull && docker compose up -d --build`. Rebuilding also
upgrades yt-dlp.

### Cloudflare R2 / AWS S3 (recommended for production storage)

```dotenv
STORAGE_BACKEND=s3
S3_BUCKET=video-downloader
S3_ENDPOINT_URL=https://<account-id>.r2.cloudflarestorage.com   # empty for AWS S3
S3_REGION=auto                                                  # AWS: e.g. us-east-1
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

The bucket must stay **private**: downloads use short-lived presigned URLs. As a second safety
net, add a lifecycle rule that deletes objects under `videos/` after **2 days** (R2: *Settings →
Object lifecycle rules*; S3: *Management → Lifecycle rules*).

### Split deployments

* **Web on Vercel, backend on a VPS:** the Next.js app works on Vercel because its proxy
  route only streams small JSON and downloads. Set `API_INTERNAL_URL=https://api.example.com`,
  `INTERNAL_PROXY_TOKEN`, and `TRUSTED_PROXY_HOPS=1`. With S3/R2 storage, downloads redirect
  straight to the bucket. Run `api` + `worker` + Postgres on the VPS behind HTTPS.
* **Managed Postgres** (Neon, Supabase, RDS…): set `DATABASE_URL=postgresql://…` on the api
  and worker, and drop the `db` service.
* **More workers:** start more `worker` containers anywhere with the same `DATABASE_URL`,
  S3 settings and `SECRET_KEY`.

### Production checklist

- [ ] `SECRET_KEY`, `INTERNAL_PROXY_TOKEN`, `POSTGRES_PASSWORD` are long random values
- [ ] `ENVIRONMENT=production` (refuses to start with the default secret), `COOKIE_SECURE=true`
- [ ] Next.js is only reachable through the reverse proxy (it trusts `X-Forwarded-For` from it)
- [ ] Private bucket + lifecycle rule (if using S3/R2)
- [ ] Egress firewall on worker hosts blocking private ranges (defence in depth for SSRF)
- [ ] Disk alerts; limits (`MAX_FILE_SIZE_MB`, `STORAGE_QUOTA_GB`, rate limits) sized for your server
- [ ] Rebuild regularly so yt-dlp stays current

---

## How the 24-hour deletion works

Deletion never depends on the browser. The countdown in the UI is display-only. Five layers:

1. **Expiry is stored server-side.** On completion the job row gets `expires_at = completed_at + FILE_TTL_HOURS`.
2. **Hard stop at the door.** The download endpoint refuses to serve a file once `expires_at`
   has passed, even if cleanup hasn't run yet. The signed link also carries the expiry time in
   its signature, so an expired link shows a friendly **"This download has expired"** page
   (HTTP 410), never an error page, even after the database row is gone. The job API stops
   offering the link at the same moment.
3. **Scheduled cleanup** (`app/cleanup.py`) runs in every worker process at startup and every
   `CLEANUP_INTERVAL_SECONDS` (default 5 min). You can also run it from cron or a Kubernetes
   CronJob with `python -m app.cleanup`. Each pass:
   * **expire_files:** deletes each due file from storage *first*, then marks the job `expired`
     and scrubs `storage_key`, `filename` and `source_url` from the row. If the storage delete
     fails, the row stays `complete` and is retried next pass.
   * **purge_records:** deletes `expired`/`failed` rows entirely after `JOB_RECORD_RETENTION_HOURS`
     (default 24 h, kept so "My videos" can show "Expired"). Set it to `0` to delete rows at expiry.
   * **recover_stale_jobs:** fails jobs whose worker died mid-way, and jobs stuck in the queue for over an hour.
   * **sweep_orphans:** deletes any stored object no live job references (after a 1 h grace
     period), **and any object older than TTL + 1 h regardless of what the database says**.
     This backstop guarantees files can't outlive their TTL through a crash between upload and
     DB update, a restored backup, or a bug. It also removes half-written temp files.
   * **sweep_workdirs:** removes temp download directories left by crashed workers. Normally
     each job's temp directory is deleted in a `finally` block the moment the job ends, success or failure.
4. All steps are idempotent, so several workers can run cleanup concurrently.
5. With S3/R2, the bucket lifecycle rule (see above) is a final safety net outside the app.

Since cleanup runs every 5 minutes, a file is physically deleted at most ~5 minutes after its
24 h mark (and is unreachable from exactly the 24 h mark).

---

## Where files are stored

| What | Local backend (dev / single VPS) | S3 backend (production) |
|---|---|---|
| Finished MP4s | `LOCAL_STORAGE_DIR` (default `api/data/files/`; `/data/files` in Docker, on the `media` volume), named `<file_id>.mp4`, mode `0600` | `s3://$S3_BUCKET/videos/<file_id>.mp4` (private) |
| Temporary downloads | `WORK_DIR/<job_id>/` (default `api/data/work/`), deleted when the job ends | same (always local disk on the worker) |
| Job/file records | SQLite `api/data/app.db` | Postgres (`DATABASE_URL`) |

The user-facing filename (e.g. `8f2d7c41-a83e-4d7c.mp4`) is random and unrelated to the storage
key, and both are generated server-side. The source title/uploader is never used. Download
URLs contain only the random 128-bit file id, the expiry and an HMAC signature. With local
storage the API streams the file (with Range support) and a `Content-Disposition: attachment`
header. With S3 it redirects to a presigned URL that is valid for at most 1 h and never beyond the file's expiry.

**What's stored per job:** job/file id, generated filename, platform, created/completed/expiry
timestamps, storage key, size, resolution, duration, codecs, status, error. The source URL is
kept only until expiry. The client IP and browser-session cookie are stored only as
keyed HMAC hashes (used for rate limiting and "My videos").

---

## Security

| Threat | Mitigation |
|---|---|
| **SSRF / arbitrary proxy** | Only `https://` (optionally `http://`) URLs on allow-listed platform domains; no IP literals, credentials or non-default ports; every DNS answer must be a public address (checked at submit time *and* again before processing). yt-dlp runs with the **generic extractor disabled**, and the resolved extractor must belong to the requested platform. The download step replays the vetted info JSON instead of re-resolving the URL. The API isn't publicly exposed, and the Next.js proxy forwards only 6 fixed routes. |
| **Command injection** | yt-dlp/FFmpeg are spawned with argument arrays (`shell=False`), the URL goes after `--`, and control characters/whitespace are rejected. `--ignore-config` and `--no-plugin-dirs` prevent config/plugin injection. |
| **Path traversal / malicious filenames** | All ids are server-generated hex. Storage keys must match `^…[0-9a-f]{32}\.mp4$` and resolve inside the storage root. Source titles are never used in names. |
| **Disk exhaustion** | `MAX_FILE_SIZE_MB` checked on the estimate before download, via yt-dlp `--max-filesize`, by a byte-counting watchdog that kills the download, and on the final file. Also `MAX_DURATION_SECONDS`, a `STORAGE_QUOTA_GB` total quota, a free-disk check, and a max queue length. |
| **Runaway jobs** | `PROCESSING_TIMEOUT_SECONDS` overall deadline, per-step timeouts, whole process-group kill. |
| **Abuse / flooding** | Per-IP limits: `RATE_LIMIT_ACTIVE_JOBS` concurrent and `RATE_LIMIT_JOBS_PER_HOUR` (database-backed, so they hold across instances), plus `RATE_LIMIT_REQUESTS_PER_MINUTE`. The client IP comes from the edge proxy (Caddy overwrites `X-Forwarded-For`) and is trusted by the API only with the shared `INTERNAL_PROXY_TOKEN`. |
| **Unguessable links** | 128-bit random file ids + HMAC-SHA256 signature over id and expiry. No directory listing, and physical paths are never exposed. |
| **File-type validation** | Output must start with an `ftyp` box, probe as MP4 with a video stream, be within the size limit, and carry no leftover metadata. |
| **Misc.** | `HttpOnly` / `SameSite=Lax` session cookie (`Secure` in prod), JSON-only POST (no CSRF via forms), `nosniff`, `no-referrer`, `DENY` framing, `noindex`, non-root containers. |

---

## Supported platforms and known limitations

| Platform | Accepted URLs | Notes |
|---|---|---|
| TikTok | `tiktok.com`, `vm.tiktok.com`, `vt.tiktok.com` | Public videos. Photo/slideshow posts have no video. |
| Instagram Reels / posts | `instagram.com`, `instagr.am` | Public posts only. Instagram often requires login even for public content from server IPs; that shows as "private or requires signing in". Stories are login-only. |
| Facebook | `facebook.com`, `fb.watch`, `fb.com` | Public videos/Reels only; many are login-gated. |
| YouTube + Shorts | `youtube.com`, `youtu.be`, `/shorts/` (labelled "YouTube Shorts") | Needs a JS runtime (deno/node). Members-only, private and age-restricted videos are refused. |
| X / Twitter | `x.com`, `twitter.com` | Public posts. Posts with several videos: the first video is used. |
| Other (toggle `ENABLE_OTHER_PLATFORMS`) | Reddit, Vimeo, Dailymotion, Twitch (clips/VODs), Streamable, Bluesky, Internet Archive | Anything yt-dlp has a dedicated extractor for can be added in `app/platforms.py` or via `EXTRA_ALLOWED_DOMAINS`. |

**Refused on purpose:** DRM-protected media, private/login-only/members-only content,
geo-blocked content, bot-check/CAPTCHA walls, live streams, playlists/channels/profiles (link a
single video), and arbitrary websites or direct file URLs (the generic extractor is disabled to
prevent SSRF/proxy abuse).

**Known limitations**

* **Datacenter IPs get blocked.** YouTube, TikTok, Instagram and Facebook increasingly refuse
  cloud/VPS IP ranges with bot checks, `403`s or login prompts. The app reports these as
  "The platform refused this server's request" or "requires signing in" and does not try to
  get around them (no cookies, PO tokens, proxies or CAPTCHA solving). Results depend heavily
  on where you host it. A residential or less-flagged VPS IP works much better.
* **Platforms change constantly.** Keep yt-dlp updated. Most "extraction failed" errors are
  fixed by a yt-dlp upgrade.
* In `modern` mode, very old devices may not play VP9/AV1 (used for YouTube 1440p/4K). Use
  `VIDEO_COMPAT=h264` if that matters more than CPU time and exact quality.
* "My videos" is tied to a browser-session cookie. It is lost when the browser session ends
  (no accounts in the MVP).
* The per-minute request limiter is in-memory per API instance (the job-creation limits are global).
* The database schema is created automatically. Adopt Alembic migrations before changing it in production.

**What was verified while building (from a cloud sandbox):** full end-to-end runs (UI → queue
→ yt-dlp → FFmpeg → storage → signed download) with **Reddit** (separate video+audio DASH
streams, merged by stream copy) and the **Internet Archive** (720p, 10-minute, 206 MB
file). Both ran locally (SQLite + embedded worker) and in the Docker Compose stack (Caddy +
Postgres + separate worker). The S3 backend was verified against an S3-compatible server. From
that sandbox's datacenter IP, **YouTube** returned metadata but refused the media stream (`403`,
sometimes "confirm you're not a bot"), and **TikTok** returned bot-protection responses. The
app correctly reported both as errors. Instagram, Facebook and X were not reachable for a
successful public download from that IP either, so test all five from your own deployment.

---

## Configuration reference

All settings are environment variables (see [`.env.example`](.env.example) for every option
with comments). The most important:

| Variable | Default | Purpose |
|---|---|---|
| `SECRET_KEY` | *(insecure dev value)* | Signs download links, keys IP/session hashes. **Required in production.** |
| `INTERNAL_PROXY_TOKEN` | – | Shared secret web → API so the API trusts the forwarded client IP |
| `DATABASE_URL` | `sqlite:///./data/app.db` | `postgresql://…` in production |
| `STORAGE_BACKEND` | `local` | `local` or `s3` |
| `FILE_TTL_HOURS` | `24` | File lifetime |
| `MAX_FILE_SIZE_MB` / `MAX_DURATION_SECONDS` | `1024` / `10800` | Per-file limits |
| `PROCESSING_TIMEOUT_SECONDS` | `900` | Whole-job deadline |
| `RATE_LIMIT_JOBS_PER_HOUR` / `RATE_LIMIT_ACTIVE_JOBS` | `20` / `3` | Per client IP |
| `VIDEO_COMPAT` | `modern` | `modern` (max quality, copy VP9/AV1/HEVC) or `h264` (max compatibility) |
| `RUN_EMBEDDED_WORKER` | `true` | Run worker threads inside the API process |
| `WORKER_CONCURRENCY` | `2` | Parallel jobs per worker process |
| `TRUSTED_PROXY_HOPS` (web) | `1` | Reverse proxies in front of Next.js |

---

## Tests

```bash
cd api && python3 -m pytest
```

92 tests, fully offline (DNS stubbed; a fake yt-dlp script replays metadata and media; real
FFmpeg). They cover URL validation and SSRF (private/reserved IPs, DNS rebinding to private
addresses, credentials, ports, look-alike domains, injection attempts), yt-dlp error
classification, signed links (tampering, expiry), the full pipeline incl. failure modes
(private, generic extractor, live, too large, timeout), FFmpeg copy/convert decisions and
metadata stripping (checked at the byte level), rate limits and quotas, downloads (headers,
traversal, expired-link page), and every cleanup step.

```bash
cd web && npm run typecheck && npm run build
```

---

## Third-party software and licences

Checked against each project's current documentation and licence at the time of writing:

| Component | Licence | Use |
|---|---|---|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) (+ yt-dlp-ejs) | Unlicense (PyPI wheel) | extraction/download, run as a subprocess |
| [FFmpeg](https://ffmpeg.org/legal.html) | LGPL 2.1+ / GPL depending on build (Debian's build is GPL) | merging, remuxing, conversion, metadata stripping; invoked as a separate program, not linked |
| [Deno](https://github.com/denoland/deno) | MIT | JS runtime for yt-dlp's YouTube challenge solver |
| FastAPI, Starlette, Pydantic, SQLAlchemy, Uvicorn | MIT / BSD | API |
| psycopg 3 | LGPL 3 | Postgres driver (unmodified dependency) |
| boto3 | Apache 2.0 | S3-compatible storage |
| Next.js, React, Tailwind CSS | MIT | frontend |
| TypeScript | Apache 2.0 | build |
| Caddy | Apache 2.0 | edge proxy / HTTPS |

Using this software doesn't grant any rights to the content you download. Respect each
platform's terms of service and creators' copyrights.
