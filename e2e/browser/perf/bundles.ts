import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/**
 * Per-route first-load JS from `next build` (KOBE-525): Next 16 writes
 * `.next/diagnostics/route-bundle-stats.json` (route, uncompressed first-load bytes, chunk paths
 * relative to the app directory); the gzip size is computed here from the chunks.
 */
export interface RouteBundle {
  readonly route: string;
  readonly rawBytes: number;
  readonly chunks: readonly string[];
}

export interface BundleSize {
  readonly rawBytes: number;
  readonly gzipBytes?: number;
}

const SHAPE =
  "not a route-bundle-stats.json (expected [{route, firstLoadUncompressedJsBytes, firstLoadChunkPaths}])";

export function parseRouteBundleStats(json: unknown): RouteBundle[] {
  if (!Array.isArray(json)) throw new Error(SHAPE);
  return json.map((entry: unknown) => {
    const e = entry as Record<string, unknown>;
    const chunks = e["firstLoadChunkPaths"];
    if (
      typeof e["route"] !== "string" ||
      typeof e["firstLoadUncompressedJsBytes"] !== "number" ||
      !Array.isArray(chunks) ||
      !chunks.every((c) => typeof c === "string")
    ) {
      throw new Error(SHAPE);
    }
    return { route: e["route"], rawBytes: e["firstLoadUncompressedJsBytes"], chunks };
  });
}

/** Sizes by route; `gzipOf` answers a chunk's gzipped size (undefined: missing). */
export function bundleSizes(
  bundles: readonly RouteBundle[],
  gzipOf: (chunk: string) => number | undefined,
): Record<string, BundleSize> {
  const out: Record<string, BundleSize> = {};
  for (const b of bundles) {
    const sizes = b.chunks.map(gzipOf);
    const complete = sizes.every((s): s is number => s !== undefined);
    out[b.route] = complete
      ? { rawBytes: b.rawBytes, gzipBytes: sizes.reduce((a, s) => a + s, 0) }
      : { rawBytes: b.rawBytes };
  }
  return out;
}

/** Reads a built app (`apps/web` after `next build`). */
export function readBundleSizes(appDir: string): Record<string, BundleSize> {
  const stats = JSON.parse(
    readFileSync(join(appDir, ".next/diagnostics/route-bundle-stats.json"), "utf8"),
  ) as unknown;
  const cache = new Map<string, number | undefined>();
  const gzipOf = (chunk: string) => {
    if (!cache.has(chunk)) {
      try {
        cache.set(chunk, gzipSync(readFileSync(join(appDir, chunk))).length);
      } catch {
        cache.set(chunk, undefined);
      }
    }
    return cache.get(chunk);
  };
  return bundleSizes(parseRouteBundleStats(stats), gzipOf);
}
