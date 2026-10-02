import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Trace workspace dependencies from the monorepo root so the standalone bundle is complete.
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  transpilePackages: ["@kobe/protocol"],
  poweredByHeader: false,
  images: { unoptimized: true },
};

export default nextConfig;
