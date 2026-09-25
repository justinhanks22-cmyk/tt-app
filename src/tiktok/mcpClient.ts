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
  constructor(private readonly port: number) {}

  private load(): StoredMcpAuth {
    return readSecret<StoredMcpAuth>("mcp-oauth") ?? {};
  }
  private save(patch: Partial<StoredMcpAuth>): void {
    writeSecret("mcp-oauth", { ...this.load(), ...patch });
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}/callback`;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "tt-app (local)",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation() {
    return this.load().client;
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
    console.log(`\nOpen this URL in your browser and approve access to your TikTok for Business account:\n\n  ${url}\n`);
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

export async function connectMcp(opts: { url?: string; port?: number; interactive?: boolean } = {}): Promise<Client> {
  const url = new URL(opts.url ?? process.env.TIKTOK_MCP_URL ?? DEFAULT_MCP_URL);
  const port = opts.port ?? Number(process.env.TIKTOK_MCP_OAUTH_PORT ?? 8765);
  const authProvider = new FileOAuthProvider(port);
  const client = new Client({ name: "tt-app", version: "0.1.0" });

  const attempt = () => client.connect(new StreamableHTTPClientTransport(url, { authProvider }));
  try {
    await attempt();
  } catch (err) {
    if (!(err instanceof UnauthorizedError) || !opts.interactive) throw err;
    // The SDK has printed the authorization URL via redirectToAuthorization.
    const transport = new StreamableHTTPClientTransport(url, { authProvider });
    const code = await waitForCallback(port);
    await transport.finishAuth(code);
    await client.connect(new StreamableHTTPClientTransport(url, { authProvider }));
  }
  log("info", "mcp.connected", { url: url.toString(), server: client.getServerVersion() });
  return client;
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
