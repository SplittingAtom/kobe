import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { percentile, summarize } from "./stats.ts";

describe("percentile (nearest rank)", () => {
  it("picks the ranked sample", () => {
    const sorted = Array.from({ length: 20 }, (_, i) => i + 1);
    assert.equal(percentile(sorted, 50), 10);
    assert.equal(percentile(sorted, 95), 19);
    assert.equal(percentile(sorted, 99), 20);
    assert.equal(percentile([7], 95), 7);
    assert.ok(Number.isNaN(percentile([], 50)));
  });
});

describe("summarize", () => {
  it("sorts, skips missing samples and counts what it used", () => {
    assert.deepEqual(summarize([30, undefined, 10, 20, Number.NaN]), { n: 3, p50: 20, p95: 30 });
    assert.deepEqual(summarize([]), { n: 0, p50: Number.NaN, p95: Number.NaN });
  });
});
