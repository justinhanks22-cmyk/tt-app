# Account audit — Relakia0423 (2026-09-25)

Read-only snapshot taken through the official TikTok MCP connector. Nothing was changed.

## Resources

- **Ad account:** Relakia0423 `7360920068810702864`, USD, America/New_York.
- **Spark posting identity:** `miaclairee_` (@miaclairee_3), `AUTH_CODE`, identity
  `7682104290172797966`. 51 authorized Spark posts, each authorized for one year.
- **Pixels:** 97. Created per product. Chosen per campaign and re-checked live.
  The Add to Cart event type is `ON_WEB_CART`.
- **Display cards:** 277 `CARD` portfolios. Each is an **image** (product photo +
  "$NN TODAY ONLY"). The API returns no text, so price/product must be recorded
  when a card is added, or the app must generate the card image itself.
- **Campaigns:** 13. Recent ones are all **Upgraded Smart+**
  (`campaign_automation_type = UPGRADED_SMART_PLUS`).

## Latest live campaign "poncho" vs. the stated rules

| Setting | Live value | Rule | Match |
|---|---|---|---|
| Campaign type | Upgraded Smart+ | (not stated) | — |
| Objective | `WEB_CONVERSIONS`, sales destination `WEBSITE` | Website conversions | ✅ |
| Budget | $50, `BUDGET_MODE_DYNAMIC_DAILY_BUDGET`, `budget_optimize_on: true` | $50/day CBO | ✅ |
| Bidding | `BID_TYPE_NO_BID` | Maximum Delivery | ✅ |
| Optimization | `CONVERT` / `ON_WEB_CART` | Add to Cart | ✅ |
| Pixel | `7689247033055625234` | Chosen per product | ✅ |
| Placements | `PLACEMENT_TYPE_NORMAL`, `["PLACEMENT_TIKTOK"]` | TikTok only | ✅ |
| Search results | `search_result_enabled: true` | TikTok only | ⚠️ ON |
| Campaign catalog | `catalog_enabled: false` | OFF | ✅ |
| Ad group product source | `product_source: CATALOG`, `catalog_id 7669433647123990288` | Product catalog OFF | ❌ ON |
| Ad product info | `product_info_enabled: CATALOG`, promo 75% off | Product attachment OFF | ❌ ON |
| Audience | `targeting_optimization_mode: AUTOMATIC`, `suggestion_audience_enabled: true` | Automation OFF | ⚠️ ON |
| Auto-add creatives | `creative_auto_add_toggle: false` | OFF | ✅ |
| Catalog creatives | `catalog_creative_toggle: false` | OFF | ✅ |
| Identity / post | `AUTH_CODE` `miaclairee_` / item `7689255287013903629` | Spark | ✅ |
| Display card | `interactive_add_on_list: [{card_id: 7689257131040721928}]` ($29 poncho card) | Matches price | ✅ |
| Ad text | `ad_text_list: []` (post caption shown) | "Sale ends at midnight!" | ⚠️ not set |
| Comments / downloads | `comment_disabled: true`, `video_download_disabled: true` | (not stated) | — |
| Landing page | `https://ashandbloom.store/products/sage-hooded-poncho` | Per product | ✅ |
