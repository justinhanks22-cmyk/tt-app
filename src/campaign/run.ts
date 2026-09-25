import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createDisplayCard } from "../creative/displayCard.js";
import { log } from "../log/logger.js";
import { isDryRun, type Gateway } from "../tiktok/gateway.js";
import { adGroupPayload, adPayloads, campaignPayload, type CampaignPlan, type UploadedAssets } from "./plan.js";
import { canPublish, type Check } from "./validate.js";

const idOf = (r: unknown, key: string): string =>
  isDryRun(r) ? r.fakeId : String((r as Record<string, unknown>)[key]);

// ---- Spark identity & authorization ----

/**
 * authorizeSparkAd(): applies a creator's Spark code so the post can run as an
 * ad (Spark Ads Pull). Fallback route when a post isn't on a linked account.
 */
export async function authorizeSparkAd(gw: Gateway, advertiserId: string, authCode: string, originalPostAuthCode?: string) {
  const code = (s: string) => s.trim().replace(/\+/g, "%2B"); // TikTok: '+' must be sent as %2B
  return gw.call("ttVideoAuthorize", {
    advertiser_id: advertiserId,
    auth_code: code(authCode),
    ...(originalPostAuthCode ? { original_post_auth_code: code(originalPostAuthCode) } : {}),
  });
}

/** getSparkIdentity(): the linked TikTok account (TT_USER) for a username, if linked. */
export async function getSparkIdentity(gw: Gateway, advertiserId: string, username: string) {
  const r = await gw.call<{ identity_list: { identity_id: string; identity_type: string; username?: string; display_name?: string; can_push_video?: boolean; available_status?: string }[] }>(
    "identityGet", { advertiser_id: advertiserId, identity_type: "TT_USER", page_size: 100 },
  );
  if (isDryRun(r)) return undefined;
  const handle = username.replace(/^@/, "").toLowerCase();
  return r.identity_list.find((i) => i.username?.toLowerCase() === handle);
}

// ---- Asset uploads (Spark Ads Push) ----

/** postTikTok(): uploads each video + cover so it can be pushed through the linked account. */
export async function uploadCreatives(gw: Gateway, plan: CampaignPlan): Promise<UploadedAssets> {
  const assets: UploadedAssets = {};
  for (const c of plan.creatives) {
    if (c.kind !== "upload") continue;
    const v = c.video;
    const video = await gw.call<{ video_id: string }[] | { video_id: string }>("videoUpload", {
      advertiser_id: plan.request.advertiserId,
      upload_type: "UPLOAD_BY_FILE",
      file_name: `${plan.request.productName.slice(0, 40)}-${v.sha256.slice(0, 12)}.mp4`,
      video_file: readFileSync(v.filePath),
    });
    const cover = await gw.call<{ image_id: string }>("imageUpload", {
      advertiser_id: plan.request.advertiserId,
      upload_type: "UPLOAD_BY_FILE",
      file_name: `${basename(v.coverPath, ".jpg")}-cover.jpg`,
      image_file: readFileSync(v.coverPath),
    });
    assets[v.sha256] = {
      videoId: isDryRun(video) ? video.fakeId : (Array.isArray(video) ? video[0]!.video_id : video.video_id),
      coverImageId: isDryRun(cover) ? cover.fakeId : cover.image_id,
    };
  }
  return assets;
}

// ---- Campaign objects ----

export async function createCampaign(gw: Gateway, plan: CampaignPlan): Promise<string> {
  return idOf(await gw.call("smartPlusCampaignCreate", campaignPayload(plan)), "campaign_id");
}

export async function createAdGroup(gw: Gateway, plan: CampaignPlan, campaignId: string): Promise<string> {
  return idOf(await gw.call("smartPlusAdgroupCreate", adGroupPayload(plan, campaignId)), "adgroup_id");
}

/** createSparkAd(): one Spark ad per creative (or one ad with all, per settings). */
export async function createSparkAds(gw: Gateway, plan: CampaignPlan, adGroupId: string, uploaded: UploadedAssets, cardId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const payload of adPayloads(plan, adGroupId, uploaded, cardId)) {
    ids.push(idOf(await gw.call("smartPlusAdCreate", payload), "smart_plus_ad_id"));
  }
  return ids;
}

export interface BuildResult {
  campaignId: string;
  adGroupId: string;
  adIds: string[];
  cardId: string;
  uploaded: UploadedAssets;
  dryRun: boolean;
}

/**
 * Display card → uploads → campaign → ad group → ads, with the launch status. Refuses
 * to start if any validation check failed. In dry run nothing leaves the machine.
 */
export async function buildCampaign(gw: Gateway, plan: CampaignPlan, checks: Check[]): Promise<BuildResult> {
  if (!canPublish(checks)) {
    const failed = checks.filter((c) => c.status === "fail").map((c) => `#${c.id} ${c.label}: ${c.detail}`);
    throw new Error(`Validation failed — nothing was created:\n${failed.join("\n")}`);
  }
  const cardId = plan.displayCard.generate
    ? (await createDisplayCard(gw, {
        advertiserId: plan.request.advertiserId,
        product: plan.request.productName,
        price: plan.request.price,
        png: readFileSync(plan.displayCard.generate.pngPath),
        fileName: basename(plan.displayCard.generate.pngPath),
      })).cardId
    : plan.displayCard.cardId!;
  const uploaded = await uploadCreatives(gw, plan);
  const campaignId = await createCampaign(gw, plan);
  let adGroupId: string;
  let adIds: string[];
  try {
    adGroupId = await createAdGroup(gw, plan, campaignId);
    adIds = await createSparkAds(gw, plan, adGroupId, uploaded, cardId);
  } catch (err) {
    // A live campaign must never be left half-built: pause it, then report.
    log("error", "campaign.build_failed", { campaignId, error: String(err) });
    await gw.call("smartPlusCampaignStatusUpdate", {
      advertiser_id: plan.request.advertiserId, campaign_ids: [campaignId], operation_status: "DISABLE",
    }).catch((e) => log("error", "campaign.rollback_failed", { campaignId, error: String(e) }));
    throw new Error(`Build failed after creating campaign ${campaignId}; it was paused. Cause: ${(err as Error).message}`);
  }
  const result = { campaignId, adGroupId, adIds, cardId, uploaded, dryRun: campaignId.startsWith("DRYRUN-") };
  log("info", "campaign.built", { ...result, name: plan.names.campaign });
  return result;
}

/**
 * publishCampaign(): validates, then builds everything with the launch status
 * (ENABLE = live immediately). Real requests are only sent once writes are
 * enabled (Phase 7); until then it's a dry run.
 */
export async function publishCampaign(gw: Gateway, plan: CampaignPlan, checks: Check[]): Promise<BuildResult> {
  return buildCampaign(gw, plan, checks);
}

export async function getCampaignStatus(gw: Gateway, advertiserId: string, campaignId: string) {
  return gw.call("smartPlusCampaignGet", { advertiser_id: advertiserId, filtering: { campaign_ids: [campaignId] } });
}

/** Everything the review screen shows, in order. */
export function reviewSummary(plan: CampaignPlan, checks: Check[]) {
  const c = campaignPayload(plan, "0");
  const g = adGroupPayload(plan, "0", "0");
  const onOff = (v: boolean) => (v ? "ON" : "OFF");
  const pulls = plan.creatives.filter((x) => x.kind === "post");
  const pushes = plan.creatives.filter((x) => x.kind === "upload");
  return {
    rows: [
      ["Campaign name", plan.names.campaign],
      ["Campaign type", "Upgraded Smart+ · Sales → Website"],
      ["TikTok Ads account", plan.request.advertiserId],
      ["TikTok posting account", `${plan.identity.label} (${plan.identity.identityType})`],
      ["Creatives", [
        pulls.length ? `${pulls.length} existing Spark post(s)` : "",
        pushes.length ? `${pushes.length} upload(s) posted to ${plan.identity.label}` : "",
      ].filter(Boolean).join(" + ")],
      ["Ads", plan.settings.oneAdPerCreative ? `${plan.creatives.length} (one per creative)` : "1 (all creatives)"],
      ["Landing page", plan.request.landingPageUrl],
      ["Pixel", plan.request.pixelId],
      ["Optimization event", "Add to Cart (ON_WEB_CART)"],
      ["Budget", `$${c.budget}/day, campaign level (CBO)`],
      ["Bidding", "Maximum Delivery"],
      ["Schedule", `Start now (${g.schedule_start_time} UTC), no end date`],
      ["Placements", "TikTok only"],
      ["Audience", `Automatic (left alone), ${g.targeting_spec.location_ids.join(", ")}, age ${g.targeting_spec.spc_audience_age}`],
      ["Display card", plan.displayCard.generate ? `${plan.displayCard.label} — new card from ${plan.displayCard.generate.pngPath}` : `${plan.displayCard.label} (${plan.displayCard.cardId})`],
      ["Ad copy", pushes.length ? `"${plan.adText}"${pulls.length ? " (existing posts keep their own caption)" : ""}` : "Existing posts keep their own caption"],
      ["Launch", plan.settings.launchStatus === "ENABLE" ? "Goes LIVE immediately on PUBLISH" : "Created paused"],
      ["CTA portfolio", plan.settings.ctaPortfolioId],
      ["Comments / downloads", `comments ${g.comment_disabled ? "disabled" : "enabled"}, downloads ${g.video_download_disabled ? "disabled" : "enabled"}`],
    ] as [string, string][],
    creatives: plan.creatives.map((x) =>
      x.kind === "post"
        ? { kind: "Existing post", id: x.tiktokItemId, caption: "" }
        : { kind: "Upload → profile", id: x.video.sourcePostId ?? x.video.sha256.slice(0, 12), caption: plan.adText },
    ),
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
      ...(pushes.length ? [["Uploads show on profile (not ads-only)", "ON"] as [string, string]] : []),
    ] as [string, string][],
    checks,
    publishable: canPublish(checks),
  };
}
