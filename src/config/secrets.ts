import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Local, gitignored, owner-only token storage. Secrets never live in source or settings.json.
const secretsDir = () => process.env.TT_SECRETS_DIR ?? ".secrets";

export function readSecret<T>(name: string): T | undefined {
  const file = join(secretsDir(), `${name}.json`);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export function writeSecret(name: string, value: unknown): void {
  mkdirSync(secretsDir(), { recursive: true, mode: 0o700 });
  const file = join(secretsDir(), `${name}.json`);
  writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Marketing API access token: env var wins, then the token saved by `auth:api`. */
export function marketingApiToken(): string | undefined {
  return process.env.TIKTOK_ACCESS_TOKEN || readSecret<{ access_token: string }>("marketing-api")?.access_token;
}
