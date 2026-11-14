import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SemanticMemoryKind } from "@kobe/protocol";
import type { Candidate, SelectLane } from "../../memory/items/select.js";
import {
  cacheShares,
  formatRelevanceReport,
  parseRelevanceSet,
  rankCandidates,
  recallAtK,
  scoreQuery,
  summarise,
  type RelevanceQuery,
} from "./score.js";

/** KOBE-387: the eval harness's scoring, without a database. */

const cand = (
  id: string,
  parts: Partial<Omit<Candidate, "item">> & { kind?: SemanticMemoryKind; pinned?: boolean } = {},
): Candidate => ({
  item: {
    id,
    version: 1,
    scope: "team",
    kind: parts.kind ?? "fact",
    statement: id,
    policy: false,
    pinned: parts.pinned ?? false,
    provenance: { actor_kind: "user", as_of: null, saved_on: "2026-11-01" },
  },
  matched: parts.matched ?? true,
  textRank: parts.textRank ?? 0,
  trigram: parts.trigram ?? 0,
  ageDays: parts.ageDays ?? 1000,
  sticky: parts.sticky ?? false,
});

const query = (q: Partial<RelevanceQuery> & { id: string }): RelevanceQuery => ({
  kind: "fact",
  style: "literal",
  query: "x",
  expected: ["a"],
  ...q,
});

describe("recallAtK", () => {
  it("counts expected items in the first k", () => {
    expect(recallAtK(["a", "b", "c"], ["a"], 1)).toBe(1);
    expect(recallAtK(["a", "b", "c"], ["c"], 2)).toBe(0);
    expect(recallAtK(["a", "b", "c"], ["a", "c", "z"], 3)).toBeCloseTo(2 / 3);
    expect(recallAtK([], ["a"], 8)).toBe(0);
    expect(recallAtK(["a"], [], 8)).toBe(0);
  });
});

describe("rankCandidates", () => {
  const lanes: Partial<Record<SelectLane, Candidate[]>> = {
    user: [
      // An unmatched preference: eligible in a person lane, gets the 0.5 base in selector order.
      cand("pref", { kind: "preference", matched: false, textRank: 0 }),
      // Not matched, not a preference, not pinned: never a candidate.
      cand("unmatched", { matched: false, textRank: 0.9 }),
    ],
    team: [
      cand("strong", { textRank: 0.3 }),
      cand("weak", { textRank: 0.05, trigram: 0.1 }),
      cand("pinned", { pinned: true, textRank: 0 }),
      cand("sticky", { textRank: 0.05, sticky: true }),
    ],
  };

  it("relevance order: pinned, then ts_rank_cd + 0.3 trigram + 0.1 recency, no base or bonus", () => {
    expect(rankCandidates(lanes, "relevance")).toEqual([
      "pinned",
      "strong",
      "weak",
      "sticky",
      "pref",
    ]);
  });

  it("selector order adds the preference base and stickiness", () => {
    expect(rankCandidates(lanes, "selector")).toEqual([
      "pinned",
      "pref",
      "strong",
      "sticky",
      "weak",
    ]);
  });

  it("recency counts: a fresh item outranks an equal old one; ties break by id", () => {
    const t = {
      team: [cand("old", { textRank: 0.1 }), cand("new", { textRank: 0.1, ageDays: 0 })],
    };
    expect(rankCandidates(t, "relevance")).toEqual(["new", "old"]);
    const tie = { team: [cand("b", { textRank: 0.1 }), cand("a", { textRank: 0.1 })] };
    expect(rankCandidates(tie, "relevance")).toEqual(["a", "b"]);
  });
});

describe("scoreQuery and summarise", () => {
  const ranked = (relevance: string[], selector = relevance) => ({ relevance, selector });

  it("scores recall per mode, block membership and hard negatives", () => {
    const q = query({ id: "q001", expected: ["a", "b"], negatives: ["n"] });
    const r = scoreQuery(q, ranked(["n", "a", "x"], ["x", "y"]), new Set(["a", "b"]), 2);
    expect(r.recall).toEqual({ relevance: 0.5, selector: 0 });
    expect(r.inBlock).toBe(1);
    expect(r.negativeAbove).toBe(true);
    expect(r.ranks).toEqual([2, null]);
  });

  it("a negative below the answer, or past k, does not count", () => {
    const q = query({ id: "q001", negatives: ["n"] });
    expect(scoreQuery(q, ranked(["a", "n"]), new Set(), 8).negativeAbove).toBe(false);
    expect(scoreQuery(q, ranked(["x", "y", "n"]), new Set(), 2).negativeAbove).toBe(false);
    // The answer is missing and a negative is in the top k: it counts.
    expect(scoreQuery(q, ranked(["n"]), new Set(), 8).negativeAbove).toBe(true);
  });

  it("macro-averages overall, per kind and per style, and applies the 0.85 line", () => {
    const q1 = query({ id: "q001", kind: "fact", style: "literal" });
    const q2 = query({ id: "q002", kind: "fact", style: "paraphrase", negatives: ["n"] });
    const q3 = query({ id: "q003", kind: "decision", style: "paraphrase", expected: ["a", "b"] });
    const qs = [q1, q2, q3];
    const results = [
      scoreQuery(q1, ranked(["a"]), new Set(["a"])),
      scoreQuery(q2, ranked(["n", "z"]), new Set()),
      scoreQuery(q3, ranked(["a"]), new Set()),
    ];
    const report = summarise(results, qs);
    expect(report.overall.queries).toBe(3);
    expect(report.overall.relevance).toBeCloseTo((1 + 0 + 0.5) / 3);
    expect(report.byKind.fact.relevance).toBe(0.5);
    expect(report.byKind.decision.relevance).toBe(0.5);
    expect(report.byKind.preference.queries).toBe(0);
    expect(report.byStyle.paraphrase.relevance).toBe(0.25);
    expect(report.overall.negativeAbove).toBe(1);
    expect(report.byKind.decision.negativeAbove).toBeNull();
    expect(report.vectorsIndicated).toBe(true);
    expect(formatRelevanceReport(report)).toContain("Phase D vectors indicated");
    const perfect = summarise([scoreQuery(q1, ranked(["a"]), new Set())], qs);
    expect(perfect.vectorsIndicated).toBe(false);
  });
});

describe("parseRelevanceSet", () => {
  const items = {
    items: [
      { id: "a", scope: "team", kind: "fact", statement: "A", age_days: 1 },
      { id: "p", scope: "portable", kind: "preference", statement: "P", age_days: 1 },
    ],
  };

  it("accepts a consistent set", () => {
    const set = parseRelevanceSet(items, { queries: [query({ id: "q001", expected: ["a"] })] });
    expect(set.queries).toHaveLength(1);
  });

  it("lists every inconsistency", () => {
    const bad = {
      queries: [
        query({ id: "q001", expected: ["zz"] }),
        query({ id: "q002", expected: ["a"], negatives: ["a"] }),
        query({ id: "q003", kind: "decision", expected: ["a"] }),
        query({ id: "q003", expected: ["a"] }),
      ],
    };
    expect(() => parseRelevanceSet(items, bad)).toThrow(
      /duplicate query ids.*q001: unknown item zz.*q002: an item is both.*q003: kind decision/,
    );
    const portableFact = { items: [{ ...items.items[1], kind: "fact" }] };
    expect(() =>
      parseRelevanceSet(portableFact, { queries: [query({ id: "q001", expected: ["p"] })] }),
    ).toThrow(/p: portable items are preferences/);
  });

  it("the committed fixtures parse: ~150 queries, 30+ per kind, every kind and style present", () => {
    const dir = new URL("../../../../../e2e/fixtures/memory-relevance/", import.meta.url);
    const read = (f: string): unknown => JSON.parse(readFileSync(new URL(f, dir), "utf8"));
    const set = parseRelevanceSet(read("items.json"), read("queries.json"));
    expect(set.queries.length).toBeGreaterThanOrEqual(150);
    for (const kind of ["preference", "fact", "convention", "definition", "decision"]) {
      expect(set.queries.filter((q) => q.kind === kind).length).toBeGreaterThanOrEqual(30);
    }
    for (const style of ["literal", "paraphrase", "indirect"]) {
      expect(set.queries.some((q) => q.style === style)).toBe(true);
    }
  });
});

describe("cacheShares", () => {
  const u = (run_id: string, input: number, read: number, write = 0) => ({
    run_id,
    calls: 1,
    input_tokens: input,
    cache_read_tokens: read,
    cache_write_tokens: write,
  });

  it("shares over all turns and over turns 2..n, the gate-7a.md prompt definition", () => {
    const usage = [
      u("r1", 1000, 0, 4000),
      u("r2", 200, 4800),
      u("r3", 300, 4700),
      u("other", 1, 999),
    ];
    const s = cacheShares(usage, ["r1", "r2", "r3"]);
    expect(s.all.prompt).toBe(5000 + 5000 + 5000);
    expect(s.all.cacheRead).toBe(9500);
    expect(s.all.share).toBeCloseTo(9500 / 15000);
    expect(s.afterFirst.runs).toBe(2);
    expect(s.afterFirst.share).toBeCloseTo(9500 / 10000);
    expect(s.missing).toEqual([]);
  });

  it("names turns without usage and returns null share for no tokens", () => {
    const s = cacheShares([], ["r1"]);
    expect(s.missing).toEqual(["r1"]);
    expect(s.all.share).toBeNull();
  });
});
