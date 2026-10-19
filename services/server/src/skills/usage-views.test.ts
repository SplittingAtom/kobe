import { describe, expect, it } from "vitest";
import type { TeamUse, UsageSnapshot } from "./usage-snapshot.js";
import { cardUsage, siteSkillUsage, teamSkillUsage, viewerTeams } from "./usage-views.js";

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

function snapshot(teams: Record<string, TeamUse>, memberships: Record<string, string[]> = {}) {
  return {
    day: "2026-10-19",
    from: "2026-09-19T00:00:00.000Z",
    to: "2026-10-19T00:00:00.000Z",
    computedAt: "2026-10-19T00:05:00.000Z",
    skills: new Map([[SKILL, new Map(Object.entries(teams))]]),
    memberships: new Map(Object.entries(memberships).map(([u, t]) => [u, new Set(t)])),
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
    const s = snapshot({ a: installed(), b: installed(), c: installed() }, { me: ["a"] });
    // The viewer belongs to team a: only b and c are others, so "few".
    expect(cardUsage(s, SKILL, viewerTeams(s, "me")).teamsInstalled).toBe("few");
    // An outsider sees three other teams.
    expect(cardUsage(s, SKILL, viewerTeams(s, "outsider")).teamsInstalled).toBe(3);
    const four = snapshot(
      { a: installed(), b: installed(), c: installed(), d: installed() },
      { me: ["a"] },
    );
    expect(cardUsage(four, SKILL, viewerTeams(four, "me"))).toMatchObject({
      teamsInstalled: 4,
      members: 1,
    });
  });

  it("reads none as few, so few can't be told from zero", () => {
    const s = snapshot({});
    expect(cardUsage(s, SKILL, new Set())).toMatchObject({
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
    // A viewer in team a: the others hold 10 ratings only.
    expect(cardUsage(s, SKILL, new Set(["a"])).thumbsUp).toBe("few");
    const two = snapshot({ a: rated(15, 0), b: rated(10, 0) });
    expect(cardUsage(two, SKILL, new Set()).thumbsUp).toBe("few");
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
    // 2.0.0 runs in one team: shown, it would be the total minus 1.0.0's three.
    expect(u.perVersion.teamsRunning).toBeNull();
    expect(u.perVersion.runs).toBeNull();
    const even = snapshot({
      a: installed("1.0.0"),
      b: installed("1.0.0"),
      c: installed("1.0.0"),
    });
    expect(
      siteSkillUsage(even, SKILL, ["2.0.0", "1.0.0"], new Set()).perVersion.teamsRunning,
    ).toEqual(["few", 3]);
  });

  it("counts Default opt-outs with the same rule", () => {
    const out = use({ optedOut: true });
    const s = snapshot({ a: out, b: out, c: out });
    expect(siteSkillUsage(s, SKILL, [], new Set()).totals.optOuts).toBe(3);
    expect(siteSkillUsage(s, SKILL, [], new Set(["a"])).totals.optOuts).toBe("few");
  });
});

describe("a Team admin's own team", () => {
  it("shows runs and members, and thumbs on five raters other than the viewer", () => {
    const raters = ["r1", "r2", "r3", "r4", "admin"];
    const s = snapshot({
      a: use({
        installed: true,
        running: "1.0.0",
        runs: { "1.0.0": 7 },
        members: { "1.0.0": ["m1", "m2"] },
        up: { "1.0.0": 4 },
        down: { "1.0.0": 1 },
        raters: { "1.0.0": raters },
      }),
    });
    const [u] = teamSkillUsage(s, "a", "admin");
    expect(u).toMatchObject({ runs: 7, members: 2, thumbs: { enough: false } });
    const [other] = teamSkillUsage(s, "a", "someone");
    expect(other?.thumbs).toEqual({ enough: true, up: 4, down: 1 });
    expect(teamSkillUsage(s, "b", "admin")).toEqual([]);
  });
});
