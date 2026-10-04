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
    disabledPersonalSkills: [],
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

  it("team-disabled personal skill is omitted; agent skill of that name is not", () => {
    const r = resolveEffective(
      with_({
        agent: { skills: [sk("x")] },
        user: { skills: [sk("x", "hx2"), sk("y")] },
        team: { disabledPersonalSkills: ["x"] },
      }),
    );
    expect(r.ok && r.value.skills).toEqual([sk("x"), sk("y")]);
    expect(r.ok && r.value.omissions).toEqual([
      { kind: "skill", name: "x", reason: "team_disabled" },
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
  it.each([
    ["agent list intersect team", ["a", "b"], ["b", "c"], [], ["b"], ["a"]],
    ["none enabled", ["a"], [], [], [], ["a"]],
    ["user-connected is added then filtered by team", [], ["u"], ["u", "v"], ["u"], ["v"]],
    ["empty everywhere", [], [], [], [], []],
  ])("%s", (_n, agent, team, user, want, omitted) => {
    const r = resolveEffective(
      with_({
        agent: { connectors: agent },
        team: { connectors: team },
        user: { connectedConnectors: user },
      }),
    );
    expect(r.ok && r.value.connectors).toEqual(want);
    expect(r.ok && r.value.omissions).toEqual(
      omitted.map((name) => ({ kind: "connector", name, reason: "not_team_enabled" })),
    );
  });
});

it("does not mutate its input", () => {
  const input = with_({ agent: { skills: [sk("a")], connectors: ["a"] } });
  const copy = structuredClone(input);
  resolveEffective(input);
  expect(input).toEqual(copy);
});
