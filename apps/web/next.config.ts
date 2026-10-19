import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { consoleRedirects } from "./lib/admin/nav/paths";
import { SECURITY_HEADERS } from "./lib/security/csp";
import { skillEditorRedirects } from "./lib/skills/redirects";

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
  // KOBE-257: the install console became the Site console; old /admin/install links and bookmarks still land.
  // KOBE-321: the old skill editors' links land on the Skills page.
  async redirects() {
    return [...consoleRedirects(), ...skillEditorRedirects()];
  },
};

export default nextConfig;
