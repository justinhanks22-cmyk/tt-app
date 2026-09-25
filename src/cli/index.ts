import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { loadSettings, saveSettings, SETTINGS_PATH } from "../config/store.js";
import { marketingApiToken, readSecret, writeSecret } from "../config/secrets.js";
import { log } from "../log/logger.js";
import { API_BASE, MarketingApiClient, writesEnabled } from "../tiktok/marketingApi.js";
import { callMcpTool, connectMcp, DEFAULT_MCP_URL } from "../tiktok/mcpClient.js";

try {
  process.loadEnvFile(".env");
} catch {
  /* .env is optional */
}

type Check = { name: string; ok: boolean; detail: string; needed: string };

async function reachable(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
    // An egress proxy denial looks like a 403 but never reached TikTok.
    const denied = res.headers.get("x-deny-reason");
    if (denied) return { ok: false, detail: `blocked by network egress proxy (${denied})` };
    return { ok: true, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: String((err as Error).cause ?? err) };
  }
}

function hasBinary(bin: string, args = ["-version"]): boolean {
  try {
    execFileSync(bin, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function doctor(): Promise<void> {
  const settings = loadSettings();
  const mcpUrl = process.env.TIKTOK_MCP_URL ?? DEFAULT_MCP_URL;
  const [apiNet, mcpNet] = await Promise.all([reachable(`${API_BASE}/advertiser/info/`), reachable(mcpUrl)]);
  const checks: Check[] = [
    { name: "Node.js >= 22", ok: Number(process.versions.node.split(".")[0]) >= 22, detail: process.versions.node, needed: "Install Node.js 22+" },
    { name: "Network: Marketing API", ok: apiNet.ok, detail: apiNet.detail, needed: "Allow outbound HTTPS to business-api.tiktok.com" },
    { name: "Network: MCP server", ok: mcpNet.ok, detail: mcpNet.detail, needed: "Allow outbound HTTPS to business-api.tiktok.com" },
    { name: "MCP OAuth tokens", ok: !!readSecret<{ tokens?: unknown }>("mcp-oauth")?.tokens, detail: ".secrets/mcp-oauth.json", needed: "Run `npm run auth:mcp` on a machine with a browser" },
    { name: "TIKTOK_APP_ID", ok: !!process.env.TIKTOK_APP_ID, detail: "", needed: "Developer app ID from business-api.tiktok.com/portal" },
    { name: "TIKTOK_APP_SECRET", ok: !!process.env.TIKTOK_APP_SECRET, detail: "", needed: "Developer app secret (env only)" },
    { name: "Marketing API access token", ok: !!marketingApiToken(), detail: "", needed: "TIKTOK_ACCESS_TOKEN or `npm run auth:api`" },
    { name: "Writes locked (dry run)", ok: !writesEnabled(), detail: writesEnabled() ? "WRITES ENABLED" : "dry run", needed: "Unset TT_WRITES_ENABLED until Phase 7" },
    { name: "Saved settings", ok: true, detail: `${SETTINGS_PATH}: ${settings.advertisers.length} advertisers, ${settings.pixels.length} pixels, ${settings.displayCards.length} display cards`, needed: "" },
    { name: "ffprobe (Phase 4 video checks)", ok: hasBinary("ffprobe"), detail: "", needed: "Install ffmpeg (needed from Phase 4)" },
  ];
  for (const c of checks) {
    console.log(`${c.ok ? "✔" : "✘"} ${c.name}${c.detail ? ` — ${c.detail}` : ""}${c.ok || !c.needed ? "" : `\n    → ${c.needed}`}`);
  }
  log("info", "doctor", { checks });
}

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example).`);
  return v;
}

async function authApi(): Promise<void> {
  const appId = requireEnv("TIKTOK_APP_ID");
  const secret = requireEnv("TIKTOK_APP_SECRET");
  console.log(
    "Open your developer app's Advertiser authorization URL (business-api.tiktok.com/portal → My Apps),\n" +
      "approve your ad accounts, then copy the auth_code from the redirect URL.",
  );
  const authCode = await prompt("auth_code: ");
  const data = await new MarketingApiClient(undefined).exchangeAuthCode(appId, secret, authCode);
  writeSecret("marketing-api", data);
  console.log(`Saved token for ${data.advertiser_ids.length} advertiser account(s) to .secrets/marketing-api.json`);
}

/** Phase 1 via REST: list authorized ad accounts, read their details, save them to settings. */
async function verifyApi(): Promise<void> {
  const api = new MarketingApiClient(marketingApiToken());
  const { list } = await api.getAuthorizedAdvertisers(requireEnv("TIKTOK_APP_ID"), requireEnv("TIKTOK_APP_SECRET"));
  if (list.length === 0) {
    console.log("Token is valid but no ad accounts are authorized for it.");
    return;
  }
  const info = await api.getAdvertiserInfo(list.map((a) => a.advertiser_id));
  const settings = loadSettings();
  for (const a of info.list) {
    const id = String(a.advertiser_id);
    console.log(`✔ ${a.name} (${id}) — status ${a.status}, ${a.currency}, ${a.timezone}`);
    const existing = settings.advertisers.find((x) => x.advertiserId === id);
    const record = { advertiserId: id, name: String(a.name), currency: a.currency as string, timezone: a.timezone as string };
    if (existing) Object.assign(existing, record);
    else settings.advertisers.push(record);
  }
  saveSettings(settings);
  console.log(`Saved ${info.list.length} ad account(s) to ${SETTINGS_PATH}.`);
}

async function authMcp(): Promise<void> {
  const client = await connectMcp({ interactive: true });
  console.log(`Connected to ${client.getServerVersion()?.name ?? "MCP server"}; tokens saved to .secrets/mcp-oauth.json`);
  await client.close();
}

/**
 * Phase 1 via MCP: connect, record the server's real tool catalog (so later
 * phases map workflow steps to actual tool names instead of guesses), and
 * call a read-only advertiser tool if one exists.
 */
async function verifyMcp(): Promise<void> {
  const client = await connectMcp();
  const { tools } = await client.listTools();
  mkdirSync("logs", { recursive: true });
  const catalog = tools.map((t) => ({ name: t.name, description: t.description, annotations: t.annotations, inputSchema: t.inputSchema }));
  writeFileSync("logs/mcp-tools.json", JSON.stringify(catalog, null, 2));
  console.log(`MCP server exposes ${tools.length} tools (full catalog: logs/mcp-tools.json).`);

  const advertiserTools = tools.filter((t) => /advertiser/i.test(t.name) && /(get|info|list)/i.test(t.name));
  console.log(`Advertiser read tools: ${advertiserTools.map((t) => t.name).join(", ") || "none found"}`);
  const noArgTool = advertiserTools.find((t) => !(t.inputSchema.required ?? []).length);
  if (noArgTool) {
    const result = await callMcpTool(client, noArgTool.name, {}, "read");
    console.log(`${noArgTool.name} →`, JSON.stringify(result, null, 2).slice(0, 4000));
  } else {
    console.log("No zero-argument advertiser tool; inspect logs/mcp-tools.json and we'll wire the right one.");
  }
  await client.close();
}

const commands: Record<string, () => Promise<void>> = {
  doctor,
  "auth:api": authApi,
  "verify:api": verifyApi,
  "auth:mcp": authMcp,
  "verify:mcp": verifyMcp,
};

const name = process.argv[2] ?? "";
const command = commands[name];
if (!command) {
  console.error(`Usage: tsx src/cli/index.ts <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}
command().catch((err) => {
  log("error", `cli.${name}.failed`, { error: String(err) });
  process.exit(1);
});
