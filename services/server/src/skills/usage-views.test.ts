import { describe, expect, it } from "vitest";
import type { TeamUse, UsageSnapshot } from "./usage-snapshot.js";
import { cardUsage, optOutCount, siteSkillUsage, teamSkillUsage } from "./usage-views.js";

/** KOBE-339 (SK26): the minimum-count rule on the nightly snapshot. */
const SKILL = "skill-1";

function use(over: {
  installed?: boolean;
  running?: string | null;
  optedOut?: boolean;
  runs?: Record<string, number>;
  members?: Record<string, string[]>;
  up?: Record<string, number>;
  down?: Record<string, number>;
  raters?: Record<string, string[]>;
}): TeamUse {
  const sets = (r?: Record<string, string[]>) =>
    new Map(Object.entries(r ?? {}).map(([k, v]) => [k, new Set(v)]));
  return {
    installed: over.installed ?? false,
    running: over.running ?? null,
    optedOut: over.optedOut ?? false,
    runs: new Map(Object.entries(over.runs ?? {})),
    members: sets(over.members),
    up: new Map(Object.entries(over.up ?? {})),
    down: new Map(Object.entries(over.down ?? {})),
    raters: sets(over.raters),
  };
}

function snapshot(teams: Record<string, TeamUse>) {
  return {
    from: "2026-08-22T00:00:00.000Z",
    to: "2026-09-21T00:00:00.000Z",
    computedAt: "2026-09-21T00:05:00.000Z",
    skills: new Map([[SKILL, new Map(Object.entries(teams))]]),
  } satisfies UsageSnapshot;
}

const installed = (running = "1.0.0", members: string[] = ["m"]) =>
  use({
    installed: true,
    running,
    runs: { [running]: members.length },
    members: { [running]: members },
  });

describe("the minimum-count rule (ac-1)", () => {
  it("shows a cross-team number only with three teams other than the viewer's", () => {
    const s = snapshot({ a: installed(), b: installed(), c: installed() });
    // The viewer belongs to team a (now): only b and c are others, so "few".
    expect(cardUsage(s, SKILL, new Set(["a"])).teamsInstalled).toBe("few");
    expect(cardUsage(s, SKILL, new Set()).teamsInstalled).toBe(3);
    const four = snapshot({ a: installed(), b: installed(), c: installed(), d: installed() });
    expect(cardUsage(four, SKILL, new Set(["a"]))).toMatchObject({
      teamsInstalled: 4,
      members: 1,
    });
  });

  it("reads none as few, so few can't be told from zero", () => {
    expect(cardUsage(snapshot({}), SKILL, new Set())).toMatchObject({
      teamsInstalled: "few",
      members: "few",
      thumbsUp: "few",
    });
  });

  it("shows the thumbs share only on 20 ratings of other teams, from three of them", () => {
    const rated = (up: number, down: number) =>
      use({ up: { "1.0.0": up }, down: { "1.0.0": down } });
    const s = snapshot({ a: rated(10, 0), b: rated(5, 0), c: rated(3, 1), d: rated(0, 1) });
    expect(cardUsage(s, SKILL, new Set()).thumbsUp).toBe(0.9); // 18 of 20
    expect(cardUsage(s, SKILL, new Set(["a"])).thumbsUp).toBe("few");
    expect(
      cardUsage(snapshot({ a: rated(15, 0), b: rated(10, 0) }), SKILL, new Set()).thumbsUp,
    ).toBe("few");
  });

  it("withholds a number one other team dominates (review L2)", () => {
    const ran = (n: number, who: string) =>
      use({ runs: { "1.0.0": n }, members: { "1.0.0": [who] } });
    const s = snapshot({ a: ran(500, "x"), b: ran(1, "y"), c: ran(1, "z") });
    expect(siteSkillUsage(s, SKILL, ["1.0.0"], new Set()).totals.runs).toBe("few");
    const even = snapshot({ a: ran(5, "x"), b: ran(4, "y"), c: ran(3, "z") });
    expect(siteSkillUsage(even, SKILL, ["1.0.0"], new Set()).totals.runs).toBe(12);
    // The viewer's own team may dominate: what the others give together still mixes three.
    const own = snapshot({ a: ran(500, "x"), b: ran(4, "y"), c: ran(3, "z"), d: ran(3, "w") });
    expect(siteSkillUsage(own, SKILL, ["1.0.0"], new Set(["a"])).totals.runs).toBe(510);
  });
});

describe("no differencing (ac-4)", () => {
  it("withholds a per-version column when any non-empty cell is few", () => {
    const s = snapshot({
      a: installed("1.0.0"),
      b: installed("1.0.0"),
      c: installed("1.0.0"),
      d: installed("2.0.0"),
    });
    const u = siteSkillUsage(s, SKILL, ["2.0.0", "1.0.0"], new Set());
    expect(u.totals.teamsInstalled).toBe(4);
    expect(u.versions).toEqual(["2.0.0", "1.0.0", "other"]);
    expect(u.perVersion.teamsRunning).toBeNull();
    expect(u.perVersion.runs).toBeNull();
  });

  it("counts what no listed version covers in an other cell (review L1)", () => {
    const s = snapshot({
      a: installed("1.0.0"),
      b: installed("1.0.0"),
      c: installed("1.0.0"),
      // A run that recorded no version: total minus the 1.0.0 cell would be team d's.
      d: use({ runs: { "": 1 }, members: { "": ["q"] } }),
    });
    const u = siteSkillUsage(s, SKILL, ["1.0.0"], new Set());
    expect(u.totals.runs).toBe(4);
    expect(u.perVersion.runs).toBeNull();
    const clean = snapshot({
      a: installed("1.0.0"),
      b: installed("1.0.0"),
      c: installed("1.0.0"),
    });
    expect(siteSkillUsage(clean, SKILL, ["1.0.0"], new Set()).perVersion.runs).toEqual([3, "few"]);
  });

  it("counts Default opt-outs with the same rule", () => {
    const out = use({ optedOut: true });
    const s = snapshot({ a: out, b: out, c: out });
    expect(optOutCount(s, SKILL, new Set())).toBe(3);
    expect(optOutCount(s, SKILL, new Set(["a"]))).toBe("few");
  });
});

describe("a Team admin's own team", () => {
  const team = (members: Record<string, string[]>, runsBy: Record<string, number>) =>
    use({ installed: true, running: "1.0.0", runs: runsBy, members });

  it("shows runs and members only with three members other than the viewer", () => {
    const one = snapshot({ a: team({ "1.0.0": ["m1"] }, { "1.0.0": 4 }) });
    expect(teamSkillUsage(one, "a", "admin")[0]).toMatchObject({ runs: "few", members: "few" });
    const three = snapshot({ a: team({ "1.0.0": ["m1", "m2", "m3"] }, { "1.0.0": 9 }) });
    expect(teamSkillUsage(three, "a", "admin")[0]).toMatchObject({ runs: 9, members: 3 });
    // The viewer's own runs don't count toward the three.
    expect(teamSkillUsage(three, "a", "m1")[0]).toMatchObject({ runs: "few", members: "few" });
  });

  it("withholds the version table when one version reads few", () => {
    const s = snapshot({
      a: team({ "1.0.0": ["m1", "m2", "m3"], "2.0.0": ["m4"] }, { "1.0.0": 9, "2.0.0": 1 }),
    });
    const [u] = teamSkillUsage(s, "a", "admin");
    expect(u).toMatchObject({ runs: 10, members: 4, versions: null });
  });

  it("shows thumbs on five raters other than the viewer", () => {
    const raters = ["r1", "r2", "r3", "r4", "admin"];
    const s = snapshot({
      a: use({
        installed: true,
        running: "1.0.0",
        up: { "1.0.0": 4 },
        down: { "1.0.0": 1 },
        raters: { "1.0.0": raters },
      }),
    });
    expect(teamSkillUsage(s, "a", "admin")[0]?.thumbs).toEqual({ enough: false });
    expect(teamSkillUsage(s, "a", "someone")[0]?.thumbs).toEqual({ enough: true, up: 4, down: 1 });
    expect(teamSkillUsage(s, "b", "admin")).toEqual([]);
  });
});
