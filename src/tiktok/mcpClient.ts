import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { readSecret, writeSecret } from "../config/secrets.js";
import { log } from "../log/logger.js";
import { writesEnabled } from "./marketingApi.js";

/**
 * Client for the official TikTok for Business MCP server. Auth is the
 * server's own browser OAuth (per TikTok: authorize your TikTok for Business
 * account in the browser; authorization lasts 30 days). Tokens are stored in
 * .secrets/mcp-oauth.json, never in source or settings.
 */
export const DEFAULT_MCP_URL = "https://business-api.tiktok.com/open_mcp/tt-ads-mcp-flat";

interface StoredMcpAuth {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

class FileOAuthProvider implements OAuthClientProvider {
  /** Set when TikTok asks the user to approve access. */
  authorizationUrl?: URL;

  constructor(
    readonly redirectUrl: string,
    private readonly onRedirect: (url: URL) => void = (url) =>
      console.log(`\nOpen this URL in your browser and approve access to your TikTok for Business account:\n\n  ${url}\n`),
    private readonly stateFn?: () => string,
  ) {
    // Only add `state` to the authorization URL when the caller can verify it.
    if (stateFn) this.state = () => stateFn();
  }
  state?: () => string;

  private load(): StoredMcpAuth {
    return readSecret<StoredMcpAuth>("mcp-oauth") ?? {};
  }
  private save(patch: Partial<StoredMcpAuth>): void {
    writeSecret("mcp-oauth", { ...this.load(), ...patch });
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "tt-app",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  /** The registered client, only if it was registered for this redirect URL (local vs cloud). */
  clientInformation() {
    const client = this.load().client as (OAuthClientInformationMixed & { redirect_uris?: string[] }) | undefined;
    return client?.redirect_uris && !client.redirect_uris.includes(this.redirectUrl) ? undefined : client;
  }
  saveClientInformation(client: OAuthClientInformationMixed) {
    this.save({ client });
  }
  tokens() {
    return this.load().tokens;
  }
  saveTokens(tokens: OAuthTokens) {
    this.save({ tokens });
    log("info", "mcp.oauth.tokens_saved", { expires_in: tokens.expires_in });
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
    this.onRedirect(url);
  }
  saveCodeVerifier(codeVerifier: string) {
    this.save({ codeVerifier });
  }
  codeVerifier() {
    const v = this.load().codeVerifier;
    if (!v) throw new Error("Missing PKCE code verifier; rerun `npm run auth:mcp`.");
    return v;
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    const s = this.load();
    if (scope === "all") writeSecret("mcp-oauth", {});
    else if (scope === "client") writeSecret("mcp-oauth", { ...s, client: undefined });
    else if (scope === "tokens") writeSecret("mcp-oauth", { ...s, tokens: undefined });
    else if (scope === "verifier") writeSecret("mcp-oauth", { ...s, codeVerifier: undefined });
  }
}

function waitForCallback(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(code ? "TikTok authorization received. You can close this tab." : `Authorization failed: ${error}`);
      server.close();
      code ? resolve(code) : reject(new Error(`OAuth error: ${error ?? "no code returned"}`));
    });
    server.listen(port, "127.0.0.1");
  });
}

/** Where TikTok sends the browser back: the hosted app when PUBLIC_URL is set, else a local port. */
export function oauthRedirectUrl(): string {
  const publicUrl = process.env.PUBLIC_URL?.replace(/\/$/, "");
  return publicUrl ? `${publicUrl}/oauth/callback` : `http://127.0.0.1:${Number(process.env.TIKTOK_MCP_OAUTH_PORT ?? 8765)}/callback`;
}

const mcpUrl = (url?: string) => new URL(url ?? process.env.TIKTOK_MCP_URL ?? DEFAULT_MCP_URL);

export async function connectMcp(opts: { url?: string; interactive?: boolean } = {}): Promise<Client> {
  const url = mcpUrl(opts.url);
  const authProvider = new FileOAuthProvider(oauthRedirectUrl());
  const client = new Client({ name: "tt-app", version: "0.1.0" });

  try {
    await client.connect(new StreamableHTTPClientTransport(url, { authProvider }));
  } catch (err) {
    if (!(err instanceof UnauthorizedError) || !opts.interactive) throw err;
    // Terminal flow: the SDK has printed the authorization URL; wait for the local callback.
    const port = Number(new URL(authProvider.redirectUrl).port);
    const code = await waitForCallback(port);
    await new StreamableHTTPClientTransport(url, { authProvider }).finishAuth(code);
    await client.connect(new StreamableHTTPClientTransport(url, { authProvider }));
  }
  log("info", "mcp.connected", { url: url.toString(), server: client.getServerVersion() });
  return client;
}

/**
 * Web flow, step 1: returns the TikTok approval URL to send the browser to,
 * or undefined if the saved authorization still works.
 */
export async function beginWebAuth(state: () => string, url?: string): Promise<URL | undefined> {
  const authProvider = new FileOAuthProvider(oauthRedirectUrl(), () => {}, state);
  const client = new Client({ name: "tt-app", version: "0.1.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(mcpUrl(url), { authProvider }));
    await client.close();
    return undefined;
  } catch (err) {
    if (err instanceof UnauthorizedError && authProvider.authorizationUrl) return authProvider.authorizationUrl;
    throw err;
  }
}

/** Web flow, step 2: exchanges the code TikTok returned for tokens. */
export async function finishWebAuth(code: string, url?: string): Promise<void> {
  const authProvider = new FileOAuthProvider(oauthRedirectUrl(), () => {});
  await new StreamableHTTPClientTransport(mcpUrl(url), { authProvider }).finishAuth(code);
  log("info", "mcp.oauth.web_connected", {});
}

/**
 * Calls an MCP tool and logs the full request and result. Callers declare
 * intent: a "write" call is logged and NOT sent unless writes are enabled,
 * and a "read" call is refused if the server marks the tool as mutating.
 */
export async function callMcpTool(client: Client, name: string, args: Record<string, unknown>, intent: "read" | "write") {
  if (intent === "read") {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`MCP server has no tool named ${name}`);
    if (tool.annotations?.readOnlyHint === false || tool.annotations?.destructiveHint === true) {
      throw new Error(`MCP tool ${name} is not read-only; call it with intent "write".`);
    }
  } else if (!writesEnabled()) {
    log("info", "mcp.dry_run", { tool: name, args });
    return { dryRun: true as const, tool: name, args };
  }
  log("info", "mcp.call", { tool: name, args });
  const result = await client.callTool({ name, arguments: args });
  log(result.isError ? "error" : "info", "mcp.result", { tool: name, result });
  return result;
}
