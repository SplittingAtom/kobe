import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { SECURITY_HEADERS } from "./lib/security/csp";

const nextConfig: NextConfig = {
  output: "standalone",
  // Trace workspace dependencies from the monorepo root so the standalone bundle is complete.
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  transpilePackages: ["@kobe/protocol"],
  poweredByHeader: false,
  images: { unoptimized: true },
  // Every response, static assets and API routes included; the CSP is set per request (proxy.ts).
  async headers() {
    return [{ source: "/:path*", headers: [...SECURITY_HEADERS] }];
  },
};

export default nextConfig;
