import { describe, expect, it } from "vitest";
import { resolveEffective, type ResolveInput } from "./resolve.js";

const base: ResolveInput = {
  agent: {
    modelAlias: null,
    approvalMode: null,
    skills: [],
    exclusiveSkills: false,
    connectors: [],
  },
  team: {
    models: [
      { alias: "fast", isDefault: true },
      { alias: "smart", isDefault: false },
    ],
    connectors: [],
    personalSkillsDisabled: false,
  },
  user: { skills: [], connectedConnectors: [] },
  approvalFloor: "auto",
  blockedHashes: [],
};
const with_ = (patch: {
  agent?: Partial<ResolveInput["agent"]>;
  team?: Partial<ResolveInput["team"]>;
  user?: Partial<ResolveInput["user"]>;
  approvalFloor?: ResolveInput["approvalFloor"];
  blockedHashes?: string[];
}): ResolveInput => ({
  ...base,
  ...(patch.approvalFloor === undefined ? {} : { approvalFloor: patch.approvalFloor }),
  ...(patch.blockedHashes === undefined ? {} : { blockedHashes: patch.blockedHashes }),
  agent: { ...base.agent, ...patch.agent },
  team: { ...base.team, ...patch.team },
  user: { ...base.user, ...patch.user },
});
const sk = (name: string, hash = `h-${name}`) => ({ name, hash });

describe("model", () => {
  it.each([
    ["pinned and enabled", "smart", "smart"],
    ["no pin uses the team default", null, "fast"],
  ])("%s", (_n, pin, want) => {
    const r = resolveEffective(with_({ agent: { modelAlias: pin } }));
    expect(r.ok && r.value.model).toBe(want);
  });

  it("pinned but not enabled is an error, never a fallback", () => {
    const r = resolveEffective(with_({ agent: { modelAlias: "gone" } }));
    expect(r).toEqual({
      ok: false,
      error: {
        code: "agent_model_not_enabled",
        message:
          "This agent's model (gone) isn't enabled for your team. Ask your team admin to enable it.",
      },
    });
  });

  it("no pin and no default: undefined model with an omission", () => {
    const r = resolveEffective(with_({ team: { models: [{ alias: "smart", isDefault: false }] } }));
    expect(r.ok && r.value.model).toBeUndefined();
    expect(r.ok && r.value.omissions).toEqual([
      { kind: "model", name: "(default)", reason: "no_team_default" },
    ]);
  });
});

describe("approval mode", () => {
  const modes = ["auto", "ask-on-write", "ask-all"] as const;
  const rank = { auto: 0, "ask-on-write": 1, "ask-all": 2 };
  for (const requested of [null, ...modes]) {
    for (const user of [null, ...modes]) {
      for (const floor of modes) {
        it(`agent ${requested} user ${user} floor ${floor}`, () => {
          const r = resolveEffective(
            with_({
              agent: { approvalMode: requested },
              user: { approvalMode: user },
              approvalFloor: floor,
            }),
          );
          if (!r.ok) throw new Error("unexpected");
          const got = r.value.approvalMode;
          expect(rank[got]).toBeGreaterThanOrEqual(rank[floor]);
          expect(rank[got]).toBeGreaterThanOrEqual(rank[requested ?? "ask-on-write"]);
          expect(rank[got]).toBeGreaterThanOrEqual(rank[user ?? "auto"]);
          const max = Math.max(
            rank[floor],
            rank[requested ?? "ask-on-write"],
            rank[user ?? "auto"],
          );
          expect(rank[got]).toBe(max);
        });
      }
    }
  }
});

describe("skills", () => {
  it("unions agent and user skills", () => {
    const r = resolveEffective(
      with_({ agent: { skills: [sk("a")] }, user: { skills: [sk("u")] } }),
    );
    expect(r.ok && r.value.skills.map((s) => s.name)).toEqual(["a", "u"]);
    expect(r.ok && r.value.omissions).toEqual([]);
  });

  it("exclusive agent drops user skills with omissions", () => {
    const r = resolveEffective(
      with_({ agent: { skills: [sk("a")], exclusiveSkills: true }, user: { skills: [sk("u")] } }),
    );
    expect(r.ok && r.value.skills.map((s) => s.name)).toEqual(["a"]);
    expect(r.ok && r.value.omissions).toEqual([
      { kind: "skill", name: "u", reason: "agent_exclusive" },
    ]);
  });

  it("team switch drops every personal skill, agent skills stay", () => {
    const r = resolveEffective(
      with_({
        agent: { skills: [sk("x")] },
        user: { skills: [sk("u1"), sk("u2")] },
        team: { personalSkillsDisabled: true },
      }),
    );
    expect(r.ok && r.value.skills).toEqual([sk("x")]);
    expect(r.ok && r.value.omissions).toEqual([
      { kind: "skill", name: "u1", reason: "team_disabled" },
      { kind: "skill", name: "u2", reason: "team_disabled" },
    ]);
  });

  it("KOBE-99: skills without approval are omitted as not_approved, agent's and user's", () => {
    const r = resolveEffective(
      with_({
        agent: { skills: [sk("a")], unapprovedSkills: ["pending-one"] },
        user: { skills: [sk("u")], unapprovedSkills: ["risky"] },
      }),
    );
    expect(r.ok && r.value.skills.map((s) => s.name)).toEqual(["a", "u"]);
    expect(r.ok && r.value.omissions).toEqual([
      { kind: "skill", name: "pending-one", reason: "not_approved" },
      { kind: "skill", name: "risky", reason: "not_approved" },
    ]);
  });

  it("KOBE-99: an exclusive agent or the team switch explains personal skills first", () => {
    const user = { skills: [], unapprovedSkills: ["risky"] };
    const exclusive = resolveEffective(with_({ agent: { exclusiveSkills: true }, user }));
    expect(exclusive.ok && exclusive.value.omissions).toEqual([
      { kind: "skill", name: "risky", reason: "agent_exclusive" },
    ]);
    const off = resolveEffective(with_({ team: { personalSkillsDisabled: true }, user }));
    expect(off.ok && off.value.omissions).toEqual([
      { kind: "skill", name: "risky", reason: "team_disabled" },
    ]);
  });

  it("blocklisted hash is omitted from agent and user skills", () => {
    const r = resolveEffective(
      with_({
        agent: { skills: [sk("a", "bad"), sk("b")] },
        user: { skills: [sk("u", "bad")] },
        blockedHashes: ["bad"],
      }),
    );
    expect(r.ok && r.value.skills.map((s) => s.name)).toEqual(["b"]);
    expect(r.ok && r.value.omissions).toEqual([
      { kind: "skill", name: "a", reason: "blocklisted" },
      { kind: "skill", name: "u", reason: "blocklisted" },
    ]);
  });

  it("a duplicate name keeps the agent's skill", () => {
    const r = resolveEffective(
      with_({ agent: { skills: [sk("a")] }, user: { skills: [sk("a", "other")] } }),
    );
    expect(r.ok && r.value.skills).toEqual([sk("a")]);
    expect(r.ok && r.value.omissions).toEqual([
      { kind: "skill", name: "a", reason: "shadowed_by_agent" },
    ]);
  });
});

describe("connectors", () => {
  const omit = (name: string, reason: string) => ({ kind: "connector", name, reason });
  it.each([
    ["all three agree", ["a", "b"], ["a", "b"], ["a", "b"], ["a", "b"], []],
    ["team filter", ["a", "b"], ["b"], ["a", "b"], ["b"], [omit("a", "not_team_enabled")]],
    ["user filter", ["a", "b"], ["a", "b"], ["a"], ["a"], [omit("b", "not_user_connected")]],
    [
      "never added from the user's connections or the team list",
      ["a"],
      ["a", "t"],
      ["a", "u"],
      ["a"],
      [],
    ],
    ["both filters name the team first", ["a"], [], [], [], [omit("a", "not_team_enabled")]],
    ["empty", [], ["t"], ["u"], [], []],
  ])("%s", (_n, agent, team, user, want, omissions) => {
    const r = resolveEffective(
      with_({
        agent: { connectors: agent },
        team: { connectors: team },
        user: { connectedConnectors: user },
      }),
    );
    expect(r.ok && r.value.connectors).toEqual(want);
    expect(r.ok && r.value.omissions).toEqual(omissions);
  });
});

it("does not mutate its input", () => {
  const input = with_({ agent: { skills: [sk("a")], connectors: ["a"] } });
  const copy = structuredClone(input);
  resolveEffective(input);
  expect(input).toEqual(copy);
});
