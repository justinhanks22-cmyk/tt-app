# Spark Test Launcher — hosted image.
# Code lives in /app; everything that must survive restarts (settings, TikTok
# tokens, logs, media) lives on a persistent volume mounted at /data.
FROM node:22-bookworm-slim

# python3 + yt-dlp: link downloads (ordinary requests only; curl_cffi is never installed)
# fonts-dejavu-core: text on generated display cards
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip fonts-dejavu-core ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

ENV HOST=0.0.0.0 \
    PORT=8080 \
    TT_SETTINGS_PATH=/data/config/settings.json \
    TT_SECRETS_DIR=/data/secrets \
    TT_LOG_DIR=/data/logs

# Media (downloads, cards, uploads) is written relative to the working directory.
WORKDIR /data
EXPOSE 8080
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["/app/node_modules/.bin/tsx", "/app/src/server/index.ts"]
