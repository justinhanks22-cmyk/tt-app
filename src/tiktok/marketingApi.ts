import { createHash, randomUUID } from "node:crypto";
import { log } from "../log/logger.js";

/**
 * Thin client for TikTok API for Business (Marketing API v1.3).
 *
 * Endpoint paths and parameter names come from TikTok's official Business API
 * SDK (github.com/tiktok/tiktok-business-api-sdk), which is generated from the
 * same spec as business-api.tiktok.com/portal/docs. Response envelope:
 * { code, message, request_id, data } where code 0 means success.
 */
export const API_BASE = "https://business-api.tiktok.com/open_api/v1.3";

/** The only value of TT_WRITES_ENABLED that lets a write request leave this machine. */
export const WRITES_ENABLED_VALUE = "I_APPROVED_PUBLISHING";

export function writesEnabled(): boolean {
  return process.env.TT_WRITES_ENABLED === WRITES_ENABLED_VALUE;
}

export interface ApiEnvelope<T> {
  code: number;
  message: string;
  request_id?: string;
  data: T;
}

export class TikTokApiError extends Error {
  constructor(
    readonly path: string,
    readonly response: ApiEnvelope<unknown> | { httpStatus: number; body: string },
  ) {
    const detail =
      "code" in response
        ? `code ${response.code}: ${response.message} (request_id ${response.request_id ?? "n/a"})`
        : `HTTP ${response.httpStatus}: ${response.body.slice(0, 500)}`;
    super(`TikTok rejected ${path} — ${detail}`);
  }
}

/** Returned instead of a real response when a write is blocked by dry-run mode. */
export interface DryRunResult {
  dryRun: true;
  path: string;
  body: unknown;
}

type Fetch = typeof fetch;

export class MarketingApiClient {
  constructor(
    private readonly accessToken: string | undefined,
    private readonly fetchImpl: Fetch = fetch,
    private readonly base = API_BASE,
  ) {}

  /**
   * GET with TikTok's query encoding: arrays/objects are JSON-encoded
   * (e.g. advertiser_ids=["123"]), scalars are sent as-is.
   */
  async get<T>(path: string, params: Record<string, unknown> = {}, opts: { auth?: boolean } = {}): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) continue;
      url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    return this.send<T>("GET", path, url, undefined, opts.auth ?? true);
  }

  /**
   * POST. Unless writes are explicitly enabled, the request is logged in full
   * and NOT sent. `alwaysSend` is only for non-mutating POSTs such as the OAuth
   * token exchange.
   */
  async post<T>(path: string, body: unknown, opts: { auth?: boolean; alwaysSend?: boolean } = {}): Promise<T | DryRunResult> {
    if (!opts.alwaysSend && !writesEnabled()) {
      log("info", "api.dry_run", { method: "POST", path, body });
      return { dryRun: true, path, body };
    }
    return this.send<T>("POST", path, new URL(this.base + path), body, opts.auth ?? true);
  }

  /**
   * Multipart upload (upload_type UPLOAD_BY_FILE). `fileField` holds the bytes;
   * TikTok verifies them against the MD5 in `signatureField`. Dry-run guarded.
   */
  async upload<T>(path: string, fields: Record<string, unknown>, fileField: string, signatureField: string): Promise<T | DryRunResult> {
    const bytes = fields[fileField];
    if (!(bytes instanceof Buffer)) throw new Error(`${fileField} must be a Buffer`);
    const meta = Object.fromEntries(Object.entries(fields).filter(([k]) => k !== fileField));
    const signature = createHash("md5").update(bytes).digest("hex");
    if (!writesEnabled()) {
      log("info", "api.dry_run", { method: "POST", path, body: { ...meta, [signatureField]: signature, [fileField]: `<${bytes.length} bytes>` } });
      return { dryRun: true, path, body: meta };
    }
    const form = new FormData();
    for (const [k, v] of Object.entries(meta)) if (v !== undefined) form.set(k, String(v));
    form.set(signatureField, signature);
    form.set(fileField, new Blob([new Uint8Array(bytes)]), String(fields.file_name ?? "upload"));
    return this.send<T>("POST", path, new URL(this.base + path), form, true);
  }

  private async send<T>(method: string, path: string, url: URL, body: unknown, auth: boolean): Promise<T> {
    if (auth && !this.accessToken) {
      throw new Error("No Marketing API access token. Set TIKTOK_ACCESS_TOKEN or run `npm run auth:api`.");
    }
    const traceId = randomUUID();
    const headers: Record<string, string> = { Accept: "application/json" };
    if (auth) headers["Access-Token"] = this.accessToken!;
    const isForm = body instanceof FormData;
    if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";

    const query = Object.fromEntries(url.searchParams);
    log("info", "api.request", { traceId, method, path, query, body: isForm ? "<multipart>" : body });
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(url, { method, headers, body: body === undefined ? undefined : isForm ? body : JSON.stringify(body) });
    } catch (err) {
      log("error", "api.network_error", { traceId, method, path, error: String(err), cause: String((err as Error).cause ?? "") });
      throw err;
    }
    const text = await res.text();
    const ms = Date.now() - started;
    let parsed: ApiEnvelope<T> | undefined;
    try {
      parsed = JSON.parse(text) as ApiEnvelope<T>;
    } catch {
      /* non-JSON body handled below */
    }
    log(parsed?.code === 0 ? "info" : "error", "api.response", {
      traceId, method, path, httpStatus: res.status, ms, response: parsed ?? text.slice(0, 2000),
    });
    if (!res.ok || !parsed) throw new TikTokApiError(path, { httpStatus: res.status, body: text });
    if (parsed.code !== 0) throw new TikTokApiError(path, parsed);
    return parsed.data;
  }

  // ---- Phase 1: read-only account access -------------------------------

  /** Exchange a one-time advertiser auth_code for a long-term access token. */
  exchangeAuthCode(appId: string, secret: string, authCode: string) {
    return this.post<{ access_token: string; advertiser_ids: string[]; scope: number[] }>(
      "/oauth2/access_token/",
      { app_id: appId, secret, auth_code: authCode },
      { auth: false, alwaysSend: true },
    ) as Promise<{ access_token: string; advertiser_ids: string[]; scope: number[] }>;
  }

  /** Ad accounts this token is authorized for. */
  getAuthorizedAdvertisers(appId: string, secret: string) {
    return this.get<{ list: { advertiser_id: string; advertiser_name: string }[] }>("/oauth2/advertiser/get/", {
      app_id: appId,
      secret,
    });
  }

  getAdvertiserInfo(advertiserIds: string[]) {
    return this.get<{ list: Record<string, unknown>[] }>("/advertiser/info/", { advertiser_ids: advertiserIds });
  }
}
