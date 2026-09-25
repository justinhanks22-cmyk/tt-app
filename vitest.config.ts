import { defineConfig } from "vitest/config";

// Video tests encode real clips with ffmpeg, which can exceed the 5s default.
export default defineConfig({ test: { testTimeout: 30_000 } });
