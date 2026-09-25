import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketingApiClient, TikTokApiError, WRITES_ENABLED_VALUE } from "../src/tiktok/marketingApi.js";

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
}

let logDir: string;
beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), "tt-logs-"));
  process.env.TT_LOG_DIR = logDir;
  delete process.env.TT_WRITES_ENABLED;
});
afterEach(() => {
  delete process.env.TT_LOG_DIR;
  delete process.env.TT_WRITES_ENABLED;
});

function logLines(): Record<string, unknown>[] {
  const file = readdirSync(logDir)[0]!;
  return readFileSync(join(logDir, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

describe("MarketingApiClient", () => {
  it("JSON-encodes array query params and sends the Access-Token header", async () => {
    const f = fakeFetch({ code: 0, message: "OK", data: { list: [] } });
    await new MarketingApiClient("tok", f).getAdvertiserInfo(["123", "456"]);
    const [url, init] = f.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(url.searchParams.get("advertiser_ids")).toBe('["123","456"]');
    expect((init.headers as Record<string, string>)["Access-Token"]).toBe("tok");
  });

  it("surfaces TikTok's code, message and request_id on rejection", async () => {
    const f = fakeFetch({ code: 40001, message: "Invalid access token", request_id: "req-9", data: {} });
    await expect(new MarketingApiClient("tok", f).getAdvertiserInfo(["1"])).rejects.toThrow(
      /code 40001: Invalid access token \(request_id req-9\)/,
    );
  });

  it("throws on non-JSON HTTP errors", async () => {
    const f = fakeFetch("Bad Gateway", 502);
    await expect(new MarketingApiClient("tok", f).getAdvertiserInfo(["1"])).rejects.toBeInstanceOf(TikTokApiError);
  });

  it("never sends a write while in dry-run mode", async () => {
    const f = fakeFetch({ code: 0, message: "OK", data: {} });
    const res = await new MarketingApiClient("tok", f).post("/campaign/create/", { campaign_name: "x" });
    expect(f).not.toHaveBeenCalled();
    expect(res).toMatchObject({ dryRun: true, path: "/campaign/create/" });
  });

  it("treats any value other than the exact approval string as dry run", async () => {
    process.env.TT_WRITES_ENABLED = "true";
    const f = fakeFetch({ code: 0, message: "OK", data: {} });
    await new MarketingApiClient("tok", f).post("/campaign/create/", {});
    expect(f).not.toHaveBeenCalled();
  });

  it("sends writes only with the explicit approval value", async () => {
    process.env.TT_WRITES_ENABLED = WRITES_ENABLED_VALUE;
    const f = fakeFetch({ code: 0, message: "OK", data: { campaign_id: "1" } });
    await new MarketingApiClient("tok", f).post("/campaign/create/", {});
    expect(f).toHaveBeenCalledOnce();
  });

  it("logs the full request/response without secrets", async () => {
    const f = fakeFetch({ code: 0, message: "OK", data: { list: [] } });
    await new MarketingApiClient("tok", f).getAuthorizedAdvertisers("app1", "s3cr3t-value");
    const text = JSON.stringify(logLines());
    expect(text).toContain("/oauth2/advertiser/get/");
    expect(text).not.toContain("s3cr3t-value");
    expect(text).not.toContain('"tok"');
  });
});
