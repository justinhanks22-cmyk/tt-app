import type { Settings } from "../config/schema.js";
import type { IngestedVideo } from "../creative/ingest.js";

/** What the user enters for one product test. */
export interface CampaignRequest {
  advertiserId: string;
  productName: string;
  price: number;
  pixelId: string;
  landingPageUrl: string;
  /** Posting identity label from settings.postingAccounts (default: first). */
  postingAccount?: string;
  /** Spark Ads Pull: existing posts already authorized to the ad account. */
  tiktokItemIds: string[];
  /** Spark Ads Push: videos uploaded through the linked TikTok account. */
  uploads?: IngestedVideo[];
  dailyBudget?: number;
  /** Overrides settings.defaults.adText for this campaign. */
  adText?: string;
}

export type SparkCreative =
  | { kind: "post"; tiktokItemId: string; identityType: string; identityId: string }
  | { kind: "upload"; video: IngestedVideo; identityType: string; identityId: string };

/** IDs TikTok returns for an uploaded video and its cover, keyed by video sha256. */
export type UploadedAssets = Record<string, { videoId: string; coverImageId: string }>;

export const creativeKey = (c: SparkCreative) => (c.kind === "post" ? c.tiktokItemId : c.video.sha256);

/** Everything needed to create the campaign, fully resolved. */
export interface CampaignPlan {
  request: CampaignRequest;
  names: { campaign: string; adGroup: string; ads: string[] };
  budget: number;
  identity: { label: string; identityType: string; identityId: string };
  creatives: SparkCreative[];
  /** An existing card (cardId) or one the app will generate (`generate`). */
  displayCard: { cardId?: string; label: string; generate?: { pngPath: string } };
  settings: Settings["defaults"];
  scheduleStartTime: string; // UTC "YYYY-MM-DD HH:MM:SS"
  adText: string;
}

export class PlanError extends Error {}

function formatDate(date: Date, format: string, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return format.replace("yyyy", parts.year!).replace("MM", parts.month!).replace("dd", parts.day!);
}

function formatPrice(price: number): string {
  return Number.isInteger(price) ? String(price) : price.toFixed(2);
}

export function renderName(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => vars[key] ?? m);
}

export function buildNames(settings: Settings, req: CampaignRequest, now: Date) {
  const n = settings.naming;
  const vars = {
    product: req.productName.trim(),
    price: formatPrice(req.price),
    event: n.eventAbbreviations[settings.defaults.optimizationEvent] ?? settings.defaults.optimizationEvent,
    date: formatDate(now, n.dateFormat, n.timezone),
  };
  return {
    campaign: renderName(n.campaignTemplate, vars),
    adGroup: renderName(n.adGroupTemplate, vars),
    ads: [...req.tiktokItemIds, ...(req.uploads ?? [])].map((_, i) => renderName(n.adTemplate, { ...vars, n: String(i + 1) })),
  };
}

/**
 * The display card whose recorded price exactly equals the product price,
 * for this product and ad account. Never substitutes another offer: no exact
 * match (or more than one) is an error.
 */
export function selectDisplayCard(settings: Settings, advertiserId: string, productName: string, price: number): { cardId: string; label: string } {
  const product = productName.trim().toLowerCase();
  const matches = settings.displayCards.filter(
    (c) => c.advertiserId === advertiserId && c.price === price && c.product?.trim().toLowerCase() === product,
  );
  if (matches.length === 0) {
    throw new PlanError(`No display card for "${productName}" at $${formatPrice(price)}. Create it first; no other card will be substituted.`);
  }
  if (matches.length > 1) {
    throw new PlanError(`${matches.length} display cards match "${productName}" at $${formatPrice(price)} (${matches.map((c) => c.cardId).join(", ")}). Remove duplicates so the choice is unambiguous.`);
  }
  return { cardId: matches[0]!.cardId, label: matches[0]!.label };
}

function utcTimestamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Resolves a request into a plan. `generatedCard` is a card the app rendered
 * from the price (Phase 4); without it, an exact library match is required.
 */
export function planCampaign(
  settings: Settings,
  req: CampaignRequest,
  now = new Date(),
  generatedCard?: { pngPath: string; label: string },
): CampaignPlan {
  if (req.tiktokItemIds.length + (req.uploads?.length ?? 0) === 0) throw new PlanError("At least one creative is required.");
  const account = req.postingAccount
    ? settings.postingAccounts.find((a) => a.label === req.postingAccount)
    : settings.postingAccounts[0];
  if (!account?.identityId || !account.identityType) {
    throw new PlanError(`Posting account ${req.postingAccount ?? "(default)"} has no Spark identity saved in settings.`);
  }
  return {
    request: req,
    names: buildNames(settings, req, now),
    budget: req.dailyBudget ?? settings.defaults.dailyBudget,
    identity: { label: account.label, identityType: account.identityType, identityId: account.identityId },
    creatives: [
      ...req.tiktokItemIds.map((id): SparkCreative => ({ kind: "post", tiktokItemId: id, identityType: account.identityType!, identityId: account.identityId! })),
      ...(req.uploads ?? []).map((video): SparkCreative => ({ kind: "upload", video, identityType: account.identityType!, identityId: account.identityId! })),
    ],
    displayCard: generatedCard
      ? { label: generatedCard.label, generate: { pngPath: generatedCard.pngPath } }
      : selectDisplayCard(settings, req.advertiserId, req.productName, req.price),
    settings: settings.defaults,
    scheduleStartTime: utcTimestamp(now),
    adText: req.adText ?? settings.defaults.adText,
  };
}

// ---- Request payloads (Upgraded Smart+, per the connected MCP schemas) ----

/** Unique 64-bit-integer string for TikTok's idempotency `request_id`. */
export function newRequestId(): string {
  return (BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString();
}

export function campaignPayload(plan: CampaignPlan, requestId = newRequestId()) {
  return {
    advertiser_id: plan.request.advertiserId,
    request_id: requestId,
    campaign_name: plan.names.campaign,
    objective_type: "WEB_CONVERSIONS", // Sales
    sales_destination: "WEBSITE",
    campaign_type: "REGULAR_CAMPAIGN",
    catalog_enabled: false, // Catalog campaign OFF
    budget_optimize_on: true, // campaign budget (CBO)
    budget_mode: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET",
    budget: plan.budget,
    operation_status: plan.settings.launchStatus, // ENABLE = live as soon as it's published
  };
}

export function adGroupPayload(plan: CampaignPlan, campaignId: string, requestId = newRequestId()) {
  const d = plan.settings;
  return {
    advertiser_id: plan.request.advertiserId,
    request_id: requestId,
    campaign_id: campaignId,
    adgroup_name: plan.names.adGroup,
    promotion_type: "WEBSITE",
    optimization_goal: "CONVERT",
    pixel_id: plan.request.pixelId,
    optimization_event: d.optimizationEvent, // ON_WEB_CART = Add to Cart
    bid_type: "BID_TYPE_NO_BID", // Maximum Delivery
    billing_event: "OCPM",
    placement_type: "PLACEMENT_TYPE_NORMAL", // select placement, not automatic
    placements: ["PLACEMENT_TIKTOK"], // Pangle & Global App Bundle off
    tiktok_subplacements: [], // Lemon8 & PineDrama off
    targeting_optimization_mode: "AUTOMATIC", // audiences left alone
    suggestion_audience_enabled: false,
    targeting_spec: { location_ids: d.locationIds, spc_audience_age: d.audienceAge },
    schedule_type: "SCHEDULE_FROM_NOW", // start running now
    schedule_start_time: plan.scheduleStartTime,
    comment_disabled: d.commentDisabled,
    video_download_disabled: d.videoDownloadDisabled,
    operation_status: d.launchStatus,
  };
}

const PLACEHOLDER = { videoId: "<video_id>", coverImageId: "<cover_image_id>" };

function creativeInfo(c: SparkCreative, uploaded: UploadedAssets) {
  if (c.kind === "post") {
    // Spark Ads Pull: the post's own caption is shown.
    return { ad_format: "SINGLE_VIDEO", identity_type: c.identityType, identity_id: c.identityId, tiktok_item_id: c.tiktokItemId };
  }
  // Spark Ads Push: uploaded through the linked TikTok account.
  const ids = uploaded[c.video.sha256] ?? PLACEHOLDER;
  return {
    ad_format: "SINGLE_VIDEO",
    identity_type: c.identityType,
    identity_id: c.identityId,
    video_info: { video_id: ids.videoId },
    image_info: [{ web_uri: ids.coverImageId }],
  };
}

export function adPayloads(plan: CampaignPlan, adGroupId: string, uploaded: UploadedAssets = {}, cardId = plan.displayCard.cardId ?? "<generated_card_id>") {
  const groups = plan.settings.oneAdPerCreative ? plan.creatives.map((c) => [c]) : [plan.creatives];
  return groups.map((creatives, i) => {
    const pushed = creatives.filter((c): c is Extract<SparkCreative, { kind: "upload" }> => c.kind === "upload");
    return {
      advertiser_id: plan.request.advertiserId,
      adgroup_id: adGroupId,
      ad_name: plan.settings.oneAdPerCreative ? plan.names.ads[i]! : plan.names.adGroup,
      creative_list: creatives.map((c) => ({ creative_info: creativeInfo(c, uploaded) })),
      // Uploaded (Push) ads always use the configured ad text, e.g. "Sale ends at midnight!".
      // Existing posts (Pull) keep their own caption; TikTok shows the post as-is.
      ...(pushed.length ? { ad_text_list: [{ ad_text: plan.adText }] } : {}),
      landing_page_url_list: [{ landing_page_url: plan.request.landingPageUrl }],
      interactive_add_on_list: [{ card_id: cardId }],
      ad_configuration: {
        call_to_action_id: plan.settings.ctaPortfolioId,
        product_info_enabled: "UNSET", // continue without products
        creative_auto_add_toggle: false, // recommendations: auto-added creatives OFF
        creative_auto_enhancement_strategy_list: [] as string[], // recommendations: enhancements OFF
        // Push only: OFF = the video also shows on the TikTok profile (not ads-only).
        ...(pushed.length ? { dark_post_status: "OFF" } : {}),
      },
      operation_status: plan.settings.launchStatus,
    };
  });
}
