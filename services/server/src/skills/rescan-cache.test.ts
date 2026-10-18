import { RULE_SET_VERSION, type ScanResult } from "@kobe/skill-scanner";
import { describe, expect, it } from "vitest";
import { ScanCache } from "./rescan-cache.js";

/** KOBE-313 review B-S3: the rescan's scan cache is bounded by bytes, least recently used first. */
const result = (excerpt: string): ScanResult => ({
  verdict: "caution",
  ruleSetVersion: RULE_SET_VERSION,
  scripts: [],
  skipped: [],
  findings: [
    {
      category: "network",
      rule: "curl-wget",
      file: "run.sh",
      line: 1,
      excerpt,
      severity: "caution",
    },
  ],
});

describe("rescan scan cache", () => {
  it("evicts the least recently used entries past its byte bound", () => {
    const cache = new ScanCache(3000);
    cache.set("a", result("x".repeat(400)));
    cache.set("b", result("x".repeat(400)));
    expect(cache.get("a")).toBeDefined(); // a is now the most recent
    cache.set("c", result("x".repeat(400)));
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
    expect(cache.size).toBeLessThanOrEqual(3000);
  });

  it("never holds an entry larger than the bound", () => {
    const cache = new ScanCache(100);
    cache.set("big", result("x".repeat(1000)));
    expect(cache.get("big")).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});
