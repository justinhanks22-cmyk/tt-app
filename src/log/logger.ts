import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const logDir = () => process.env.TT_LOG_DIR ?? "logs";

// Keys whose values must never reach a log file.
const SECRET_KEYS = /^(access[-_]?token|refresh[-_]?token|secret|app_secret|client_secret|authorization|password|code_verifier)$/i;
// Partially masked: useful for debugging, but not fully exposed.
const PARTIAL_KEYS = /^(auth_code)$/i;

export function redact(value: unknown, key = ""): unknown {
  if (SECRET_KEYS.test(key)) return value == null ? value : "[REDACTED]";
  if (PARTIAL_KEYS.test(key) && typeof value === "string") {
    return value.length <= 6 ? "[REDACTED]" : `${value.slice(0, 3)}…${value.slice(-3)}`;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Append-only JSONL log. Every TikTok request/response is written in full
 * (minus secrets) so a rejection can be diagnosed from the exact payload.
 */
export function log(level: LogLevel, event: string, details: Record<string, unknown> = {}): void {
  const entry = { ts: new Date().toISOString(), level, event, ...(redact(details) as object) };
  try {
    mkdirSync(logDir(), { recursive: true });
    appendFileSync(join(logDir(), `${entry.ts.slice(0, 10)}.jsonl`), JSON.stringify(entry) + "\n");
  } catch {
    // Logging must never break a run; stderr still gets errors below.
  }
  if (level === "error" || level === "warn") console.error(`[${level}] ${event}`, JSON.stringify(redact(details)));
}
