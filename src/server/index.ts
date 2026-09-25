import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, resolve } from "node:path";
import { prepareCampaign, PrepareError, type Prepared, type PrepareInput } from "../campaign/prepare.js";
import { buildCampaign } from "../campaign/run.js";
import { fetchLiveFacts, type LiveFacts } from "../campaign/validate.js";
import type { CampaignPlan } from "../campaign/plan.js";
import { marketingApiToken } from "../config/secrets.js";
import { loadSettings, saveSettings } from "../config/store.js";
import { rememberDisplayCard } from "../creative/displayCard.js";
import { log } from "../log/logger.js";
import { McpGateway, RecordingGateway, RestGateway, type Gateway } from "../tiktok/gateway.js";
import { MarketingApiClient, writesEnabled } from "../tiktok/marketingApi.js";
import { connectMcp } from "../tiktok/mcpClient.js";

/**
 * The local interface: form → Prepare → review → PUBLISH.
 *   npm run app                         (live reads via the MCP server)
 *   npm run app -- --demo <facts.json>  (no TikTok connection; snapshot facts)
 * Publishing sends real requests only when TT_WRITES_ENABLED is set (Phase 7).
 */
try {
  process.loadEnvFile(".env");
} catch {
  /* optional */
}

const PORT = Number(process.env.PORT ?? 5177);
const demoIdx = process.argv.indexOf("--demo");
const demoFacts: LiveFacts | undefined = demoIdx > 0 ? JSON.parse(readFileSync(process.argv[demoIdx + 1]!, "utf8")) : undefined;
const PAGE = resolve(import.meta.dirname, "page.html");
const MEDIA = resolve("media");

let gatewayPromise: Promise<Gateway> | undefined;
/** Live gateway: MCP for everything, REST for file uploads when a token exists. */
function gateway(): Promise<Gateway> {
  if (demoFacts) return Promise.resolve(new RecordingGateway());
  gatewayPromise ??= connectMcp().then((client) => {
    const token = marketingApiToken();
    return new McpGateway(client, token ? new RestGateway(new MarketingApiClient(token)) : undefined);
  });
  return gatewayPromise.catch((err) => {
    gatewayPromise = undefined; // retry on the next request
    throw new Error(`Not connected to TikTok (${(err as Error).message}). Run \`npm run auth:mcp\` first, or start with --demo.`);
  });
}

async function liveFacts(plan: CampaignPlan): Promise<LiveFacts> {
  if (demoFacts) return demoFacts;
  return fetchLiveFacts(await gateway(), plan);
}

const prepared = new Map<string, Prepared & { createdAt: number }>();

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage, limit = 300 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("Upload too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;

const routes: Record<string, Handler> = {
  "GET /": async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    createReadStream(PAGE).pipe(res);
  },

  "GET /api/options": async (_req, res) => {
    const s = loadSettings();
    send(res, 200, {
      advertisers: s.advertisers,
      postingAccounts: s.postingAccounts.filter((a) => a.identityType === "TT_USER" || a.identityType === "BC_AUTH_TT"),
      defaults: s.defaults,
      landingPageDomains: s.landingPageDomains,
      mode: writesEnabled() && !demoFacts ? "LIVE" : "DRY RUN",
      demo: !!demoFacts,
    });
  },

  /** Pixels in the ad account, newest first, flagged if Add to Cart is set up. */
  "GET /api/pixels": async (_req, res, url) => {
    const advertiserId = url.searchParams.get("advertiserId") ?? "";
    type Pixel = { pixel_id: string; pixel_name: string; pixel_code?: string; create_time?: string; events?: { optimization_event?: string }[] };
    let pixels: Pixel[] = [];
    if (demoFacts?.pixel) {
      pixels = [demoFacts.pixel as Pixel];
    } else if (!demoFacts) {
      const r = await (await gateway()).call<{ pixels: Pixel[] }>("pixelList", { advertiser_id: advertiserId, order_by: "LATEST_CREATE", page_size: 20 });
      pixels = "pixels" in r ? r.pixels : [];
    }
    send(res, 200, pixels.map((p) => ({
      id: p.pixel_id, name: p.pixel_name, code: p.pixel_code, created: p.create_time,
      addToCart: !!p.events?.some((e) => e.optimization_event === "ON_WEB_CART"),
    })));
  },

  /** Fallback when a link can't be downloaded: the original video file. */
  "POST /api/upload": async (req, res) => {
    const bytes = await body(req);
    mkdirSync(join(MEDIA, "uploads"), { recursive: true });
    const file = join(MEDIA, "uploads", `${randomUUID()}.mp4`);
    writeFileSync(file, bytes);
    send(res, 200, { file });
  },

  "POST /api/prepare": async (req, res) => {
    const input = JSON.parse((await body(req, 1024 * 1024)).toString()) as PrepareInput;
    try {
      const result = await prepareCampaign(loadSettings(), input, liveFacts);
      const id = randomUUID();
      prepared.set(id, { ...result, createdAt: Date.now() });
      const card = result.plan.displayCard.generate?.pngPath;
      send(res, 200, { id, review: result.review, cardUrl: card ? `/${card}` : undefined });
    } catch (err) {
      const problems = err instanceof PrepareError ? err.problems : [];
      send(res, 422, { error: (err as Error).message, problems });
    }
  },

  "POST /api/publish": async (req, res) => {
    const { id } = JSON.parse((await body(req, 10_000)).toString()) as { id: string };
    const p = prepared.get(id);
    if (!p) return send(res, 404, { error: "Nothing prepared with that ID — press Prepare Campaign again." });
    if (Date.now() - p.createdAt > 30 * 60_000) return send(res, 409, { error: "This review is over 30 minutes old — prepare it again so the checks are fresh." });
    if (!p.review.publishable) return send(res, 409, { error: "Safety checks failed — nothing was created." });
    const gw = demoFacts ? new RecordingGateway() : await gateway();
    try {
      const result = await buildCampaign(gw, p.plan, p.checks);
      prepared.delete(id);
      if (!result.dryRun && p.plan.displayCard.generate) {
        const s = loadSettings();
        rememberDisplayCard(s, p.plan.request.advertiserId, p.plan.request.productName, p.plan.request.price, result.cardId);
        saveSettings(s);
      }
      send(res, 200, { ...result, requests: gw.recorded.length });
    } catch (err) {
      send(res, 502, { error: (err as Error).message });
    }
  },
};

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  try {
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) return await route(req, res, url);
    if (req.method === "GET" && url.pathname.startsWith("/media/")) {
      const file = resolve("." + decodeURIComponent(url.pathname));
      if (!file.startsWith(MEDIA + "/") || !existsSync(file) || !MIME[extname(file)]) return send(res, 404, { error: "not found" });
      res.writeHead(200, { "Content-Type": MIME[extname(file)]! });
      return createReadStream(file).pipe(res);
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    log("error", "server.error", { path: url.pathname, error: String(err) });
    send(res, 500, { error: (err as Error).message });
  }
});

// Localhost only: this server can spend money on your ad account.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`tt-app running at http://localhost:${PORT} — ${demoFacts ? "DEMO (no TikTok connection)" : writesEnabled() ? "LIVE" : "DRY RUN"}`);
});
