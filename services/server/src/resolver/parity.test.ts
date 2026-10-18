import { describe, expect, it } from "vitest";
import { seededRandom } from "../testing/event-stream-fixture.js";
import { resolveEffective, type ResolveInput, type SkillRef } from "./resolve.js";

/**
 * KOBE-315 ac-4: parity with the resolver before SK27. Today's runs (no catalog installs, no
 * Required skills) resolve to the same skills, with the same hashes, and the same omissions as
 * the KOBE-313 resolver did. The only intended difference is order: offered (On by default) team
 * skills are step 3, before personal skills (step 4), so where an offered and a personal skill share
 * a name the offered one now wins; the fixtures below keep such names apart, and the order test
 * in resolve.test.ts covers that case.
 */

/** The KOBE-313 skill resolution, verbatim but for types (git 2e4ac678 resolve.ts). */
function legacySkills(input: ResolveInput) {
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
function fixture(seed: string): ResolveInput {
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
    const input = fixture(seed);
    const before = legacySkills(input);
    const after = resolveEffective(input);
    if (!after.ok) throw new Error("resolve failed");
    expect(after.value.skills.map(key).sort()).toEqual(before.skills.map(key).sort());
    // A blocklisted offered skill now says so (it was left out silently before).
    const blockedOffered = new Set(
      (input.team.offeredSkills ?? [])
        .filter((s) => input.blockedHashes.includes(s.hash) && !input.agent.exclusiveSkills)
        .map((s) => `${s.name}:blocklisted`),
    );
    expect(
      after.value.omissions
        .filter((o) => o.kind === "skill")
        .map(omissionKey)
        .filter((k) => !blockedOffered.has(k))
        .sort(),
    ).toEqual(before.omissions.map(omissionKey).sort());
  });
});
