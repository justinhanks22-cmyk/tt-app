import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SettingsSchema, type Settings } from "./schema.js";

export const SETTINGS_PATH = process.env.TT_SETTINGS_PATH ?? "config/settings.json";

export function loadSettings(path = SETTINGS_PATH): Settings {
  const raw = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  return SettingsSchema.parse(raw);
}

export function saveSettings(settings: Settings, path = SETTINGS_PATH): void {
  const valid = SettingsSchema.parse(settings);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(valid, null, 2) + "\n");
}
