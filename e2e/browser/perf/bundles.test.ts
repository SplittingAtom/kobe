import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bundleSizes, parseRouteBundleStats } from "./bundles.ts";

const stats = [
  {
    route: "/threads",
    firstLoadUncompressedJsBytes: 3000,
    firstLoadChunkPaths: [".next/static/chunks/a.js", ".next/static/chunks/b.js"],
  },
  {
    route: "/",
    firstLoadUncompressedJsBytes: 1000,
    firstLoadChunkPaths: [".next/static/chunks/a.js"],
  },
];

describe("parseRouteBundleStats", () => {
  it("reads Next's diagnostics/route-bundle-stats.json", () => {
    assert.deepEqual(parseRouteBundleStats(stats), [
      {
        route: "/threads",
        rawBytes: 3000,
        chunks: [".next/static/chunks/a.js", ".next/static/chunks/b.js"],
      },
      { route: "/", rawBytes: 1000, chunks: [".next/static/chunks/a.js"] },
    ]);
  });

  it("refuses anything that is not that file's shape", () => {
    assert.throws(() => parseRouteBundleStats({}), /route-bundle-stats/);
    assert.throws(() => parseRouteBundleStats([{ route: 3 }]), /route-bundle-stats/);
  });
});

describe("bundleSizes", () => {
  it("adds each route's gzipped first-load JS from its chunks", () => {
    const gz: Record<string, number> = {
      ".next/static/chunks/a.js": 100,
      ".next/static/chunks/b.js": 50,
    };
    const sizes = bundleSizes(parseRouteBundleStats(stats), (p) => gz[p]);
    assert.deepEqual(sizes, {
      "/threads": { rawBytes: 3000, gzipBytes: 150 },
      "/": { rawBytes: 1000, gzipBytes: 100 },
    });
  });

  it("leaves the gzip size out when a chunk is missing", () => {
    const sizes = bundleSizes(parseRouteBundleStats(stats), () => undefined);
    assert.deepEqual(sizes["/"], { rawBytes: 1000 });
  });
});
