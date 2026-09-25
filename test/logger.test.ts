import { describe, expect, it } from "vitest";
import { redact } from "../src/log/logger.js";

describe("redact", () => {
  it("masks secrets at any depth and partially masks auth codes", () => {
    const out = redact({
      secret: "abc",
      nested: { "Access-Token": "t", list: [{ access_token: "t2" }] },
      auth_code: "abcdef123456",
      campaign_name: "keep me",
    });
    expect(out).toEqual({
      secret: "[REDACTED]",
      nested: { "Access-Token": "[REDACTED]", list: [{ access_token: "[REDACTED]" }] },
      auth_code: "abc…456",
      campaign_name: "keep me",
    });
  });
});
