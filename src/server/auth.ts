import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readSecret, writeSecret } from "../config/secrets.js";

/**
 * Security for the hosted app. The app can spend money on the ad account, so
 * every page and API needs a login, and the only unauthenticated URLs are
 * short-lived, signed media links that TikTok's servers fetch when uploading.
 */

/** Server signing key: SESSION_SECRET, or a random one kept in the secrets dir. */
function serverKey(): Buffer {
  if (process.env.SESSION_SECRET) return Buffer.from(process.env.SESSION_SECRET);
  let stored = readSecret<{ key: string }>("server-key");
  if (!stored) {
    stored = { key: randomBytes(32).toString("hex") };
    writeSecret("server-key", stored);
  }
  return Buffer.from(stored.key, "hex");
}

const hmac = (data: string) => createHmac("sha256", serverKey()).update(data).digest("base64url");

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function passwordMatches(input: string, expected = process.env.APP_PASSWORD ?? ""): boolean {
  return expected.length > 0 && safeEqual(input, expected);
}

export const SESSION_COOKIE = "tt_session";
const SESSION_TTL_MS = 7 * 24 * 3600_000;

export function newSession(now = Date.now()): string {
  const exp = String(now + SESSION_TTL_MS);
  return `${exp}.${hmac(`session:${exp}`)}`;
}

export function sessionValid(token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) < now) return false;
  return safeEqual(sig, hmac(`session:${exp}`));
}

export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** A link TikTok can fetch without logging in, valid for `ttlSec`. */
export function signMediaPath(relPath: string, ttlSec = 3600, now = Date.now()): string {
  const exp = String(Math.floor(now / 1000) + ttlSec);
  return `/public-media/${relPath.split("/").map(encodeURIComponent).join("/")}?exp=${exp}&sig=${hmac(`media:${relPath}:${exp}`)}`;
}

export function mediaSignatureValid(relPath: string, exp: string | null, sig: string | null, now = Date.now()): boolean {
  if (!exp || !sig || Number(exp) * 1000 < now) return false;
  return safeEqual(sig, hmac(`media:${relPath}:${exp}`));
}

/** OAuth `state` for the Connect TikTok flow, tied to this server's key. */
export function newOAuthState(now = Date.now()): string {
  const t = String(now);
  return `${t}.${hmac(`oauth:${t}`)}`;
}

export function oauthStateValid(state: string | null, now = Date.now()): boolean {
  const [t, sig] = (state ?? "").split(".");
  if (!t || !sig || now - Number(t) > 15 * 60_000) return false;
  return safeEqual(sig, hmac(`oauth:${t}`));
}
