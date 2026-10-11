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
  // KOBE-257: the install console is the Site console; old links and bookmarks still land.
  async redirects() {
    return [
      { source: "/admin/install", destination: "/admin/site", permanent: true },
      { source: "/admin/install/:path*", destination: "/admin/site/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
