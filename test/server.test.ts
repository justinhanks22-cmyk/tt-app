import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  mediaSignatureValid, newOAuthState, newSession, oauthStateValid, passwordMatches, sessionValid, signMediaPath,
} from "../src/server/auth.js";

const secretsDir = mkdtempSync(join(tmpdir(), "tt-secrets-"));
process.env.TT_SECRETS_DIR = secretsDir;

describe("auth helpers", () => {
  it("password: exact match only, never with an empty configured password", () => {
    expect(passwordMatches("correct horse battery", "correct horse battery")).toBe(true);
    expect(passwordMatches("correct horse batter", "correct horse battery")).toBe(false);
    expect(passwordMatches("", "")).toBe(false);
  });

  it("sessions are signed and expire", () => {
    const now = Date.now();
    const s = newSession(now);
    expect(sessionValid(s, now)).toBe(true);
    expect(sessionValid(s.replace(/.$/, (c) => (c === "A" ? "B" : "A")), now)).toBe(false);
    expect(sessionValid(s, now + 8 * 24 * 3600_000)).toBe(false);
  });

  it("media links are bound to the file and expire", () => {
    const now = Date.now();
    const u = new URL(`https://x${signMediaPath("cards/poncho-29.png", 3600, now)}`);
    const [exp, sig] = [u.searchParams.get("exp"), u.searchParams.get("sig")];
    expect(mediaSignatureValid("cards/poncho-29.png", exp, sig, now)).toBe(true);
    expect(mediaSignatureValid("cards/other.png", exp, sig, now)).toBe(false);
    expect(mediaSignatureValid("cards/poncho-29.png", exp, sig, now + 2 * 3600_000)).toBe(false);
  });

  it("OAuth state is signed and short-lived", () => {
    const now = Date.now();
    expect(oauthStateValid(newOAuthState(now), now)).toBe(true);
    expect(oauthStateValid("123.forged", now)).toBe(false);
    expect(oauthStateValid(newOAuthState(now), now + 16 * 60_000)).toBe(false);
  });
});

describe("server", () => {
  const PORT = 5199;
  const base = `http://127.0.0.1:${PORT}`;
  const dataDir = mkdtempSync(join(tmpdir(), "tt-data-"));
  const env = {
    ...process.env, PORT: String(PORT), APP_PASSWORD: "a-long-test-password", TT_SECRETS_DIR: join(dataDir, "secrets"),
    TT_SETTINGS_PATH: join(dataDir, "config/settings.json"), TT_LOG_DIR: join(dataDir, "logs"),
  };
  let proc: ChildProcess;

  beforeAll(async () => {
    mkdirSync(join(dataDir, "media/cards"), { recursive: true });
    writeFileSync(join(dataDir, "media/cards/c.png"), Buffer.from("png"));
    proc = spawn(resolve("node_modules/.bin/tsx"), [resolve("src/server/index.ts"), "--demo", resolve("test/fixtures/poncho-live.json")], { cwd: dataDir, env });
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(`${base}/healthz`);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  });
  afterAll(() => proc?.kill());

  const login = async (password: string) =>
    fetch(`${base}/login`, { method: "POST", body: new URLSearchParams({ password }), redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" } });

  it("sends signed-out visitors to the login page and API calls get 401", async () => {
    const page = await fetch(`${base}/`, { redirect: "manual" });
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe("/login");
    expect((await fetch(`${base}/api/options`)).status).toBe(401);
  });

  it("logs in with the right password, seeds settings on a fresh data dir", async () => {
    expect((await login("wrong")).status).toBe(401);
    const ok = await login("a-long-test-password");
    expect(ok.status).toBe(303);
    const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
    expect(ok.headers.get("set-cookie")).toMatch(/HttpOnly/);
    const opts = await (await fetch(`${base}/api/options`, { headers: { cookie } })).json();
    expect(opts.advertisers[0].advertiserId).toBe("7360920068810702864");
    expect(opts.hosted).toBe(true);

    // State-changing API calls need the page's header (blocks cross-site form posts).
    const noHeader = await fetch(`${base}/api/prepare`, { method: "POST", headers: { cookie }, body: "{}" });
    expect(noHeader.status).toBe(403);
  });

  it("serves media to TikTok only through valid signed links", async () => {
    const bad = await fetch(`${base}/public-media/cards/c.png?exp=9999999999&sig=forged`);
    expect(bad.status).toBe(403);
    process.env.TT_SECRETS_DIR = env.TT_SECRETS_DIR; // same signing key as the server
    const good = await fetch(`${base}${signMediaPath("cards/c.png")}`);
    expect(good.status).toBe(200);
    expect(good.headers.get("content-type")).toBe("image/png");
    // A validly signed link to a file outside media/ (encoded so the URL isn't normalized) is still refused.
    const signed = new URL(`http://x${signMediaPath("../secrets/server-key.json")}`);
    const escape = await fetch(`${base}/public-media/${encodeURIComponent("../secrets/server-key.json")}${signed.search}`, { redirect: "manual" });
    expect(escape.status).toBe(404);
  });

  it("locks out after repeated wrong passwords", async () => {
    for (let i = 0; i < 5; i++) await login("nope");
    expect((await login("a-long-test-password")).status).toBe(429);
  });
});

describe("hosting guard", () => {
  it("refuses to listen publicly without a password and https address", () => {
    const r = spawnSync(resolve("node_modules/.bin/tsx"), [resolve("src/server/index.ts")], {
      env: { ...process.env, HOST: "0.0.0.0", PORT: "5198", APP_PASSWORD: "", PUBLIC_URL: "" }, encoding: "utf8", timeout: 20000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Refusing to listen.*APP_PASSWORD.*PUBLIC_URL/);
  });
});
