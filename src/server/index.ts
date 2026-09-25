import { randomUUID } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, relative, resolve } from "node:path";
import { prepareCampaign, PrepareError, type Prepared, type PrepareInput } from "../campaign/prepare.js";
import { buildCampaign } from "../campaign/run.js";
import { fetchLiveFacts, type LiveFacts } from "../campaign/validate.js";
import type { CampaignPlan } from "../campaign/plan.js";
import { marketingApiToken } from "../config/secrets.js";
import { readSecret } from "../config/secrets.js";
import { loadSettings, saveSettings, SETTINGS_PATH } from "../config/store.js";
import { rememberDisplayCard } from "../creative/displayCard.js";
import { log } from "../log/logger.js";
import { McpGateway, RecordingGateway, RestGateway, type Gateway } from "../tiktok/gateway.js";
import { MarketingApiClient, writesEnabled } from "../tiktok/marketingApi.js";
import { beginWebAuth, connectMcp, finishWebAuth } from "../tiktok/mcpClient.js";
import {
  cookieValue, mediaSignatureValid, newOAuthState, newSession, oauthStateValid, passwordMatches,
  SESSION_COOKIE, sessionValid, signMediaPath,
} from "./auth.js";

/**
 * The interface: form → Prepare → review → PUBLISH.
 *   npm run app                         (on your computer: http://localhost:5177)
 *   npm run app -- --demo <facts.json>  (no TikTok connection; snapshot facts)
 * Hosted (HOST=0.0.0.0): requires APP_PASSWORD and PUBLIC_URL; TikTok is
 * connected from the page, and uploads use signed links TikTok fetches.
 * Publishing sends real requests only when TT_WRITES_ENABLED is set (Phase 7).
 */
try {
  process.loadEnvFile(".env");
} catch {
  /* optional */
}

const PORT = Number(process.env.PORT ?? 5177);
const HOST = process.env.HOST ?? "127.0.0.1";
const HOSTED = !["127.0.0.1", "localhost", "::1"].includes(HOST);
const PUBLIC_URL = process.env.PUBLIC_URL?.replace(/\/$/, "");
const LOGIN_REQUIRED = HOSTED || !!process.env.APP_PASSWORD;

if (HOSTED) {
  // The app can spend money: never expose it without a login and a known address.
  const problems = [
    (process.env.APP_PASSWORD ?? "").length < 12 && "APP_PASSWORD (12+ characters)",
    !PUBLIC_URL?.startsWith("https://") && "PUBLIC_URL (the app's https:// address)",
  ].filter(Boolean);
  if (problems.length) {
    console.error(`Refusing to listen on ${HOST}: set ${problems.join(" and ")}.`);
    process.exit(1);
  }
}

// First start on a fresh data volume: seed the saved setup shipped with the app.
const BUNDLED_SETTINGS = resolve(import.meta.dirname, "../../config/settings.json");
if (!existsSync(SETTINGS_PATH) && existsSync(BUNDLED_SETTINGS) && resolve(SETTINGS_PATH) !== BUNDLED_SETTINGS) {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  copyFileSync(BUNDLED_SETTINGS, SETTINGS_PATH);
}
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

/**
 * Hosted without a Marketing API token: hand TikTok a signed, 1-hour link to
 * each file instead of uploading bytes. Locally, bytes go over REST.
 */
function buildOptions() {
  if (!PUBLIC_URL || marketingApiToken()) return {};
  return { publicUrl: (path: string) => `${PUBLIC_URL}${signMediaPath(relative(MEDIA, resolve(path)))}` };
}

const tiktokConnected = () => !!readSecret<{ tokens?: unknown }>("mcp-oauth")?.tokens;

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
      tiktokConnected: !!demoFacts || tiktokConnected(),
      hosted: LOGIN_REQUIRED,
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
      const result = await buildCampaign(gw, p.plan, p.checks, buildOptions());
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

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".mp4": "video/mp4" };

function serveMedia(res: ServerResponse, file: string, types: string[]) {
  if (!file.startsWith(MEDIA + "/") || !existsSync(file) || !types.includes(extname(file))) return send(res, 404, { error: "not found" });
  res.writeHead(200, { "Content-Type": MIME[extname(file)]!, "Cache-Control": "private, max-age=300" });
  createReadStream(file).pipe(res);
}

// ---- Login ----

const failures = new Map<string, { count: number; until: number }>();
const LOGIN_PAGE = (error = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in · Spark Test Launcher</title>
<style>:root{--bg:#f6f6f4;--panel:#fff;--text:#17171a;--line:#e3e3e0;--bad:#b3261e}@media (prefers-color-scheme:dark){:root{--bg:#121214;--panel:#1b1b1f;--text:#ececef;--line:#2c2c32;--bad:#ff8a80}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,sans-serif;padding:16px}
form{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:24px;width:100%;max-width:340px}
h1{font-size:18px;margin:0 0 16px}input{width:100%;box-sizing:border-box;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:9px;background:transparent;color:inherit}
button{margin-top:12px;width:100%;font:inherit;font-weight:700;padding:12px;border:0;border-radius:10px;background:var(--text);color:var(--bg);cursor:pointer}p{color:var(--bad);font-size:14px;margin:10px 0 0}</style></head>
<body><form method="post" action="/login"><h1>Spark Test Launcher</h1><input type="password" name="password" placeholder="Password" autofocus required>
<button>Sign in</button>${error ? `<p>${error}</p>` : ""}</form></body></html>`;

function authed(req: IncomingMessage): boolean {
  return !LOGIN_REQUIRED || sessionValid(cookieValue(req.headers.cookie, SESSION_COOKIE));
}

const publicRoutes: Record<string, Handler> = {
  "GET /healthz": async (_req, res) => send(res, 200, { ok: true }),
  "GET /login": async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(LOGIN_PAGE());
  },
  "POST /login": async (req, res) => {
    const ip = req.socket.remoteAddress ?? "?";
    const f = failures.get(ip);
    if (f && f.until > Date.now()) {
      res.writeHead(429, { "Content-Type": "text/html; charset=utf-8" });
      return void res.end(LOGIN_PAGE("Too many attempts — wait a minute."));
    }
    const password = new URLSearchParams((await body(req, 10_000)).toString()).get("password") ?? "";
    if (!passwordMatches(password)) {
      const count = (f?.count ?? 0) + 1;
      failures.set(ip, { count, until: count >= 5 ? Date.now() + 60_000 : 0 });
      log("warn", "server.login_failed", { ip });
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      return void res.end(LOGIN_PAGE("Wrong password."));
    }
    failures.delete(ip);
    res.writeHead(303, {
      Location: "/",
      "Set-Cookie": `${SESSION_COOKIE}=${newSession()}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax${HOSTED ? "; Secure" : ""}`,
    });
    res.end();
  },
};

// ---- Connect TikTok (web OAuth) ----

routes["GET /connect-tiktok"] = async (_req, res) => {
  const url = await beginWebAuth(newOAuthState);
  res.writeHead(303, { Location: url ? url.toString() : "/?connected=1" });
  res.end();
};

routes["GET /oauth/callback"] = async (_req, res, url) => {
  if (!oauthStateValid(url.searchParams.get("state"))) return send(res, 400, { error: "Invalid or expired sign-in attempt — press Connect TikTok again." });
  const code = url.searchParams.get("code");
  if (!code) return send(res, 400, { error: `TikTok didn't approve access: ${url.searchParams.get("error") ?? "no code"}` });
  await finishWebAuth(code);
  gatewayPromise = undefined; // reconnect with the new tokens
  res.writeHead(303, { Location: "/?connected=1" });
  res.end();
};

routes["POST /logout"] = async (_req, res) => {
  res.writeHead(303, { Location: "/login", "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax` });
  res.end();
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  try {
    const key = `${req.method} ${url.pathname}`;
    if (publicRoutes[key]) return await publicRoutes[key](req, res, url);

    // Signed links TikTok fetches during upload — no login, but must be valid and unexpired.
    if (req.method === "GET" && url.pathname.startsWith("/public-media/")) {
      const rel = decodeURIComponent(url.pathname.slice("/public-media/".length));
      if (!mediaSignatureValid(rel, url.searchParams.get("exp"), url.searchParams.get("sig"))) return send(res, 403, { error: "expired or invalid link" });
      return serveMedia(res, resolve(MEDIA, rel), [".mp4", ".jpg", ".png"]);
    }

    if (!authed(req)) {
      if (url.pathname.startsWith("/api/")) return send(res, 401, { error: "Signed out — reload the page." });
      res.writeHead(303, { Location: "/login" });
      return void res.end();
    }
    // Cross-site requests can't set this header, so state-changing calls must come from the page.
    if (req.method === "POST" && url.pathname.startsWith("/api/") && req.headers["x-tt-app"] !== "1") {
      return send(res, 403, { error: "Missing app header" });
    }

    const route = routes[key];
    if (route) return await route(req, res, url);
    if (req.method === "GET" && url.pathname.startsWith("/media/")) {
      return serveMedia(res, resolve("." + decodeURIComponent(url.pathname)), [".png", ".jpg"]);
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    log("error", "server.error", { path: url.pathname, error: String(err) });
    send(res, 500, { error: (err as Error).message });
  }
});

// Defaults to localhost; hosting requires APP_PASSWORD + PUBLIC_URL (checked above).
server.listen(PORT, HOST, () => {
  const where = HOSTED ? PUBLIC_URL : `http://localhost:${PORT}`;
  console.log(`tt-app running at ${where} — ${demoFacts ? "DEMO (no TikTok connection)" : writesEnabled() ? "LIVE" : "DRY RUN"}${LOGIN_REQUIRED ? " · login required" : ""}`);
});
