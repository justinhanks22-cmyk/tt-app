import { log } from "../log/logger.js";
import { isDryRun, type Gateway } from "../tiktok/gateway.js";
import { adGroupPayload, adPayloads, campaignPayload, type CampaignPlan } from "./plan.js";
import { canPublish, type Check } from "./validate.js";

const idOf = (r: unknown, key: string): string =>
  isDryRun(r) ? r.fakeId : String((r as Record<string, unknown>)[key]);

export async function createCampaign(gw: Gateway, plan: CampaignPlan): Promise<string> {
  return idOf(await gw.call("smartPlusCampaignCreate", campaignPayload(plan)), "campaign_id");
}

export async function createAdGroup(gw: Gateway, plan: CampaignPlan, campaignId: string): Promise<string> {
  return idOf(await gw.call("smartPlusAdgroupCreate", adGroupPayload(plan, campaignId)), "adgroup_id");
}

export async function createSparkAds(gw: Gateway, plan: CampaignPlan, adGroupId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const payload of adPayloads(plan, adGroupId)) {
    ids.push(idOf(await gw.call("smartPlusAdCreate", payload), "smart_plus_ad_id"));
  }
  return ids;
}

export interface BuildResult {
  campaignId: string;
  adGroupId: string;
  adIds: string[];
  dryRun: boolean;
}

/**
 * Creates campaign → ad group → ads, all DISABLED. Refuses to start if any
 * validation check failed. In dry-run mode nothing leaves the machine.
 */
export async function buildCampaign(gw: Gateway, plan: CampaignPlan, checks: Check[]): Promise<BuildResult> {
  if (!canPublish(checks)) {
    const failed = checks.filter((c) => c.status === "fail").map((c) => `#${c.id} ${c.label}: ${c.detail}`);
    throw new Error(`Validation failed — nothing was created:\n${failed.join("\n")}`);
  }
  const campaignId = await createCampaign(gw, plan);
  const adGroupId = await createAdGroup(gw, plan, campaignId);
  const adIds = await createSparkAds(gw, plan, adGroupId);
  const result = { campaignId, adGroupId, adIds, dryRun: campaignId.startsWith("DRYRUN-") };
  log("info", "campaign.built", { ...result, name: plan.names.campaign });
  return result;
}

/** Enabling a built campaign. Locked until the user approves Phase 7. */
export async function publishCampaign(_gw: Gateway, _build: BuildResult): Promise<never> {
  throw new Error("Publishing is disabled until Phase 7 is approved.");
}

export async function getCampaignStatus(gw: Gateway, advertiserId: string, campaignId: string) {
  return gw.call("smartPlusCampaignGet", { advertiser_id: advertiserId, filtering: { campaign_ids: [campaignId] } });
}

/** Everything the review screen shows, in order. */
export function reviewSummary(plan: CampaignPlan, checks: Check[]) {
  const c = campaignPayload(plan, "0");
  const g = adGroupPayload(plan, "0", "0");
  const onOff = (v: boolean) => (v ? "ON" : "OFF");
  return {
    rows: [
      ["Campaign name", plan.names.campaign],
      ["Campaign type", "Upgraded Smart+ · Sales → Website"],
      ["TikTok Ads account", plan.request.advertiserId],
      ["TikTok posting account", `${plan.identity.label} (${plan.identity.identityType})`],
      ["Creatives", `${plan.creatives.length} Spark post(s): ${plan.creatives.map((x) => x.tiktokItemId).join(", ")}`],
      ["Ads", plan.settings.oneAdPerCreative ? `${plan.creatives.length} (one per creative)` : "1 (all creatives)"],
      ["Landing page", plan.request.landingPageUrl],
      ["Pixel", plan.request.pixelId],
      ["Optimization event", "Add to Cart (ON_WEB_CART)"],
      ["Budget", `$${c.budget}/day, campaign level (CBO)`],
      ["Bidding", "Maximum Delivery"],
      ["Schedule", `Start now (${g.schedule_start_time} UTC), no end date`],
      ["Placements", "TikTok only"],
      ["Audience", `Automatic (left alone), ${g.targeting_spec.location_ids.join(", ")}, age ${g.targeting_spec.spc_audience_age}`],
      ["Display card", `${plan.displayCard.label} (${plan.displayCard.cardId})`],
      ["Ad copy", "TikTok post caption (Spark)"],
      ["CTA portfolio", plan.settings.ctaPortfolioId],
      ["Comments / downloads", `comments ${g.comment_disabled ? "disabled" : "enabled"}, downloads ${g.video_download_disabled ? "disabled" : "enabled"}`],
    ] as [string, string][],
    toggles: [
      ["Catalog campaign", onOff(c.catalog_enabled)],
      ["Products (catalog / product info)", "OFF (continue without products)"],
      ["Video catalog ads / image catalog ads", "OFF"],
      ["Pangle", "OFF"],
      ["Global App Bundle", "OFF"],
      ["Lemon8", "OFF"],
      ["PineDrama", "OFF"],
      ["Automatic placement", "OFF"],
      ["Search results", "Not settable via API — read back after creation"],
      ["Audience suggestions", onOff(g.suggestion_audience_enabled)],
      ["Auto-add new creatives", "OFF"],
      ["Video quality enhancement", "OFF"],
      ["Music refresh", "OFF"],
      ["Translate & dub", "OFF"],
      ["Image quality / resize", "OFF"],
    ] as [string, string][],
    checks,
    publishable: canPublish(checks),
  };
}
