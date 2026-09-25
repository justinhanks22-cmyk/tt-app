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
| 1. Connect MCP + read Ads account | Code done. Waiting on credentials and network access |
| 2. Pull advertisers, pixels, campaigns, display cards | next |
| 3. Campaign creation (dry run) | — |
| 4. Spark creative handling | — |
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

## Files

- `config/settings.json` holds saved, non-secret setup: ad accounts, posting
  accounts, account → pixel mapping, display-card library, landing-page
  domains, defaults ($50/day, Add to Cart, "Sale ends at midnight!") and the
  naming template.
- `.secrets/` stores OAuth tokens (gitignored, chmod 600).
- `logs/YYYY-MM-DD.jsonl` records every API/MCP request and response in full,
  with secrets redacted.

## Development

```bash
npm run typecheck && npm test
```
