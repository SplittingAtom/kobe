import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { RUN_SKILLS_MAX, resolveEffective, type ResolveInput, type SkillRef } from "./resolve.js";

/**
 * KOBE-315 ac-4: parity with the resolver before SK27. Today's runs (no catalog installs, no
 * Required skills) resolve to the same skills, with the same hashes, and the same omissions as
 * the KOBE-313 resolver did. The only intended difference is order: offered (On by default) team
 * skills are step 3, before personal skills (step 4), so where an offered and a personal skill share
 * a name the offered one now wins. The first family keeps such names apart; the second ("name
 * clashes and the cap") lets every list share names and run past the cap, and checks the exact
 * result against the legacy one with each documented difference applied ({@link expectedNow}):
 *
 * - D1: an offered skill beats a personal one of the same name (`shadowed`);
 * - D2 (review S2): a named skill that is not approved or suspended keeps its name, so neither a
 *   personal (`shadowed_by_agent`) nor an offered skill of that name stands in;
 * - D3: a blocklisted offered skill gets a `blocklisted` notice (it was left out silently);
 * - D4: the cap of 64 counts in the new order (named, offered, personal);
 * - D5 (KOBE-317): a built-in the agent names is a named Kobe catalog skill (step 2, after the
 *   local named ones): it is in `skills` with its catalog hash and counts against the cap. It holds
 *   its name exactly as the built-in did, and a Kobe name never resolves to a local skill, so the
 *   fixtures' named, pending and suspended entries of that name are the team's own and dropped
 *   from both sides ({@link split}).
 */

/** The KOBE-313 input: built-ins were names beside the skills (KOBE-88). */
type LegacyInput = Omit<ResolveInput, "agent"> & {
  readonly agent: ResolveInput["agent"] & { readonly builtinSkills?: readonly string[] };
};

const kobeRef = (name: string): SkillRef => ({ name, hash: `kobe-${name}`, source: "catalog" });

/**
 * The same site before and after KOBE-317: the legacy input without local entries under a
 * built-in name (D5), and the new input where each built-in is a named Kobe catalog skill.
 */
function split(input: LegacyInput): { legacy: LegacyInput; now: ResolveInput; kobe: SkillRef[] } {
  const builtins = [...new Set(input.agent.builtinSkills ?? [])];
  const local = (n: string) => !builtins.includes(n);
  const agent = {
    ...input.agent,
    skills: input.agent.skills.filter((s) => local(s.name)),
    unapprovedSkills: (input.agent.unapprovedSkills ?? []).filter(local),
    suspendedSkills: (input.agent.suspendedSkills ?? []).filter(local),
  };
  const kobe = builtins.map(kobeRef);
  const { builtinSkills: _gone, ...nowAgent } = agent;
  return {
    legacy: { ...input, agent },
    now: { ...input, agent: { ...nowAgent, catalogSkills: kobe } },
    kobe,
  };
}

/**
 * A generator seeded by the fixture's label (mulberry32), so each label is its own fixture and a
 * failure reproduces by name. (`seededRandom` seeds from the clock, which made every fixture of
 * one run the same.)
 */
function seededRandom(label: string): () => number {
  let a = createHash("sha256").update(label).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The KOBE-313 skill resolution, verbatim but for types (git 2e4ac678 resolve.ts). */
function legacySkills(input: LegacyInput) {
  const blocked = new Set(input.blockedHashes);
  const skills: SkillRef[] = [];
  const omissions: { kind: "skill"; name: string; reason: string }[] = [];
  const omit = (s: SkillRef, reason: string) =>
    omissions.push({ kind: "skill", name: s.name, reason });
  for (const s of input.agent.skills) {
    if (blocked.has(s.hash)) omit(s, "blocklisted");
    else skills.push(s);
  }
  for (const name of input.agent.unapprovedSkills ?? [])
    omissions.push({ kind: "skill", name, reason: "not_approved" });
  for (const name of input.agent.suspendedSkills ?? [])
    omissions.push({ kind: "skill", name, reason: "suspended" });
  const agentNames = new Set([
    ...input.agent.skills.map((s) => s.name),
    ...(input.agent.builtinSkills ?? []),
  ]);
  for (const s of input.user.skills) {
    if (input.agent.exclusiveSkills) omit(s, "agent_exclusive");
    else if (input.team.personalSkillsDisabled) omit(s, "team_disabled");
    else if (blocked.has(s.hash)) omit(s, "blocklisted");
    else if (agentNames.has(s.name)) omit(s, "shadowed_by_agent");
    else skills.push(s);
  }
  const userReason = (otherwise: string) =>
    input.agent.exclusiveSkills
      ? "agent_exclusive"
      : input.team.personalSkillsDisabled
        ? "team_disabled"
        : otherwise;
  for (const name of input.user.unapprovedSkills ?? [])
    omissions.push({ kind: "skill", name, reason: userReason("not_approved") });
  for (const name of input.user.suspendedSkills ?? [])
    omissions.push({ kind: "skill", name, reason: userReason("suspended") });
  if (!input.agent.exclusiveSkills) {
    const taken = new Set([...agentNames, ...skills.map((s) => s.name)]);
    for (const s of input.team.offeredSkills ?? []) {
      if (blocked.has(s.hash) || taken.has(s.name)) continue;
      taken.add(s.name);
      skills.push(s);
    }
  }
  return { skills, omissions };
}

/** A seeded fixture: named, personal and offered skills, some blocked, approved or suspended. */
function fixture(seed: string): LegacyInput {
  const rnd = seededRandom(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)] as T;
  const n = (max: number) => Math.floor(rnd() * (max + 1));
  const ref = (prefix: string, i: number, source: "team" | "personal"): SkillRef => ({
    name: `${prefix}-${i}`,
    hash: `${prefix}-${i}-${n(9)}`,
    source,
  });
  const named = Array.from({ length: n(6) }, (_, i) => ref("named", i, "team"));
  // Personal skills sometimes share a name with a named one (shadowed_by_agent).
  const personal = Array.from({ length: n(6) }, (_, i) =>
    rnd() < 0.2 && named[i]
      ? { ...ref("mine", i, "personal"), name: named[i].name }
      : ref("mine", i, "personal"),
  );
  // Offered skills sometimes repeat a named name (silently deduplicated before and after).
  const offered = Array.from({ length: n(6) }, (_, i) =>
    rnd() < 0.2 && named[i]
      ? { ...ref("offer", i, "team"), name: named[i].name }
      : ref("offer", i, "team"),
  );
  const all = [...named, ...personal, ...offered];
  return {
    agent: {
      modelAlias: null,
      approvalMode: null,
      skills: named,
      builtinSkills: rnd() < 0.3 ? ["pdf"] : [],
      unapprovedSkills: rnd() < 0.3 ? ["pending-one"] : [],
      suspendedSkills: rnd() < 0.2 ? ["flagged-one"] : [],
      exclusiveSkills: rnd() < 0.25,
      connectors: [],
    },
    team: {
      models: [{ alias: "fast", isDefault: true }],
      connectors: [],
      personalSkillsDisabled: rnd() < 0.2,
      offeredSkills: offered,
    },
    user: {
      skills: personal,
      unapprovedSkills: rnd() < 0.3 ? ["my-pending"] : [],
      suspendedSkills: rnd() < 0.2 ? ["my-flagged"] : [],
      connectedConnectors: [],
    },
    approvalFloor: "auto",
    blockedHashes: all
      .filter(() => rnd() < 0.15)
      .map((s) => s.hash)
      .concat(pick([[], ["none"]])),
  };
}

const key = (s: SkillRef) => `${s.name}=${s.hash}`;
const omissionKey = (o: { name: string; reason: string }) => `${o.name}:${o.reason}`;

describe("resolver v2 parity with today's runs (ac-4)", () => {
  it.each(Array.from({ length: 200 }, (_, i) => `parity-${i}`))("%s", (seed) => {
    const { legacy: input, now, kobe } = split(fixture(seed));
    const before = legacySkills(input);
    const after = resolveEffective(now);
    if (!after.ok) throw new Error("resolve failed");
    // D5: the built-in now loads as a skill of the run.
    expect(after.value.skills.map(key).sort()).toEqual([...before.skills, ...kobe].map(key).sort());
    // A blocklisted offered skill now says so (it was left out silently before), one notice each.
    const blockedOffered = (input.team.offeredSkills ?? [])
      .filter((s) => input.blockedHashes.includes(s.hash) && !input.agent.exclusiveSkills)
      .map((s) => `${s.name}:blocklisted`);
    expect(
      after.value.omissions
        .filter((o) => o.kind === "skill")
        .map(omissionKey)
        .sort(),
    ).toEqual([...before.omissions.map(omissionKey), ...blockedOffered].sort());
  });
});

/** Fixtures where named, offered, personal, pending and suspended names overlap, up to ~130 skills. */
function clashFixture(seed: string): LegacyInput {
  const rnd = seededRandom(seed);
  const n = (max: number) => Math.floor(rnd() * (max + 1));
  const names = (count: number, pool: number) => [
    ...new Set(Array.from({ length: count }, () => `s-${n(pool)}`)),
  ];
  let h = 0;
  const refs = (list: string[], source: "team" | "personal") =>
    list.map((name): SkillRef => ({ name, hash: `${source}-${name}-${h++}`, source }));
  const named = refs(names(n(8), 30), "team");
  const offered = refs(names(n(60), 100), "team");
  const personal = refs(names(n(60), 100), "personal");
  const all = [...named, ...offered, ...personal];
  return {
    agent: {
      modelAlias: null,
      approvalMode: null,
      skills: named,
      builtinSkills: rnd() < 0.3 ? ["s-1"] : [],
      unapprovedSkills: names(n(3), 30).filter((x) => !named.some((s) => s.name === x)),
      suspendedSkills: rnd() < 0.3 ? ["s-2"].filter((x) => !named.some((s) => s.name === x)) : [],
      exclusiveSkills: rnd() < 0.2,
      connectors: [],
    },
    team: {
      models: [{ alias: "fast", isDefault: true }],
      connectors: [],
      personalSkillsDisabled: rnd() < 0.15,
      offeredSkills: offered,
    },
    user: { skills: personal, connectedConnectors: [] },
    approvalFloor: "auto",
    blockedHashes: all.filter(() => rnd() < 0.1).map((s) => s.hash),
  };
}

/** The legacy result with D1–D5 applied (see the header). */
function expectedNow(input: LegacyInput, kobe: readonly SkillRef[]) {
  const blocked = new Set(input.blockedHashes);
  const { agent, team, user } = input;
  const ex = agent.exclusiveSkills;
  const claimed = new Set([...(agent.unapprovedSkills ?? []), ...(agent.suspendedSkills ?? [])]);
  const agentNames = new Set([...agent.skills.map((s) => s.name), ...(agent.builtinSkills ?? [])]);
  // D2: an offered skill named like a claimed skill no longer loads.
  const offered = (team.offeredSkills ?? []).filter((s) => !claimed.has(s.name));
  const offeredLoads = new Set(
    ex
      ? []
      : offered.filter((s) => !blocked.has(s.hash) && !agentNames.has(s.name)).map((s) => s.name),
  );
  // D1 and D2: personal skills the legacy resolver loaded that are now shadowed.
  const shadowed = new Map<string, string>();
  for (const s of user.skills) {
    if (ex || team.personalSkillsDisabled || blocked.has(s.hash) || agentNames.has(s.name))
      continue;
    if (claimed.has(s.name)) shadowed.set(s.name, "shadowed_by_agent");
    else if (offeredLoads.has(s.name)) shadowed.set(s.name, "shadowed");
  }
  const legacy = legacySkills({
    ...input,
    team: { ...team, offeredSkills: offered },
    user: { ...user, skills: user.skills.filter((s) => !shadowed.has(s.name)) },
  });
  // D4 and D5: the new order (Kobe's named after the local named), then the cap.
  const rank = (s: SkillRef) =>
    agent.skills.includes(s)
      ? 0
      : kobe.includes(s)
        ? 0.5
        : (team.offeredSkills ?? []).includes(s)
          ? 1
          : 2;
  const ordered = [...legacy.skills, ...kobe].sort((a, b) => rank(a) - rank(b));
  const blockedOffered = ex ? [] : (team.offeredSkills ?? []).filter((s) => blocked.has(s.hash));
  return {
    skills: ordered.slice(0, RUN_SKILLS_MAX),
    omissions: [
      ...legacy.omissions,
      ...[...shadowed].map(([name, reason]) => ({ name, reason })),
      ...blockedOffered.map((s) => ({ name: s.name, reason: "blocklisted" })), // D3
      ...ordered.slice(RUN_SKILLS_MAX).map((s) => ({ name: s.name, reason: "skill_limit" })),
    ],
  };
}

describe("resolver v2 parity with name clashes and the cap (D1–D5)", () => {
  const seeds = Array.from({ length: 300 }, (_, i) => `clash-${i}`);

  it.each(seeds)("%s", (seed) => {
    const { legacy, now, kobe } = split(clashFixture(seed));
    const want = expectedNow(legacy, kobe);
    const after = resolveEffective(now);
    if (!after.ok) throw new Error("resolve failed");
    expect(after.value.skills.map(key)).toEqual(want.skills.map(key));
    expect(
      after.value.omissions
        .filter((o) => o.kind === "skill")
        .map(omissionKey)
        .sort(),
    ).toEqual(want.omissions.map(omissionKey).sort());
  });

  it("the fixtures reach every documented difference", () => {
    const inputs = seeds.map((seed) => split(clashFixture(seed)));
    const reasons = inputs.flatMap((i) =>
      expectedNow(i.legacy, i.kobe).omissions.map((o) => o.reason),
    );
    for (const r of ["shadowed", "shadowed_by_agent", "blocklisted", "skill_limit"])
      expect(reasons).toContain(r);
  });
});
