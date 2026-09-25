import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { log } from "../log/logger.js";
import { MarketingApiClient, writesEnabled } from "./marketingApi.js";
import { callMcpTool } from "./mcpClient.js";

/**
 * Every TikTok operation the app uses, with its official MCP tool name and
 * Marketing API path. Tool names come from the connected TikTok for Business
 * MCP server; payload shapes are identical on both routes.
 */
export const OPERATIONS = {
  advertiserInfo: { mcp: "advertiser_info_get", path: "/advertiser/info/", write: false },
  pixelList: { mcp: "pixel_list_get", path: "/pixel/list/", write: false },
  ttVideoInfo: { mcp: "tt_video_info_get", path: "/tt_video/info/", write: false },
  ttVideoList: { mcp: "tt_video_list_get", path: "/tt_video/list/", write: false },
  ttVideoAuthorize: { mcp: "tt_video_authorize_apply", path: "/tt_video/authorize/", write: true },
  portfolioGet: { mcp: "creative_portfolio_get", path: "/creative/portfolio/get/", write: false },
  smartPlusCampaignCreate: { mcp: "smart_plus_campaign_create", path: "/smart_plus/campaign/create/", write: true },
  smartPlusAdgroupCreate: { mcp: "smart_plus_adgroup_create", path: "/smart_plus/adgroup/create/", write: true },
  smartPlusAdCreate: { mcp: "smart_plus_ad_create", path: "/smart_plus/ad/create/", write: true },
  smartPlusCampaignGet: { mcp: "smart_plus_campaign_get", path: "/smart_plus/campaign/get/", write: false },
  smartPlusAdgroupGet: { mcp: "smart_plus_adgroup_get", path: "/smart_plus/adgroup/get/", write: false },
  smartPlusAdGet: { mcp: "smart_plus_ad_get", path: "/smart_plus/ad/get/", write: false },
  smartPlusCampaignStatusUpdate: { mcp: "smart_plus_campaign_status_update", path: "/smart_plus/campaign/status/update/", write: true },
} as const;

export type Operation = keyof typeof OPERATIONS;

/** A write that was recorded but not sent. `fakeId` lets later steps chain. */
export interface DryRunRecord {
  dryRun: true;
  operation: Operation;
  payload: Record<string, unknown>;
  fakeId: string;
}

export interface Gateway {
  call<T = Record<string, unknown>>(op: Operation, payload: Record<string, unknown>): Promise<T | DryRunRecord>;
  /** Writes recorded in dry-run mode, in order. */
  readonly recorded: DryRunRecord[];
}

abstract class BaseGateway implements Gateway {
  readonly recorded: DryRunRecord[] = [];
  private counter = 0;

  async call<T>(op: Operation, payload: Record<string, unknown>): Promise<T | DryRunRecord> {
    if (OPERATIONS[op].write && !writesEnabled()) {
      const record: DryRunRecord = { dryRun: true, operation: op, payload, fakeId: `DRYRUN-${op}-${++this.counter}` };
      this.recorded.push(record);
      log("info", "gateway.dry_run", { operation: op, payload });
      return record;
    }
    return this.send<T>(op, payload);
  }

  protected abstract send<T>(op: Operation, payload: Record<string, unknown>): Promise<T>;
}

/** Official MCP route (preferred). */
export class McpGateway extends BaseGateway {
  constructor(private readonly client: Client) {
    super();
  }
  protected async send<T>(op: Operation, payload: Record<string, unknown>): Promise<T> {
    const { mcp, write } = OPERATIONS[op];
    const result = await callMcpTool(this.client, mcp, payload, write ? "write" : "read");
    if ("dryRun" in result) throw new Error("unreachable: gateway already handled dry run");
    const text = (result.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "";
    const parsed = JSON.parse(text) as { code: number; message: string; request_id?: string; data: T };
    if (result.isError || parsed.code !== 0) {
      throw new Error(`TikTok rejected ${mcp} — code ${parsed.code}: ${parsed.message} (request_id ${parsed.request_id ?? "n/a"})`);
    }
    return parsed.data;
  }
}

/** Marketing API route (fallback). */
export class RestGateway extends BaseGateway {
  constructor(private readonly api: MarketingApiClient) {
    super();
  }
  protected async send<T>(op: Operation, payload: Record<string, unknown>): Promise<T> {
    const { path, write } = OPERATIONS[op];
    if (!write) return this.api.get<T>(path, payload);
    return this.api.post<T>(path, payload) as Promise<T>;
  }
}

export function isDryRun(x: unknown): x is DryRunRecord {
  return typeof x === "object" && x !== null && (x as DryRunRecord).dryRun === true;
}
