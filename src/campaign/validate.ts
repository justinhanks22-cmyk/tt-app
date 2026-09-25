import type { Settings } from "../config/schema.js";
import type { Gateway } from "../tiktok/gateway.js";
import { isDryRun } from "../tiktok/gateway.js";
import { cardLabel } from "../creative/displayCard.js";
import { adGroupPayload, adPayloads, campaignPayload, creativeKey, type CampaignPlan, type SparkCreative } from "./plan.js";

export type CheckStatus = "pass" | "fail" | "warn";
export interface Check {
  id: number | string;
  label: string;
  status: CheckStatus;
  detail: string;
}

type SparkPost = {
  item_info: { item_id: string; text?: string };
  auth_info: { ad_auth_status: string; auth_end_time?: string };
  user_info: { identity_id: string; identity_type: string; tiktok_name?: string };
};

/** Live facts fetched read-only from TikTok before publishing. */
export interface LiveFacts {
  advertiser?: { advertiser_id: string; name: string; status: string };
  pixel?: { pixel_id: string; pixel_name: string; events?: { optimization_event?: string; event_type?: string }[] };
  sparkPosts: Record<string, SparkPost | undefined>;
  displayCard?: { creative_portfolio_id: string; creative_portfolio_type: string };
  /** The linked account used for Spark Ads Push (identity/get). */
  pushIdentity?: { identity_id: string; identity_type: string; display_name?: string; username?: string; available_status?: string; can_push_video?: boolean };
}

type Post = Extract<SparkCreative, { kind: "post" }>;
type Upload = Extract<SparkCreative, { kind: "upload" }>;
const posts = (plan: CampaignPlan) => plan.creatives.filter((c): c is Post => c.kind === "post");
const uploads = (plan: CampaignPlan) => plan.creatives.filter((c): c is Upload => c.kind === "upload");

export async function fetchLiveFacts(gw: Gateway, plan: CampaignPlan): Promise<LiveFacts> {
  const advertiserId = plan.request.advertiserId;
  const read = async <T>(p: Promise<T | unknown>): Promise<T | undefined> => {
    try {
      const r = await p;
      return isDryRun(r) ? undefined : (r as T);
    } catch {
      return undefined; // a failed read leaves the fact missing, which fails its check
    }
  };
  const pullPosts = posts(plan);
  const [adv, pixels, card, identities, ...postLists] = await Promise.all([
    read<{ list: LiveFacts["advertiser"][] }>(gw.call("advertiserInfo", { advertiser_ids: [advertiserId], fields: ["advertiser_id", "name", "status"] })),
    read<{ pixels: NonNullable<LiveFacts["pixel"]>[] }>(gw.call("pixelList", { advertiser_id: advertiserId, pixel_id: plan.request.pixelId })),
    plan.displayCard.cardId
      ? read<NonNullable<LiveFacts["displayCard"]>>(gw.call("portfolioGet", { advertiser_id: advertiserId, creative_portfolio_id: plan.displayCard.cardId }))
      : Promise.resolve(undefined),
    uploads(plan).length
      ? read<{ identity_list: NonNullable<LiveFacts["pushIdentity"]>[] }>(gw.call("identityGet", { advertiser_id: advertiserId, identity_type: plan.identity.identityType, page_size: 100 }))
      : Promise.resolve(undefined),
    ...pullPosts.map((c) => read<{ list: SparkPost[] }>(gw.call("ttVideoList", { advertiser_id: advertiserId, keyword: c.tiktokItemId }))),
  ]);
  return {
    advertiser: adv?.list?.[0],
    pixel: pixels?.pixels?.find((p) => p.pixel_id === plan.request.pixelId),
    displayCard: card,
    pushIdentity: identities?.identity_list?.find((i) => i.identity_id === plan.identity.identityId),
    sparkPosts: Object.fromEntries(pullPosts.map((c, i) => [c.tiktokItemId, postLists[i]?.list?.find((p) => p.item_info.item_id === c.tiktokItemId)])),
  };
}

const check = (id: Check["id"], label: string, ok: boolean, detail: string, soft = false): Check => ({
  id, label, status: ok ? "pass" : soft ? "warn" : "fail", detail,
});

/** Prices written in a caption, e.g. "only $29 today" → [29]. */
export function captionPrices(text: string | undefined): number[] {
  return [...(text ?? "").matchAll(/\$\s?(\d+(?:\.\d{1,2})?)/g)].map((m) => Number(m[1]));
}

const EMOJI = /\p{Extended_Pictographic}/u;
/** TikTok's ad text limit (characters). */
export const AD_TEXT_MAX = 100;

/**
 * The publish gate. Checks the exact payloads that would be sent plus live
 * account state. Any "fail" blocks publishing.
 */
export function validateCampaign(plan: CampaignPlan, settings: Settings, live: LiveFacts, now = new Date()): Check[] {
  const c = campaignPayload(plan, "0");
  const g = adGroupPayload(plan, "0", "0");
  const ads = adPayloads(plan, "0");
  const req = plan.request;
  const pull = posts(plan).map((cr) => ({ cr, post: live.sparkPosts[cr.tiktokItemId] }));
  const push = uploads(plan);
  const checks: Check[] = [];

  const savedAdvertiser = settings.advertisers.find((a) => a.advertiserId === req.advertiserId);
  checks.push(check(1, "Correct advertiser account",
    !!savedAdvertiser && live.advertiser?.advertiser_id === req.advertiserId && live.advertiser?.status === "STATUS_ENABLE",
    live.advertiser ? `${live.advertiser.name} (${req.advertiserId}), ${live.advertiser.status}` : `${req.advertiserId} could not be read live`));

  // 2 + 3: identity and Spark authorization, per creative kind.
  const wrongIdentity = pull.filter(({ cr, post }) => !post || post.user_info.identity_id !== cr.identityId).map(({ cr }) => cr.tiktokItemId);
  const pushId = live.pushIdentity;
  const pushIdentityOk = push.length === 0 || (!!pushId && pushId.identity_id === plan.identity.identityId && ["TT_USER", "BC_AUTH_TT"].includes(pushId.identity_type));
  checks.push(check(2, "Correct TikTok identity", wrongIdentity.length === 0 && pushIdentityOk, [
    wrongIdentity.length ? `Posts not on ${plan.identity.label} or not found: ${wrongIdentity.join(", ")}` : pull.length ? `${pull.length} post(s) on ${plan.identity.label}` : "",
    push.length ? (pushIdentityOk ? `${push.length} upload(s) via linked account @${pushId?.username ?? plan.identity.label}` : `${plan.identity.label} is not linked to this ad account as a TikTok account (TT_USER). Link it once in Ads Manager, then save its identity ID.`) : "",
  ].filter(Boolean).join("; ")));

  const badAuth = pull.filter(({ post }) =>
    !post || post.auth_info.ad_auth_status !== "AUTHORIZED" ||
    (post.auth_info.auth_end_time !== undefined && new Date(post.auth_info.auth_end_time.replace(" ", "T") + "Z") <= now));
  const pushAuthOk = push.length === 0 || (pushId?.available_status === "AVAILABLE" && pushId.can_push_video === true);
  checks.push(check(3, "Spark authorization valid", badAuth.length === 0 && pushAuthOk, [
    badAuth.length ? `Missing/expired: ${badAuth.map((b) => `${b.cr.tiktokItemId} (${b.post?.auth_info.ad_auth_status ?? "not authorized to this ad account"})`).join(", ")}. Apply the post's Spark code first.` : pull.length ? "Posts AUTHORIZED and unexpired" : "",
    push.length ? (pushAuthOk ? "Linked account can push videos" : `Linked account can't push videos (status ${pushId?.available_status ?? "not linked"}, can_push_video ${pushId?.can_push_video ?? "n/a"})`) : "",
  ].filter(Boolean).join("; ")));

  let lpOk = false;
  let lpDetail = req.landingPageUrl;
  try {
    const url = new URL(req.landingPageUrl);
    const domains = settings.landingPageDomains;
    const domainOk = domains.length === 0 || domains.some((d) => url.hostname === d || url.hostname.endsWith(`.${d}`));
    lpOk = url.protocol === "https:" && domainOk && ads.every((a) => a.landing_page_url_list[0]!.landing_page_url === req.landingPageUrl);
    if (!domainOk) lpDetail += ` — domain not in saved list (${domains.join(", ")})`;
    if (url.protocol !== "https:") lpDetail += " — must be https";
  } catch {
    lpDetail += " — not a valid URL";
  }
  checks.push(check(4, "Correct landing page", lpOk, lpDetail));

  checks.push(check(5, "Correct pixel", !!live.pixel && g.pixel_id === req.pixelId,
    live.pixel ? `${live.pixel.pixel_name} (${req.pixelId})` : `Pixel ${req.pixelId} not found in this ad account (deleted or wrong ID)`));

  const pixelHasAtc = !!live.pixel?.events?.some((e) => (e.optimization_event ?? e.event_type) === "ON_WEB_CART");
  checks.push(check(6, "Optimization is Add to Cart", g.optimization_goal === "CONVERT" && g.optimization_event === "ON_WEB_CART" && pixelHasAtc,
    pixelHasAtc ? "CONVERT / ON_WEB_CART" : "Pixel has no Add to Cart (ON_WEB_CART) event set up"));

  const overridden = req.dailyBudget !== undefined && req.dailyBudget !== settings.defaults.dailyBudget;
  checks.push(check(7, "Budget", c.budget === (req.dailyBudget ?? settings.defaults.dailyBudget) && c.budget > 0,
    `$${c.budget}/day${overridden ? ` (override; default $${settings.defaults.dailyBudget})` : ""}`));

  checks.push(check(8, "Campaign-level budget (CBO)", c.budget_optimize_on === true && c.budget_mode === "BUDGET_MODE_DYNAMIC_DAILY_BUDGET",
    `${c.budget_mode}, CBO ${c.budget_optimize_on ? "ON" : "OFF"}`));

  checks.push(check(9, "TikTok is the only placement",
    g.placement_type === "PLACEMENT_TYPE_NORMAL" && g.placements.length === 1 && g.placements[0] === "PLACEMENT_TIKTOK",
    `${g.placement_type}: ${g.placements.join(", ")} (Pangle, Global App Bundle off)`));

  checks.push(check(10, "Lemon8 OFF", g.tiktok_subplacements.length === 0, "TikTok sub-placements: none (Lemon8, PineDrama off)"));

  checks.push(check(11, "Catalog OFF", c.catalog_enabled === false && !("catalog_id" in g), "catalog_enabled=false, no catalog on ad group"));

  checks.push(check(12, "Product attachment OFF", ads.every((a) => a.ad_configuration.product_info_enabled === "UNSET"),
    "product_info_enabled=UNSET (continue without products)"));

  checks.push(check(13, "Optional AI creative enhancements OFF",
    ads.every((a) => a.ad_configuration.creative_auto_add_toggle === false && a.ad_configuration.creative_auto_enhancement_strategy_list.length === 0),
    "Auto-added creatives OFF; enhancements [] (no video quality, music refresh, dubbing, image edits)"));

  if (plan.displayCard.generate) {
    const ok = plan.displayCard.label === cardLabel(req.price);
    checks.push(check(14, "Display card matches price", ok,
      ok ? `${plan.displayCard.label} — generated from the entered price` : `Generated card says "${plan.displayCard.label}" but price is $${req.price}`));
  } else {
    const cardLive = live.displayCard?.creative_portfolio_type === "CARD" && live.displayCard.creative_portfolio_id === plan.displayCard.cardId;
    checks.push(check(14, "Display card matches price", cardLive && ads.every((a) => a.interactive_add_on_list[0]!.card_id === plan.displayCard.cardId),
      cardLive ? `${plan.displayCard.label} (${plan.displayCard.cardId})` : `Card ${plan.displayCard.cardId} not found as a Display Card in this ad account`));
  }

  const keys = plan.creatives.map(creativeKey);
  const sourcePosts = push.map((u) => u.video.sourcePostId).filter((x): x is string => !!x);
  const dupes = [...keys.filter((k, i) => keys.indexOf(k) !== i), ...sourcePosts.filter((k, i) => sourcePosts.indexOf(k) !== i)];
  checks.push(check(15, "No duplicate creatives", dupes.length === 0,
    dupes.length ? `Duplicates: ${[...new Set(dupes)].map((d) => d.slice(0, 19)).join(", ")}` : `${keys.length} unique creative(s)`));

  // ---- Extra checks for uploaded (Push) creatives ----
  if (push.length) {
    const noRights = push.filter((u) => !u.video.rightsConfirmed);
    checks.push(check("rights", "Rights confirmed for every upload", noRights.length === 0,
      noRights.length ? `Missing confirmation: ${noRights.map((u) => u.video.sourceUrl ?? u.video.filePath).join(", ")}` : `${push.length} upload(s) confirmed owned/licensed`));

    const adTextLen = [...plan.adText].length;
    checks.push(check("ad-text", `Ad text is 1–${AD_TEXT_MAX} characters`, plan.adText.trim() !== "" && adTextLen <= AD_TEXT_MAX,
      `"${plan.adText}" (${adTextLen} chars) on ${push.length} uploaded ad(s)`));

    checks.push(check("ad-text-emoji", "Ad text has no emoji", !EMOJI.test(plan.adText),
      EMOJI.test(plan.adText) ? "Ad text contains emoji; TikTok's ad text may reject emoji" : "No emoji", true));

    const lowRes = push.filter((u) => Math.min(u.video.width, u.video.height) < 720 || u.video.height <= u.video.width);
    checks.push(check("video", "Video is vertical and ≥720p", lowRes.length === 0,
      lowRes.length ? lowRes.map((u) => `${u.video.width}x${u.video.height}`).join(", ") : push.map((u) => `${u.video.width}x${u.video.height}`).join(", "), true));
  }

  // Price in any text the viewer sees vs. entered price (warning only).
  const captions = [
    ...pull.map(({ cr, post }) => ({ key: cr.tiktokItemId, text: post?.item_info.text })),
    ...(push.length ? [{ key: "ad text", text: plan.adText }] : []),
  ];
  const mismatched = captions.filter(({ text }) => {
    const prices = captionPrices(text);
    return prices.length > 0 && !prices.includes(req.price);
  });
  checks.push(check("caption", "Caption price matches", mismatched.length === 0,
    mismatched.length ? mismatched.map((m) => `${m.key}: "${m.text}"`).join("; ") : "No conflicting price in captions", true));

  const launch = plan.settings.launchStatus;
  checks.push(check("launch", "Launch status", [c, g, ...ads].every((x) => x.operation_status === launch),
    launch === "ENABLE" ? "Campaign, ad group and ads go live immediately when PUBLISH is pressed" : "Created paused; enable in Ads Manager"));

  return checks;
}

export const canPublish = (checks: Check[]) => checks.every((c) => c.status !== "fail");
