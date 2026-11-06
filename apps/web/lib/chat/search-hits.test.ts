import { describe, expect, it } from "vitest";
import { SEARCH_HIT_TTL_MS, SearchHitStore } from "./search-hits";

describe("pending search hits (CT15, KOBE-544 review)", () => {
  it("a hit waits for its thread once", () => {
    const hits = new SearchHitStore(() => 0);
    hits.open("t1", "e1");
    expect(hits.take("t1")).toBe("e1");
    expect(hits.take("t1")).toBeUndefined();
  });

  it("acquiring another thread drops the waiting hit", () => {
    const hits = new SearchHitStore(() => 0);
    hits.open("t1", "e1");
    expect(hits.take("t2")).toBeUndefined();
    expect(hits.take("t1")).toBeUndefined();
  });

  it("a hit older than the deadline is dropped", () => {
    let now = 0;
    const hits = new SearchHitStore(() => now);
    hits.open("t1", "e1");
    now = SEARCH_HIT_TTL_MS + 1;
    expect(hits.take("t1")).toBeUndefined();
  });
});
