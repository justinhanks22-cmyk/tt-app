/**
 * Same-origin proxy from the browser to the FastAPI service.
 *
 * - The API can stay on a private network; only this Next.js server is public.
 * - Only known API routes are forwarded (no open proxy).
 * - The real client IP is passed in X-Client-IP together with a shared secret, so the API's
 *   rate limits apply per user rather than to this proxy.
 * - Download bodies are streamed through; S3 presigned redirects are passed through as-is.
 */
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const API_URL = (process.env.API_INTERNAL_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const PROXY_TOKEN = process.env.INTERNAL_PROXY_TOKEN ?? "";
// Number of reverse proxies (Caddy, nginx, a load balancer...) in front of this server.
// Next.js keeps a client-supplied X-Forwarded-For as-is, so run behind at least one proxy that
// sets/overwrites it (the bundled Caddy does); otherwise clients could spoof their IP.
const TRUSTED_PROXY_HOPS = Math.max(1, Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "1", 10) || 1);
const MAX_BODY_BYTES = 8 * 1024;

const ALLOWED = [
  { method: "POST", pattern: /^jobs$/ },
  { method: "GET", pattern: /^jobs\/[0-9a-f]{32}$/ },
  { method: "GET", pattern: /^history$/ },
  { method: "GET", pattern: /^config$/ },
  { method: "GET", pattern: /^download\/[0-9a-f]{32}$/ },
  { method: "HEAD", pattern: /^download\/[0-9a-f]{32}$/ },
];
const REQUEST_HEADERS = ["content-type", "cookie", "range", "if-range", "accept"];
const RESPONSE_HEADERS = [
  "content-type", "content-length", "content-disposition", "content-range", "accept-ranges",
  "location", "cache-control", "retry-after", "x-robots-tag", "last-modified", "etag",
];

function clientIp(req: NextRequest): string {
  // Each trusted proxy appends the address it received the request from, so the entry
  // TRUSTED_PROXY_HOPS from the right is the client as seen by our outermost proxy. Anything
  // further left was supplied by the client and is ignored. (With no header at all, Next.js
  // fills in the socket address.)
  const chain = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ip = chain[chain.length - TRUSTED_PROXY_HOPS] ?? chain[0] ?? "unknown";
  return ip.replace(/^::ffff:/, "").slice(0, 64);
}

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status });
}

async function proxy(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const subpath = path.join("/");
  if (!ALLOWED.some((r) => r.method === req.method && r.pattern.test(subpath))) {
    return jsonError(404, "not_found", "Not found.");
  }

  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-client-ip", clientIp(req));
  if (PROXY_TOKEN) headers.set("x-internal-proxy-token", PROXY_TOKEN);

  let body: string | undefined;
  if (req.method === "POST") {
    body = await req.text();
    if (body.length > MAX_BODY_BYTES) return jsonError(413, "invalid_request", "Request too large.");
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/api/${subpath}${req.nextUrl.search}`, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    return jsonError(502, "server_unavailable", "The download service is unavailable. Please try again shortly.");
  }

  const out = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  for (const cookie of upstream.headers.getSetCookie()) out.append("set-cookie", cookie);
  return new Response(req.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: out });
}

export { proxy as GET, proxy as POST, proxy as HEAD };
