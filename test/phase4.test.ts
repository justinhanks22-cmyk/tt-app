import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsSchema, type Settings } from "../src/config/schema.js";
import { adPayloads, planCampaign, type CampaignRequest } from "../src/campaign/plan.js";
import { authorizeSparkAd, buildCampaign, reviewSummary } from "../src/campaign/run.js";
import { validateCampaign, type LiveFacts } from "../src/campaign/validate.js";
import { cardLabel, CARD_HEIGHT, CARD_WIDTH, renderDisplayCard } from "../src/creative/displayCard.js";
import { ingestCreative, type IngestedVideo } from "../src/creative/ingest.js";
import { MarketingApiClient, WRITES_ENABLED_VALUE } from "../src/tiktok/marketingApi.js";
import type { DryRunRecord, Gateway, Operation } from "../src/tiktok/gateway.js";

const NOW = new Date("2026-09-25T13:00:00Z");
const ADV = "7360920068810702864";
const MIA = "mia-tt-user-identity";

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

const settings = (): Settings =>
  SettingsSchema.parse({
    advertisers: [{ advertiserId: ADV, name: "Relakia0423" }],
    // After linking @miaclairee_3 in Ads Manager it becomes a TT_USER identity.
    postingAccounts: [{ label: "miaclairee_3", handle: "@miaclairee_3", identityType: "TT_USER", identityId: MIA }],
    landingPageDomains: ["ashandbloom.store"],
  });

const video = (over: Partial<IngestedVideo> = {}): IngestedVideo => ({
  sourceUrl: "https://www.tiktok.com/@creator/video/7000000000000000001",
  sourcePostId: "7000000000000000001",
  caption: "the absolute cutest top and it's only $29 today",
  filePath: "media/a.mp4",
  coverPath: "media/a-cover.jpg",
  sha256: "a".repeat(64),
  width: 1080, height: 1920, durationSec: 12, bitrate: 8_000_000,
  rightsConfirmed: true,
  ...over,
});

const request = (over: Partial<CampaignRequest> = {}): CampaignRequest => ({
  advertiserId: ADV, productName: "Poncho", price: 29, pixelId: "7689247033055625234",
  landingPageUrl: "https://ashandbloom.store/products/sage-hooded-poncho",
  tiktokItemIds: [], uploads: [video()], ...over,
});

const live: LiveFacts = {
  advertiser: { advertiser_id: ADV, name: "Relakia0423", status: "STATUS_ENABLE" },
  pixel: { pixel_id: "7689247033055625234", pixel_name: "Poncho pixel", events: [{ optimization_event: "ON_WEB_CART" }] },
  sparkPosts: {},
  pushIdentity: { identity_id: MIA, identity_type: "TT_USER", username: "miaclairee_3", available_status: "AVAILABLE", can_push_video: true },
};

const generated = { pngPath: "media/cards/poncho-29.png", label: cardLabel(29) };
const failing = (plan = planCampaign(settings(), request(), NOW, generated), facts = live) =>
  validateCampaign(plan, settings(), facts, NOW).filter((c) => c.status === "fail").map((c) => c.id);

beforeEach(() => {
  delete process.env.TT_WRITES_ENABLED;
});

describe("Spark Ads Push payload", () => {
  it("uploads via the linked account with \"Sale ends at midnight!\", shows on profile, goes live", () => {
    const plan = planCampaign(settings(), request(), NOW, generated);
    const [ad] = adPayloads(plan, "G", { ["a".repeat(64)]: { videoId: "v1", coverImageId: "img1" } }, "card1");
    expect(ad!.creative_list[0]!.creative_info).toEqual({
      ad_format: "SINGLE_VIDEO", identity_type: "TT_USER", identity_id: MIA,
      video_info: { video_id: "v1" }, image_info: [{ web_uri: "img1" }],
    });
    expect(ad!.ad_text_list).toEqual([{ ad_text: "Sale ends at midnight!" }]); // never the source caption
    expect(ad!.operation_status).toBe("ENABLE");
    expect(ad!.ad_configuration).toMatchObject({ dark_post_status: "OFF", product_info_enabled: "UNSET", creative_auto_enhancement_strategy_list: [] });
    expect(ad!.interactive_add_on_list).toEqual([{ card_id: "card1" }]);
  });
});

describe("Phase 4 validation", () => {
  it("passes with a linked account, confirmed rights and a generated card", () => {
    expect(failing()).toEqual([]);
  });

  it("stops when the posting account isn't linked to the ad account", () => {
    expect(failing(undefined, { ...live, pushIdentity: undefined })).toEqual([2, 3]);
  });

  it("stops when the linked account can't push videos", () => {
    expect(failing(undefined, { ...live, pushIdentity: { ...live.pushIdentity!, can_push_video: false } })).toEqual([3]);
  });

  it("stops without rights confirmation", () => {
    const plan = planCampaign(settings(), request({ uploads: [video({ rightsConfirmed: false })] }), NOW, generated);
    expect(failing(plan)).toEqual(["rights"]);
  });

  it("uses a per-campaign ad text override", () => {
    const plan = planCampaign(settings(), request({ adText: "Last day at this price" }), NOW, generated);
    expect(adPayloads(plan, "G")[0]!.ad_text_list).toEqual([{ ad_text: "Last day at this price" }]);
  });

  it("stops on ad text over 100 characters", () => {
    const plan = planCampaign(settings(), request({ adText: "x".repeat(101) }), NOW, generated);
    expect(failing(plan)).toEqual(["ad-text"]);
  });

  it("ignores the source caption's price and emoji; warns on ad text that names another price", () => {
    const plan = planCampaign(settings(), request({ uploads: [video({ caption: "Just $34 today 💫" })] }), NOW, generated);
    const checks = validateCampaign(plan, settings(), live, NOW);
    expect(checks.filter((c) => c.status !== "pass")).toEqual([]);
    const other = planCampaign(settings(), request({ adText: "Only $34 today" }), NOW, generated);
    expect(validateCampaign(other, settings(), live, NOW).find((c) => c.id === "caption")!.status).toBe("warn");
  });

  it("flags the same source video submitted twice", () => {
    const plan = planCampaign(settings(), request({ uploads: [video(), video({ sha256: "b".repeat(64) })] }), NOW, generated);
    expect(failing(plan)).toEqual([15]);
  });

  it("a generated card always carries the entered price", () => {
    const wrong = planCampaign(settings(), request(), NOW, { ...generated, label: cardLabel(34) });
    expect(failing(wrong)).toEqual([14]);
  });
});

describe("buildCampaign with uploads (dry run)", () => {
  it("creates the card and uploads before the campaign, and chains IDs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-"));
    const png = join(dir, "card.png");
    await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).png().toFile(png);
    const cover = join(dir, "c.jpg");
    await sharp({ create: { width: 10, height: 10, channels: 3, background: "#000" } }).jpeg().toFile(cover);
    const mp4 = join(dir, "v.mp4");
    execFileSync(ffmpegPath as unknown as string, ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=720x1280:d=1", "-pix_fmt", "yuv420p", mp4]);

    const plan = planCampaign(settings(), request({ uploads: [video({ filePath: mp4, coverPath: cover })] }), NOW, { pngPath: png, label: cardLabel(29) });
    const gw = new FakeGateway();
    const result = await buildCampaign(gw, plan, validateCampaign(plan, settings(), live, NOW));
    expect(gw.calls).toEqual(["imageUpload", "portfolioCreate", "videoUpload", "imageUpload", "smartPlusCampaignCreate", "smartPlusAdgroupCreate", "smartPlusAdCreate"]);
    const ad = gw.recorded.at(-1)!.payload as ReturnType<typeof adPayloads>[number];
    expect(ad.interactive_add_on_list[0]!.card_id).toBe(result.cardId);
    expect(ad.creative_list[0]!.creative_info).toMatchObject({ video_info: { video_id: result.uploaded["a".repeat(64)]!.videoId } });
    expect(reviewSummary(plan, []).toggles).toContainEqual(["Uploads show on profile (not ads-only)", "ON"]);
  });
});

describe("live launch safety", () => {
  it("pauses the campaign if a later step fails, then reports", async () => {
    class FailingAdGateway extends FakeGateway {
      override async call(op: Operation, payload: Record<string, unknown>) {
        if (op === "smartPlusAdCreate") throw new Error("code 40002: invalid ad text");
        return super.call(op, payload);
      }
    }
    const gw = new FailingAdGateway();
    const dir = mkdtempSync(join(tmpdir(), "tt-"));
    const png = join(dir, "card.png");
    await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).png().toFile(png);
    const cover = join(dir, "c.jpg");
    await sharp({ create: { width: 10, height: 10, channels: 3, background: "#000" } }).jpeg().toFile(cover);
    const plan = planCampaign(settings(), request({ uploads: [video({ filePath: png, coverPath: cover })] }), NOW, { pngPath: png, label: cardLabel(29) });
    await expect(buildCampaign(gw, plan, validateCampaign(plan, settings(), live, NOW))).rejects.toThrow(/was paused.*invalid ad text/);
    expect(gw.calls.at(-1)).toBe("smartPlusCampaignStatusUpdate");
    expect(gw.recorded.at(-1)!.payload).toMatchObject({ operation_status: "DISABLE" });
  });
});

describe("display card", () => {
  it("renders exactly 750x421", async () => {
    const photo = await sharp({ create: { width: 800, height: 1000, channels: 3, background: "#8a9" } }).png().toBuffer();
    const meta = await sharp(await renderDisplayCard(photo, 29)).metadata();
    expect([meta.width, meta.height]).toEqual([CARD_WIDTH, CARD_HEIGHT]);
    expect(cardLabel(29)).toBe("$29 TODAY ONLY");
    expect(cardLabel(19.5)).toBe("$19.50 TODAY ONLY");
  });
});

describe("ingestCreative", () => {
  it("refuses without rights confirmation", async () => {
    await expect(ingestCreative({ filePath: "x.mp4", rightsConfirmed: false })).rejects.toThrow(/Stopped/);
  });

  it("stores, probes, extracts a cover and takes the caption from TikTok oEmbed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-"));
    const src = join(dir, "in.mp4");
    execFileSync(ffmpegPath as unknown as string, ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=1080x1920:d=2", "-pix_fmt", "yuv420p", src]);
    const fetchImpl = vi.fn(async () => Response.json({ title: "only $29 today", author_unique_id: "creator", embed_product_id: "7000000000000000001" }));
    const v = await ingestCreative({ filePath: src, url: "https://www.tiktok.com/@creator/video/7000000000000000001", rightsConfirmed: true, mediaDir: join(dir, "media"), fetchImpl });
    expect(v).toMatchObject({ width: 1080, height: 1920, caption: "only $29 today", sourceAuthor: "creator", sourcePostId: "7000000000000000001" });
    expect(readFileSync(v.coverPath).length).toBeGreaterThan(0);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain("tiktok.com/oembed?url=");
  });
});

describe("uploads & Spark codes", () => {
  it("multipart upload is dry-run by default and signed with MD5 when enabled", async () => {
    const f = vi.fn(async () => Response.json({ code: 0, message: "OK", data: { image_id: "i1" } }));
    const api = new MarketingApiClient("tok", f);
    const body = { advertiser_id: ADV, upload_type: "UPLOAD_BY_FILE", file_name: "c.png", image_file: Buffer.from("abc") };
    expect(await api.upload("/file/image/ad/upload/", body, "image_file", "image_signature")).toMatchObject({ dryRun: true });
    expect(f).not.toHaveBeenCalled();

    process.env.TT_WRITES_ENABLED = WRITES_ENABLED_VALUE;
    await api.upload("/file/image/ad/upload/", body, "image_file", "image_signature");
    const form = (f.mock.calls[0] as unknown as [URL, RequestInit])[1].body as FormData;
    expect(form.get("image_signature")).toBe("900150983cd24fb0d6963f7d28e17f72"); // md5("abc")
    expect(form.get("upload_type")).toBe("UPLOAD_BY_FILE");
  });

  it("authorizeSparkAd encodes '+' as %2B and stays dry-run", async () => {
    const gw = new FakeGateway();
    await authorizeSparkAd(gw, ADV, " #ab+cd= ");
    expect(gw.recorded[0]).toMatchObject({ operation: "ttVideoAuthorize", payload: { auth_code: "#ab%2Bcd=" } });
  });
});
