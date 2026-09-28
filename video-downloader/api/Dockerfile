# Video Downloader API + media worker (same image; the command decides which role it runs).
FROM denoland/deno:bin-2.5.6 AS deno

FROM python:3.12-slim-bookworm

# ffmpeg/ffprobe: merging, remuxing, conversion, metadata stripping.
# deno: JavaScript runtime yt-dlp uses for YouTube's player challenges (yt-dlp-ejs).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deno /deno /usr/local/bin/deno

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN useradd --system --uid 10001 --home-dir /data app \
 && mkdir -p /data/files /data/work \
 && chown -R app:app /data
USER app

ENV PYTHONUNBUFFERED=1 \
    DATABASE_URL=sqlite:////data/app.db \
    LOCAL_STORAGE_DIR=/data/files \
    WORK_DIR=/data/work \
    HOME=/data

VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).status == 200 else 1)"

ENTRYPOINT ["/usr/bin/tini", "--"]
# API server. For a standalone worker use:  python -m app.worker_main
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-server-header"]
