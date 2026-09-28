import path from "node:path";
import type { NextConfig } from "next";

// Pin the project root (this repo has another package-lock.json higher up).
const root = path.resolve(__dirname);

const nextConfig: NextConfig = {
  output: "standalone", // small self-contained server for the Docker image
  poweredByHeader: false,
  outputFileTracingRoot: root,
  turbopack: { root },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
