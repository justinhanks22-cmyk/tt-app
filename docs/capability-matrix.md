# Capability matrix

Order of preference for every step: **TikTok MCP → Marketing API → browser automation**.

**Sources and status** (as of 2026-09-25):
- **SDK-verified**: the endpoint or field appears in TikTok's official Business API SDK
  (`github.com/tiktok/tiktok-business-api-sdk`), which is generated from the
  same spec as the portal docs. Enum *values* still need a check against the
  live docs before the first real request.
- **Unverified**: known from secondary sources only. Must be confirmed at
  `business-api.tiktok.com/portal/docs` before implementing. Those docs were
  unreachable from the build environment (egress blocked).
- **MCP column**: the official MCP server wraps about 400 API for Business
  endpoints as tools. Tool *names* are unknown until `npm run verify:mcp` saves
  the real catalog to `logs/mcp-tools.json`. After that, this column gets
  exact tool names.

| # | Workflow step | MCP support | API support | Browser automation required? | Plan |
|---|---|---|---|---|---|
| 1 | Import highest-quality video from a TikTok URL | Not expected (Ads MCP is advertising-scoped) | **None.** No Marketing API endpoint downloads arbitrary TikTok posts | Scraping/downloading TikTok pages would bypass TikTok controls, so it **won't be built** | You provide the original source file (the true highest quality) plus a rights attestation per creative. The URL is recorded as provenance. If the video is *already* on your posting account, skip re-posting and Spark-authorize the existing post directly |
| 2 | Prepare for reposting | n/a | n/a | No | Local `ffprobe` checks (resolution, aspect, duration, codec, size) against TikTok upload specs |
| 3 | Post video to your TikTok account | Check the catalog (likely none) | Unverified: TikTok **Accounts API** (API for Business, e.g. `business/video/publish`) for Business accounts, or the separate **Content Posting API** (`open.tiktokapis.com`, needs its own developer app with audited `video.publish` scope) | Only if neither API is available to you: TikTok Studio upload via Playwright (semantic selectors, never coordinates) | Decide after Phase 2 confirms which API your accounts qualify for |
| 4 | Turn on the post's ad authorization / generate the Spark code | Check the catalog | Unverified whether any posting API exposes the "ad authorization" toggle | Likely. It's a per-post setting in the TikTok app/Studio | Semi-manual or Studio automation. The app stops that creative and tells you exactly what to do if authorization is missing |
| 5 | Get the Spark identity/video for Ads Manager | Check the catalog | SDK-verified: `GET /identity/get/` (identity types `AUTH_CODE`, `TT_USER`, `BC_AUTH_TT`, `CUSTOMIZED_USER`) and `GET /identity/video/info/` (`identity_type`, `identity_id`, `item_id`). Unverified (not in SDK): `/tt_video/authorize/` and `/tt_video/info/` for applying a post auth code | No | Prefer `TT_USER`/`BC_AUTH_TT` identity (account linked once), which avoids per-video codes. Fall back to per-post auth codes |
| 6 | Link the Spark creative to the product test | Check the catalog | SDK-verified `POST /ad/create/` creative fields: `identity_type`, `identity_id`, `identity_authorized_bc_id`, `tiktok_item_id`, `ad_text`, `landing_page_url`, `call_to_action`, `card_id`, `promotional_music_disabled`, `creative_authorized` | No | Phase 4 |
| 7 | Create campaign (CBO, $50/day, catalog off) | Check the catalog | SDK-verified `POST /campaign/create/`: `objective_type`, `budget_optimize_on`, `budget_mode`, `budget`, `catalog_enabled`, `operation_status`, `campaign_name` | No | Phase 3 (dry run) |
| 8 | Create ad group (TikTok-only placement, pixel, ATC, max delivery) | Check the catalog | SDK-verified `POST /adgroup/create/`: `placement_type`, `placements`, `tiktok_subplacements`, `search_result_enabled`, `pixel_id`, `optimization_goal`, `optimization_event`, `billing_event`, `bid_type`, `pacing`, `promotion_type`, `schedule_type`, `schedule_start_time`, `creative_material_mode`, `smart_audience_enabled`, `shopping_ads_type`, `product_source` | No | Phase 3. Enum values (e.g. placement and event names) must be checked against live docs |
| 9 | Display-card library | Check the catalog | SDK-verified `GET /creative/portfolio/list/` (filter `creative_portfolio_types`, which includes `CARD`) and `GET /creative/portfolio/get/`. `ad/create` takes `card_id` | No | Phase 2 imports your existing cards into `config/settings.json` with exact label → price mapping |
| 10 | Pixels | Check the catalog | SDK-verified `GET /pixel/list/` | No | Phase 2 |
| 11 | Advertiser accounts | Check the catalog | SDK-verified `GET /oauth2/advertiser/get/`, `GET /advertiser/info/` | No | **Phase 1: implemented** |
| 12 | Optional AI/automation features OFF | Check the catalog | Partly: `creative_material_mode` (ad group), `promotional_music_disabled`, `aigc_disclosure_type` (ad). Other "enhancement" toggles are unverified. Some may exist only in Ads Manager UI or at the account level | Possibly, for toggles with no API field | Verify each toggle in Phase 3. The review screen shows every one as ON/OFF/"not controllable via API" |
| 13 | Validate before publish | n/a | Read-back via SDK-verified `campaign/get`, `adgroup/get`, `ad/get` | No | Phase 3–6 |
| 14 | Publish | Check the catalog | Create with `operation_status` = `DISABLE`, then enable via `campaign/status/update` (SDK-verified path) | No | Phase 7 only, after your approval |
| 15 | Status / review results | Check the catalog | SDK-verified `campaign/get`, `adgroup/get`, `ad/get`, and reporting | No | Phase 7 |

## Open questions to resolve against the live docs

1. Exact enum values: `objective_type` for a website-conversion campaign,
   `optimization_goal`/`optimization_event` for Add to Cart,
   `placement_type` = `PLACEMENT_TYPE_NORMAL` with `placements` = TikTok only,
   and how Lemon8 / Pangle / Global App Bundle appear.
2. Whether "Maximum Delivery" maps to `bid_type` `BID_TYPE_NO_BID`.
3. Whether a display card is portfolio type `CARD` and how its label/price text is returned.
4. Which "smart creative / enhancement" toggles the API exposes.
