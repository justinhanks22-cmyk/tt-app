import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { SettingsSchema, type Settings } from "../src/config/schema.js";
import { adGroupPayload, adPayloads, campaignPayload, planCampaign, PlanError, type CampaignRequest } from "../src/campaign/plan.js";
import { buildCampaign, reviewSummary } from "../src/campaign/run.js";
import { validateCampaign, type LiveFacts } from "../src/campaign/validate.js";
import type { DryRunRecord, Gateway, Operation } from "../src/tiktok/gateway.js";

const live: LiveFacts = JSON.parse(readFileSync(new URL("./fixtures/poncho-live.json", import.meta.url), "utf8"));
const NOW = new Date("2026-09-25T13:00:00Z");

function settings(): Settings {
  return SettingsSchema.parse({
    advertisers: [{ advertiserId: "7360920068810702864", name: "Relakia0423" }],
    postingAccounts: [{ label: "miaclairee_3", handle: "@miaclairee_3", identityType: "AUTH_CODE", identityId: "7682104290172797966" }],
    displayCards: [
      { advertiserId: "7360920068810702864", cardId: "7689257131040721928", product: "Poncho", price: 29, label: "$29 TODAY ONLY" },
    ],
    landingPageDomains: ["ashandbloom.store"],
  });
}

const request = (over: Partial<CampaignRequest> = {}): CampaignRequest => ({
  advertiserId: "7360920068810702864",
  productName: "Poncho",
  price: 29,
  pixelId: "7689247033055625234",
  landingPageUrl: "https://ashandbloom.store/products/sage-hooded-poncho",
  tiktokItemIds: ["7689255287013903629"],
  ...over,
});

/** Records every call; never talks to TikTok. */
class FakeGateway implements Gateway {
  recorded: DryRunRecord[] = [];
  calls: Operation[] = [];
  async call(op: Operation, payload: Record<string, unknown>) {
    this.calls.push(op);
    const r: DryRunRecord = { dryRun: true, operation: op, payload, fakeId: `DRYRUN-${op}-${this.calls.length}` };
    this.recorded.push(r);
    return r;
  }
}

let s: Settings;
beforeEach(() => {
  s = settings();
  delete process.env.TT_WRITES_ENABLED;
});

describe("naming", () => {
  it("uses PRODUCT | $PRICE | SPARK | ATC | MM-dd in the account time zone", () => {
    const plan = planCampaign(s, request(), NOW);
    expect(plan.names.campaign).toBe("Poncho | $29 | SPARK | ATC | 09-25");
  });
});

describe("display card selection", () => {
  it("picks the exact product + price card", () => {
    expect(planCampaign(s, request(), NOW).displayCard.cardId).toBe("7689257131040721928");
  });
  it("refuses a price with no card instead of substituting", () => {
    expect(() => planCampaign(s, request({ price: 34 }), NOW)).toThrow(PlanError);
  });
  it("refuses another product's card at the same price", () => {
    expect(() => planCampaign(s, request({ productName: "Tumbler" }), NOW)).toThrow(/No display card for "Tumbler"/);
  });
});

describe("payloads match the product-test spec", () => {
  const plan = () => planCampaign(s, request({ tiktokItemIds: ["7689255287013903629", "7688472524039949598"] }), NOW);

  it("campaign: Sales/Website, catalog off, CBO $50/day, goes live", () => {
    expect(campaignPayload(plan(), "1")).toMatchObject({
      objective_type: "WEB_CONVERSIONS", sales_destination: "WEBSITE", catalog_enabled: false,
      budget_optimize_on: true, budget_mode: "BUDGET_MODE_DYNAMIC_DAILY_BUDGET", budget: 50, operation_status: "ENABLE",
    });
  });

  it("ad group: pixel + ATC, max delivery, TikTok only, no Lemon8, automatic audience, start now", () => {
    const g = adGroupPayload(plan(), "C", "1");
    expect(g).toMatchObject({
      pixel_id: "7689247033055625234", optimization_goal: "CONVERT", optimization_event: "ON_WEB_CART",
      bid_type: "BID_TYPE_NO_BID", placement_type: "PLACEMENT_TYPE_NORMAL", placements: ["PLACEMENT_TIKTOK"],
      tiktok_subplacements: [], targeting_optimization_mode: "AUTOMATIC", suggestion_audience_enabled: false,
      schedule_type: "SCHEDULE_FROM_NOW", schedule_start_time: "2026-09-25 13:00:00", operation_status: "ENABLE",
    });
    expect(g).not.toHaveProperty("catalog_id");
  });

  it("ads: one Spark ad per post, card attached, no products, no recommendations", () => {
    const ads = adPayloads(plan(), "G");
    expect(ads).toHaveLength(2);
    for (const a of ads) {
      expect(a.creative_list).toHaveLength(1);
      expect(a.creative_list[0]!.creative_info).toMatchObject({ ad_format: "SINGLE_VIDEO", identity_type: "AUTH_CODE", identity_id: "7682104290172797966" });
      expect(a.interactive_add_on_list).toEqual([{ card_id: "7689257131040721928" }]);
      expect(a.ad_configuration).toEqual({
        call_to_action_id: "7689257320064322567", product_info_enabled: "UNSET",
        creative_auto_add_toggle: false, creative_auto_enhancement_strategy_list: [],
      });
      expect(a.operation_status).toBe("ENABLE");
      expect(a).not.toHaveProperty("ad_text_list"); // existing posts show their own caption
    }
  });
});

describe("validateCampaign", () => {
  const failing = (checks: ReturnType<typeof validateCampaign>) => checks.filter((c) => c.status === "fail").map((c) => c.id);

  it("passes every check for the live poncho setup", () => {
    const checks = validateCampaign(planCampaign(s, request(), NOW), s, live, NOW);
    expect(failing(checks)).toEqual([]);
    expect(checks.filter((c) => typeof c.id === "number")).toHaveLength(15);
  });

  it("fails when the pixel was deleted", () => {
    expect(failing(validateCampaign(planCampaign(s, request(), NOW), s, { ...live, pixel: undefined }, NOW))).toEqual([5, 6]);
  });

  it("fails when the pixel has no Add to Cart event", () => {
    const pixel = { ...live.pixel!, events: [{ optimization_event: "SHOPPING" }] };
    expect(failing(validateCampaign(planCampaign(s, request(), NOW), s, { ...live, pixel }, NOW))).toEqual([6]);
  });

  it("fails for a post from another identity (Jesse) and duplicates", () => {
    const plan = planCampaign(s, request({ tiktokItemIds: ["7686943642308660511", "7689255287013903629", "7689255287013903629"] }), NOW);
    expect(failing(validateCampaign(plan, s, live, NOW))).toEqual([2, 15]);
  });

  it("fails when Spark authorization is missing or expired", () => {
    const post = live.sparkPosts["7689255287013903629"]!;
    const expired = { ...live, sparkPosts: { "7689255287013903629": { ...post, auth_info: { ad_auth_status: "AUTHORIZED", auth_end_time: "2026-01-01 00:00:00" } } } };
    expect(failing(validateCampaign(planCampaign(s, request(), NOW), s, expired, NOW))).toEqual([3]);
    const missing = { ...live, sparkPosts: {} };
    expect(failing(validateCampaign(planCampaign(s, request(), NOW), s, missing, NOW))).toEqual([2, 3]);
  });

  it("fails on a landing page outside the saved domains or not https", () => {
    expect(failing(validateCampaign(planCampaign(s, request({ landingPageUrl: "https://other.shop/p" }), NOW), s, live, NOW))).toEqual([4]);
    expect(failing(validateCampaign(planCampaign(s, request({ landingPageUrl: "http://ashandbloom.store/p" }), NOW), s, live, NOW))).toEqual([4]);
  });

  it("fails when the display card no longer exists", () => {
    expect(failing(validateCampaign(planCampaign(s, request(), NOW), s, { ...live, displayCard: undefined }, NOW))).toEqual([14]);
  });

  it("warns (not fails) when a caption states a different price", () => {
    const plan = planCampaign(s, request({ tiktokItemIds: ["7688472524039949598"] }), NOW);
    const checks = validateCampaign(plan, s, live, NOW);
    expect(checks.find((c) => c.id === "caption")!.status).toBe("warn");
    expect(failing(checks)).toEqual([]);
  });
});

describe("buildCampaign", () => {
  it("creates nothing when validation fails", async () => {
    const gw = new FakeGateway();
    const plan = planCampaign(s, request(), NOW);
    await expect(buildCampaign(gw, plan, validateCampaign(plan, s, { ...live, pixel: undefined }, NOW))).rejects.toThrow(/nothing was created/);
    expect(gw.calls).toEqual([]);
  });

  it("chains campaign → ad group → one ad per creative in dry run", async () => {
    const gw = new FakeGateway();
    const plan = planCampaign(s, request({ tiktokItemIds: ["7689255287013903629", "7688472524039949598"] }), NOW);
    const result = await buildCampaign(gw, plan, validateCampaign(plan, s, live, NOW));
    expect(gw.calls).toEqual(["smartPlusCampaignCreate", "smartPlusAdgroupCreate", "smartPlusAdCreate", "smartPlusAdCreate"]);
    expect(gw.recorded[1]!.payload.campaign_id).toBe(result.campaignId);
    expect(gw.recorded[2]!.payload.adgroup_id).toBe(result.adGroupId);
    expect(result.dryRun).toBe(true);
  });

  it("review lists every automation toggle", () => {
    const plan = planCampaign(s, request(), NOW);
    const review = reviewSummary(plan, validateCampaign(plan, s, live, NOW));
    expect(review.publishable).toBe(true);
    expect(review.toggles.map(([k]) => k)).toContain("Lemon8");
    expect(review.toggles.filter(([, v]) => v === "ON")).toEqual([]);
  });
});
