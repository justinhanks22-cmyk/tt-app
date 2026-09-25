import { describe, expect, it } from "vitest";
import { SettingsSchema } from "../src/config/schema.js";

describe("settings defaults", () => {
  it("match the product-test defaults", () => {
    const s = SettingsSchema.parse({});
    expect(s.defaults).toMatchObject({ dailyBudget: 50, optimizationEvent: "ON_WEB_CART", locationIds: ["6252001"], oneAdPerCreative: true });
  });
  it("rejects a display card with neither price nor offer", () => {
    expect(() => SettingsSchema.parse({ displayCards: [{ advertiserId: "1", cardId: "c", label: "x" }] })).toThrow();
  });
});
