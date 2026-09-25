# Running it in the cloud

The app runs as one small web service with a persistent disk. You use it from
any browser (phone included) at your own https address, behind a password.

## What changes when hosted

| | On your computer | Hosted |
|---|---|---|
| Open it at | http://localhost:5177 | your `PUBLIC_URL` |
| Login | none | `APP_PASSWORD` required on every page |
| TikTok connection | `npm run auth:mcp` | **Connect TikTok** button on the page |
| Uploading videos/cards | Marketing API token (developer app) | Signed 1-hour links TikTok fetches — **no developer app needed** |
| Downloading from links | usually works | **TikTok blocks cloud servers** → attach the video file on the page (works from your phone) |

The app refuses to start publicly without `APP_PASSWORD` (12+ characters) and
an `https://` `PUBLIC_URL`.

## Deploy on Render (blueprint included)

1. Push this repo to GitHub (already done).
2. In Render: **New → Blueprint**, pick this repo/branch. It reads `render.yaml`:
   one Docker web service plus a 5 GB disk at `/data`.
3. Set the two secret values when asked:
   - `APP_PASSWORD`: a long password you'll type to sign in.
   - `PUBLIC_URL`: the service's address, e.g. `https://spark-test-launcher.onrender.com`.
     (Create first, then fill in the address Render shows and redeploy.)
4. Open the address, sign in, press **Connect TikTok**, and approve.

Any host that runs a Dockerfile with a persistent volume works the same way
(Railway, Fly.io, a VPS): mount a volume at `/data` and set `APP_PASSWORD` and
`PUBLIC_URL`. `SESSION_SECRET` is optional (one is generated and stored in
`/data/secrets`).

## What lives on the disk (`/data`)

- `config/settings.json`: your saved setup (seeded from the repo on first start)
- `secrets/`: TikTok tokens and the server signing key (never in the repo)
- `logs/`: every TikTok request and response, secrets redacted
- `media/`: downloaded/attached videos, covers, generated display cards

## Publishing

Hosted or not, real requests are only sent once `TT_WRITES_ENABLED=I_APPROVED_PUBLISHING`
is set (Phase 7). Until then the badge says DRY RUN and PUBLISH records the
requests without sending them.
