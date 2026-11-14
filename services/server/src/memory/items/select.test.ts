import { describe, expect, it } from "vitest";
import {
  SEMANTIC_MEMORY_BLOCK_DEFAULT_BYTES,
  SEMANTIC_MEMORY_BLOCK_MIN_BYTES,
  runSemanticMemorySchema,
  semanticMemoryRenderedBytes,
  type RunSemanticMemoryItem,
  type SemanticMemoryKind,
  type SemanticMemoryScope,
} from "@kobe/protocol";
import {
  LANE_FLOOR_BYTES,
  RENDER_LANES,
  PREFERENCE_BASE,
  STICKY_BONUS,
  memoryScore,
  selectRunMemory,
  type Candidate,
  type SelectLane,
} from "./select.js";

/** KOBE-382 ac-1: the selector without the database. */
let n = 0;
const uuid = (k: number) => `00000000-0000-4000-8000-${String(k).padStart(12, "0")}`;

function item(
  scope: SemanticMemoryScope,
  opts: {
    id?: number;
    kind?: SemanticMemoryKind;
    pinned?: boolean;
    policy?: boolean;
    bytes?: number;
    text?: string;
  } = {},
): RunSemanticMemoryItem {
  const id = opts.id ?? ++n + 1000;
  const statement = opts.text ?? `s${id} `.padEnd(opts.bytes ?? 40, "x");
  return {
    id: uuid(id),
    version: 1,
    scope,
    kind: opts.kind ?? (scope === "portable" ? "preference" : "fact"),
    statement,
    policy: opts.policy ?? false,
    pinned: opts.pinned ?? false,
    provenance: { actor_kind: "user", as_of: null, saved_on: "2026-11-01" },
  };
}

function cand(i: RunSemanticMemoryItem, parts: Partial<Omit<Candidate, "item">> = {}): Candidate {
  const full = { textRank: 0.1, trigram: 0, ageDays: 0, sticky: false, ...parts };
  return { item: i, matched: full.textRank > 0, ...full };
}

const ids = (items: readonly RunSemanticMemoryItem[]) => items.map((i) => i.id);
const budget = SEMANTIC_MEMORY_BLOCK_DEFAULT_BYTES;

describe("selectRunMemory", () => {
  it("puts every Policy item first, whatever the lanes hold", () => {
    const p1 = item("site", { id: 9, policy: true });
    const p2 = item("site", { id: 2, policy: true });
    const pin = item("team", { id: 1, pinned: true });
    const s = selectRunMemory({
      policy: [p1, p2],
      lanes: { team: [cand(pin, { textRank: 5 })] },
      budgetBytes: budget,
    });
    expect(ids(s.items)).toEqual([p2.id, p1.id, pin.id]);
    expect(runSemanticMemorySchema.safeParse(s).success).toBe(true);
  });

  it("takes Policy before the lanes, and never past the budget (L5)", () => {
    const policy = Array.from({ length: 25 }, (_, k) =>
      item("site", { id: 100 + k, policy: true, bytes: 80 }),
    );
    const lanes = { user: [cand(item("user", { bytes: 400 }))] };
    const roomy = selectRunMemory({ policy, lanes, budgetBytes: budget });
    expect(roomy.items.filter((i) => i.policy)).toHaveLength(25);
    // At the smallest budget the 25 items of the 2 KiB cap render to 4,816 bytes: Policy fills
    // the budget in id order, the rest (and the lanes) count as omitted.
    const tight = selectRunMemory({ policy, lanes, budgetBytes: SEMANTIC_MEMORY_BLOCK_MIN_BYTES });
    const given = tight.items.filter((i) => i.policy);
    expect(given.length).toBeGreaterThan(18);
    expect(given.length).toBeLessThan(25);
    expect(ids(given)).toEqual(ids(policy.slice(0, given.length)));
    expect(tight.items.some((i) => !i.policy)).toBe(false);
    expect(semanticMemoryRenderedBytes(tight)).toBeLessThanOrEqual(SEMANTIC_MEMORY_BLOCK_MIN_BYTES);
    expect(tight.omitted_count).toBe(25 - given.length + 1);
  });

  it("gives each lane its floor before the best items elsewhere take the rest", () => {
    // The Workspace lane has very relevant items that alone would fill the whole budget.
    const team = Array.from({ length: 40 }, () =>
      cand(item("team", { bytes: 300 }), { textRank: 9 }),
    );
    const site = [cand(item("site", { bytes: 300 }), { textRank: 0.01 })];
    const user = [cand(item("user", { bytes: 300 }), { textRank: 0.01 })];
    const s = selectRunMemory({ policy: [], lanes: { team, site, user }, budgetBytes: budget });
    const scopes = s.items.map((i) => i.scope);
    expect(scopes).toContain("site");
    expect(scopes).toContain("user");
    expect(scopes.filter((x) => x === "team").length).toBeGreaterThan(10);
    expect(semanticMemoryRenderedBytes(s)).toBeLessThanOrEqual(budget);
  });

  it("lets an unused floor flow on to other lanes", () => {
    const team = Array.from({ length: 40 }, () =>
      cand(item("team", { bytes: 200 }), { textRank: 1 }),
    );
    const alone = selectRunMemory({ policy: [], lanes: { team }, budgetBytes: budget });
    const withEmpty = selectRunMemory({
      policy: [],
      lanes: { team, user: [], portable: [], site: [] },
      budgetBytes: budget,
    });
    expect(alone.items.length).toBe(withEmpty.items.length);
    // Far more than one floor's worth.
    expect(alone.items.length * 296).toBeGreaterThan(4 * LANE_FLOOR_BYTES);
  });

  it("takes pinned items of a lane before more relevant ones", () => {
    const pinned = item("team", { pinned: true, bytes: 300 });
    const hot = Array.from({ length: 3 }, () =>
      cand(item("team", { bytes: 300 }), { textRank: 9 }),
    );
    const s = selectRunMemory({
      policy: [],
      lanes: { team: [...hot, cand(pinned, { textRank: 0 })] },
      budgetBytes: SEMANTIC_MEMORY_BLOCK_MIN_BYTES,
    });
    expect(s.items[0]?.id).toBe(pinned.id);
  });

  it("gives preferences a base score in the person lanes only", () => {
    const pref = item("user", { kind: "preference" });
    const fact = item("user", { kind: "fact" });
    expect(memoryScore(cand(pref, { textRank: 0 }), "user")).toBeCloseTo(PREFERENCE_BASE + 0.1);
    expect(memoryScore(cand(fact, { textRank: 0 }), "user")).toBeCloseTo(0.1);
    const teamPref = item("team", { kind: "preference" });
    expect(memoryScore(cand(teamPref, { textRank: 0 }), "team")).toBeCloseTo(0.1);
    // With no word matched, only the preference is a candidate.
    const s = selectRunMemory({
      policy: [],
      lanes: { user: [cand(pref, { textRank: 0 }), cand(fact, { textRank: 0 })] },
      budgetBytes: budget,
    });
    expect(ids(s.items)).toEqual([pref.id]);
    expect(s.omitted_count).toBe(0);
  });

  it("scores ts_rank_cd + 0.3·trigram + 0.1·recency over 180 days", () => {
    const i = item("team");
    expect(memoryScore(cand(i, { textRank: 0.4, trigram: 0.5, ageDays: 90 }), "team")).toBeCloseTo(
      0.4 + 0.15 + 0.05,
    );
    expect(memoryScore(cand(i, { textRank: 0, trigram: 0, ageDays: 400 }), "team")).toBe(0);
  });

  it("keeps items of the thread's previous run (stickiness)", () => {
    const a = item("team", { bytes: 900 });
    const b = item("team", { bytes: 900 });
    const plain = selectRunMemory({
      policy: [],
      lanes: { team: [cand(a, { textRank: 0.3 }), cand(b, { textRank: 0.2 })] },
      budgetBytes: SEMANTIC_MEMORY_BLOCK_MIN_BYTES,
    });
    expect(ids(plain.items)).toContain(a.id);
    const sticky = selectRunMemory({
      policy: [],
      lanes: {
        team: [cand(a, { textRank: 0.3 }), cand(b, { textRank: 0.2, sticky: true })],
      },
      budgetBytes: 256 + 160 + 96 + 900 + 10,
    });
    expect(ids(sticky.items)).toEqual([b.id]);
    expect(memoryScore(cand(b, { textRank: 0.2, sticky: true }), "team")).toBeCloseTo(
      0.2 + 0.1 + STICKY_BONUS,
    );
    // Stickiness only ranks: an item the previous run got that matches nothing now is not
    // given again (M1, re-picked every message).
    const s = selectRunMemory({
      policy: [],
      lanes: { team: [cand(a, { textRank: 0, sticky: true })] },
      budgetBytes: budget,
    });
    expect(ids(s.items)).toEqual([]);
    expect(s.omitted_count).toBe(0);
  });

  it("gives pinned items by render order, whatever this message scores them (L1)", () => {
    // Pinned items larger than the floors, in every lane, at the smallest budget.
    const pins = (["user", "portable", "team", "site"] as const).flatMap((lane, l) =>
      Array.from({ length: 4 }, (_, k) =>
        item(lane, { id: 300 + l * 10 + k, pinned: true, bytes: 450 }),
      ),
    );
    const policy = [item("site", { id: 299, policy: true, bytes: 300 })];
    const run = (seed: number) =>
      selectRunMemory({
        policy,
        lanes: Object.fromEntries(
          (["user", "portable", "team", "site"] as const).map((lane) => [
            lane,
            [
              ...pins
                .filter((p) => p.scope === lane)
                .map((p, k) =>
                  cand(p, { textRank: ((k + seed) % 4) / 4, sticky: (k + seed) % 2 === 0 }),
                ),
              cand(item(lane, { id: 400 + seed * 10 + RENDER_LANES.indexOf(lane), bytes: 30 }), {
                textRank: 2,
              }),
            ],
          ]),
        ),
        budgetBytes: SEMANTIC_MEMORY_BLOCK_MIN_BYTES,
      });
    const a = run(1);
    const b = run(2);
    const prefix = (s: typeof a) => s.items.filter((i) => i.policy || i.pinned);
    expect(prefix(a).length).toBeGreaterThan(1);
    expect(prefix(a)).toEqual(prefix(b));
    // Render order: site, team, portable, user; the first pins of the Site lane come first.
    expect(prefix(a)[1]?.scope).toBe("site");
  });

  it("uses whole items only: a misfit is skipped, a smaller one still fits", () => {
    const big = item("team", { bytes: 500 });
    const small = item("team", { bytes: 20 });
    const s = selectRunMemory({
      policy: [],
      lanes: { team: [cand(big, { textRank: 2 }), cand(small, { textRank: 1 })] },
      budgetBytes: 256 + 160 + 96 + 100,
    });
    expect(ids(s.items)).toEqual([small.id]);
    expect(s.items[0]?.statement).toBe(small.statement);
    expect(s.omitted_count).toBe(1);
  });

  it("counts eligible items the store did not read as omitted", () => {
    const s = selectRunMemory({
      policy: [],
      lanes: { team: [cand(item("team"))] },
      beyond: { team: 7 },
      budgetBytes: budget,
    });
    expect(s.omitted_count).toBe(7);
  });

  it("orders Policy → pinned → per-message picks, by lane then id, the same every time", () => {
    const lanes: Partial<Record<SelectLane, Candidate[]>> = {
      user: [
        cand(item("user", { id: 50 }), { textRank: 3 }),
        cand(item("user", { id: 51, pinned: true })),
      ],
      portable: [cand(item("portable", { id: 40, pinned: true }))],
      team: [
        cand(item("team", { id: 30 }), { textRank: 0.5 }),
        cand(item("team", { id: 31 }), { textRank: 2 }),
      ],
      site: [
        cand(item("site", { id: 20 }), { textRank: 0.2 }),
        cand(item("site", { id: 21, pinned: true })),
      ],
    };
    const policy = [item("site", { id: 10, policy: true })];
    const s = selectRunMemory({ policy, lanes, budgetBytes: budget });
    expect(ids(s.items)).toEqual([10, 21, 40, 51, 20, 30, 31, 50].map(uuid));
    // The same input in another order gives the same bytes.
    const shuffled = Object.fromEntries(
      Object.entries(lanes).map(([k, v]) => [k, [...v].reverse()]),
    ) as typeof lanes;
    expect(selectRunMemory({ policy, lanes: shuffled, budgetBytes: budget }).items).toEqual(
      s.items,
    );
    expect(runSemanticMemorySchema.safeParse(s).success).toBe(true);
  });

  it("keeps the Policy and pinned prefix when the message changes", () => {
    const pinA = cand(item("team", { id: 60, pinned: true }));
    const pinB = cand(item("user", { id: 61, pinned: true }));
    const x = cand(item("team", { id: 62 }), { textRank: 1 });
    const y = cand(item("team", { id: 63 }), { textRank: 1 });
    const policy = [item("site", { id: 64, policy: true })];
    const first = selectRunMemory({
      policy,
      lanes: { team: [pinA, x], user: [pinB] },
      budgetBytes: budget,
    });
    const second = selectRunMemory({
      policy,
      lanes: { team: [pinA, y], user: [pinB] },
      budgetBytes: budget,
    });
    expect(first.items.slice(0, 3)).toEqual(second.items.slice(0, 3));
    expect(first.items[3]?.id).not.toBe(second.items[3]?.id);
  });

  it("stays within the budget and the run's item cap", () => {
    const lanes = Object.fromEntries(
      (["user", "portable", "team", "site"] as const).map((lane) => [
        lane,
        Array.from({ length: 200 }, (_, k) =>
          cand(item(lane, { bytes: 1 + (k % 50) * 9 }), {
            textRank: ((k * 37) % 100) / 100 + 0.01,
          }),
        ),
      ]),
    );
    for (const kib of [4, 8, 16]) {
      const s = selectRunMemory({ policy: [], lanes, budgetBytes: kib * 1024 });
      expect(semanticMemoryRenderedBytes(s)).toBeLessThanOrEqual(kib * 1024);
      expect(s.items.length).toBeLessThanOrEqual(100);
      expect(s.items.length + s.omitted_count).toBe(800);
      expect(runSemanticMemorySchema.safeParse(s).success).toBe(true);
    }
  });
});
