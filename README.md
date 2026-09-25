# tt-app — TikTok Spark Ads product-test automation

Automates the product-test workflow (TikTok post → Spark authorization →
CBO campaign → ad group → Spark ads with display cards). It uses the
**official TikTok for Business MCP server first**, the Marketing API second,
and browser automation only where neither can do a step. See
[`docs/capability-matrix.md`](docs/capability-matrix.md).

**Safety:** every write request is logged and *not sent* unless
`TT_WRITES_ENABLED=I_APPROVED_PUBLISHING`. Nothing is published before Phase 7
is approved. Only videos you own or are licensed to use are processed.

## Status

| Phase | Status |
|---|---|
| 1. Connect MCP + read Ads account | ✅ verified via the official TikTok MCP connector |
| 2. Pull advertisers, pixels, campaigns, display cards | ✅ see `docs/account-audit.md` |
| 3. Campaign creation (dry run) | ✅ `npm run plan -- --request examples/poncho-request.json` |
| 4. Spark creative handling + display-card generation | ✅ built (dry run); needs the upload token to go live |
| 5. Simple interface | — |
| 6. Full dry-run test | — |
| 7. Real publishing (after approval) | — |

## Setup

```bash
npm install
cp .env.example .env      # fill in values; never commit .env
npm run doctor            # shows exactly what's missing
```

### Option A: official MCP server (preferred)

```bash
npm run auth:mcp     # prints a URL; approve in your browser (lasts 30 days)
npm run verify:mcp   # saves the real tool catalog to logs/mcp-tools.json and reads your ad account
```

`auth:mcp` needs a browser on the same machine. Its callback listens on
`127.0.0.1:8765`, so run it locally, not in a remote container.

### Option B: Marketing API (fallback)

1. Create a developer app at business-api.tiktok.com/portal → My Apps and
   request the Ads Management, Audience, Reporting, Creative and Pixel scopes.
2. Put `TIKTOK_APP_ID` / `TIKTOK_APP_SECRET` in `.env`.
3. `npm run auth:api`: approve via the app's advertiser authorization URL, then paste the `auth_code`.
4. `npm run verify:api`: lists authorized ad accounts and saves them to `config/settings.json`.

## Campaign flow (Phase 3)

Your original Ads Manager flow, as an Upgraded Smart+ campaign: Sales → Website,
catalog campaign OFF, $50/day campaign budget, Maximum Delivery, the pixel you
pick, Add to Cart, TikTok placement only (Pangle, Global App Bundle, Lemon8 and
PineDrama off), start now, audiences automatic, no products, no catalog video
or image ads, no recommendations or enhancements, one Spark ad per post
(caption kept), and the exact-price display card.

`src/campaign/plan.ts` builds the payloads. `src/campaign/validate.ts` runs the
15 safety checks plus extra creative checks. `src/campaign/run.ts` creates
campaign → ad group → ads **live (ENABLE)** when PUBLISH is pressed; if a step
fails after the campaign exists, the campaign is paused automatically. Real
requests stay locked (dry run) until Phase 7.

## Creatives (Phase 4)

Flow per link: download → post through the linked TikTok account as a Spark
ad (Spark Ads Push) with the original caption → attach the price card.

- **Posting account:** @oliviaaagan, already linked to the ad account
  (`TT_USER`, can push videos, not ads-only). Uploaded videos also show on
  its profile (`dark_post_status: OFF`). No Spark codes are needed.
- **Download:** `downloadTikTok()` uses yt-dlp with ordinary requests and
  accepts only a non-watermarked format. It never impersonates a browser: it
  refuses to run if `curl_cffi` is installed. If TikTok blocks the request
  (as it does from cloud servers), it stops and asks for the original file.
  Every link must be marked `rightsConfirmed`.
- **Ad text:** always "Sale ends at midnight!" (`defaults.adText`), never the
  source video's caption. Override per campaign with `"adText"`.
- **Existing posts (Spark Ads Pull):** still supported via `tiktokItemIds`
  (e.g. @miaclairee_3 posts), and `authorizeSparkAd()` applies Spark codes.
- **Display cards:** generated from the product photo (landing page og:image)
  and the entered price at 750×421. See `examples/display-card-poncho-29.png`.
- **Uploads** need the Marketing API token (`npm run auth:api`). The MCP
  server can't send file bytes.

Example: `npm run plan -- --request examples/link-request.json`

## Files

- `config/settings.json` holds saved, non-secret setup: ad accounts, posting
  account (Spark identity), display-card library (product + price → card),
  landing-page domains, defaults ($50/day, Add to Cart, US, CTA portfolio)
  and the naming template. Pixels aren't saved: you pick one per campaign
  and it's re-checked live.
- `.secrets/` stores OAuth tokens (gitignored, chmod 600).
- `logs/YYYY-MM-DD.jsonl` records every API/MCP request and response in full,
  with secrets redacted.

## Development

```bash
npm run typecheck && npm test
```
