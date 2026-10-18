import { describe, expect, it } from "vitest";
import { RUN_SKILLS_MAX, resolveEffective, type ResolveInput, type SkillRef } from "./resolve.js";

/**
 * KOBE-315 (SK27): the resolution order. Required (installs and team skills), then the agent's
 * named skills (catalog at the install's pin, local at their approved/frozen version), then
 * installs and member adds, then personal skills; deduplicated by name (earlier wins), capped at
 * 64 with Required counted first. `skills: exclusive` stops after the named skills, but Required
 * still loads.
 */
const base: ResolveInput = {
  agent: {
    modelAlias: null,
    approvalMode: null,
    skills: [],
    exclusiveSkills: false,
    connectors: [],
  },
  team: {
    models: [{ alias: "fast", isDefault: true }],
    connectors: [],
    personalSkillsDisabled: false,
  },
  user: { skills: [], connectedConnectors: [] },
  approvalFloor: "auto",
  blockedHashes: [],
};
const input = (patch: {
  agent?: Partial<ResolveInput["agent"]>;
  team?: Partial<ResolveInput["team"]>;
  user?: Partial<ResolveInput["user"]>;
  blockedHashes?: string[];
}): ResolveInput => ({
  ...base,
  ...(patch.blockedHashes ? { blockedHashes: patch.blockedHashes } : {}),
  agent: { ...base.agent, ...patch.agent },
  team: { ...base.team, ...patch.team },
  user: { ...base.user, ...patch.user },
});
const local = (name: string, hash = `h-${name}`): SkillRef => ({ name, hash, source: "team" });
const cat = (name: string, semver = "1.0.0", extra: Partial<SkillRef> = {}): SkillRef => ({
  name,
  hash: `c-${name}-${semver}`,
  source: "catalog",
  semver,
  ...extra,
});
const mine = (name: string): SkillRef => ({ name, hash: `p-${name}`, source: "personal" });

const run = (i: ResolveInput) => {
  const r = resolveEffective(i);
  if (!r.ok) throw new Error("resolve failed");
  return r.value;
};
const names = (i: ResolveInput) => run(i).skills.map((s) => s.name);

describe("order", () => {
  it("Required, then named, then installs and member adds, then personal", () => {
    const i = input({
      team: { requiredSkills: [cat("policy"), local("house-style")], offeredSkills: [cat("xlsx")] },
      agent: { skills: [local("named")], catalogSkills: [cat("charts")] },
      user: { skills: [mine("my-notes")] },
    });
    expect(names(i)).toEqual(["policy", "house-style", "named", "charts", "xlsx", "my-notes"]);
    expect(run(i).omissions).toEqual([]);
  });

  it("deduplicates by name: the earlier step wins", () => {
    const i = input({
      team: {
        requiredSkills: [cat("xlsx", "2.0.0")],
        offeredSkills: [cat("xlsx", "1.0.0"), cat("pdf")],
      },
      agent: { catalogSkills: [cat("xlsx", "1.5.0")] },
      user: { skills: [mine("pdf"), mine("xlsx")] },
    });
    const r = run(i);
    expect(r.skills.map((s) => `${s.name}@${s.semver ?? ""}`)).toEqual(["xlsx@2.0.0", "pdf@1.0.0"]);
    expect(r.omissions).toEqual([
      { kind: "skill", name: "pdf", reason: "shadowed" },
      { kind: "skill", name: "xlsx", reason: "shadowed_by_agent" },
    ]);
  });
});

describe("exclusive agents", () => {
  it("stop after the named skills, but Required still loads", () => {
    const i = input({
      team: { requiredSkills: [cat("policy")], offeredSkills: [cat("xlsx")] },
      agent: { exclusiveSkills: true, skills: [local("named")] },
      user: { skills: [mine("my-notes")] },
    });
    expect(names(i)).toEqual(["policy", "named"]);
    expect(run(i).omissions).toEqual([
      { kind: "skill", name: "my-notes", reason: "agent_exclusive" },
    ]);
  });

  it("an omission of a Required install shows even for exclusive agents; installs' do not", () => {
    const i = input({
      team: {
        requiredOmissions: [{ name: "policy", reason: "revoked" }],
        offeredOmissions: [{ name: "xlsx", reason: "suspended" }],
      },
      agent: { exclusiveSkills: true },
    });
    expect(run(i).omissions).toEqual([{ kind: "skill", name: "policy", reason: "revoked" }]);
    expect(run(input({ team: i.team })).omissions).toEqual([
      { kind: "skill", name: "policy", reason: "revoked" },
      { kind: "skill", name: "xlsx", reason: "suspended" },
    ]);
  });
});

describe("cap", () => {
  const many = (prefix: string, n: number, make: (name: string) => SkillRef) =>
    Array.from({ length: n }, (_, k) => make(`${prefix}-${String(k).padStart(2, "0")}`));

  it("counts Required first: named skills past the cap are skill_limit", () => {
    const i = input({
      team: { requiredSkills: many("req", 60, (n) => cat(n)) },
      agent: { skills: many("named", 6, local) },
    });
    const r = run(i);
    expect(RUN_SKILLS_MAX).toBe(64);
    expect(r.skills).toHaveLength(64);
    expect(r.skills.slice(0, 60).every((s) => s.name.startsWith("req-"))).toBe(true);
    expect(r.omissions.map((o) => `${o.name}:${o.reason}`)).toEqual([
      "named-04:skill_limit",
      "named-05:skill_limit",
    ]);
  });
});

describe("omission reasons", () => {
  it("named catalog skills: not_installed, revoked, suspended; blocklisted by runtime or package hash", () => {
    const i = input({
      agent: {
        skillOmissions: [
          { name: "missing", reason: "not_installed" },
          { name: "gone", reason: "revoked" },
          { name: "flagged", reason: "suspended" },
        ],
        catalogSkills: [cat("bad"), cat("alias", "1.0.0", { aliases: ["pkg-alias"] }), cat("ok")],
      },
      blockedHashes: ["c-bad-1.0.0", "pkg-alias"],
    });
    const r = run(i);
    expect(r.skills.map((s) => s.name)).toEqual(["ok"]);
    expect(r.omissions.map((o) => `${o.name}:${o.reason}`)).toEqual([
      "bad:blocklisted",
      "alias:blocklisted",
      "missing:not_installed",
      "gone:revoked",
      "flagged:suspended",
    ]);
  });

  it("a blocklisted Required skill is left out with a notice", () => {
    const r = run(
      input({ team: { requiredSkills: [cat("bad")] }, blockedHashes: ["c-bad-1.0.0"] }),
    );
    expect(r.skills).toEqual([]);
    expect(r.omissions).toEqual([{ kind: "skill", name: "bad", reason: "blocklisted" }]);
  });
});
