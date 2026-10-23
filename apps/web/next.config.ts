import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { consoleRedirects } from "./lib/admin/nav/paths";
import { resolveBuildId } from "./lib/build/build-id";
import { SECURITY_HEADERS } from "./lib/security/csp";
import { skillEditorRedirects } from "./lib/skills/redirects";

// KOBE-487: one id per build. Set back into the environment so build workers that load this file
// again agree; inlined into client and server code as process.env.KOBE_BUILD_ID (lib/build).
const buildId = resolveBuildId(process.env);
process.env.KOBE_BUILD_ID = buildId;

const nextConfig: NextConfig = {
  output: "standalone",
  // Trace workspace dependencies from the monorepo root so the standalone bundle is complete.
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  transpilePackages: ["@kobe/protocol"],
  poweredByHeader: false,
  env: { KOBE_BUILD_ID: buildId },
  generateBuildId: () => buildId,
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
