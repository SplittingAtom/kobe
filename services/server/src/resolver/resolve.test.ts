import { describe, expect, it } from "vitest";
import { RUN_SKILLS_MAX, resolveEffective, type ResolveInput } from "./resolve.js";

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

  it("built-in skills resolve from the agent's list, deduplicated, with no hash or omission (KOBE-88)", () => {
    const r = resolveEffective(
      with_({
        agent: { builtinSkills: ["charts", "docx", "charts"] },
        blockedHashes: ["h-charts"],
      }),
    );
    expect(r.ok && r.value.builtinSkills).toEqual(["charts", "docx"]);
    expect(r.ok && r.value.skills).toEqual([]);
    expect(r.ok && r.value.omissions).toEqual([]);
  });

  it("no built-ins unless the agent lists them, and an exclusive agent keeps its built-ins", () => {
    const none = resolveEffective(with_({ user: { skills: [sk("charts")] } }));
    expect(none.ok && none.value.builtinSkills).toEqual([]);
    const excl = resolveEffective(
      with_({
        agent: { builtinSkills: ["pdf"], exclusiveSkills: true },
        user: { skills: [sk("u")] },
      }),
    );
    expect(excl.ok && excl.value.builtinSkills).toEqual(["pdf"]);
    expect(excl.ok && excl.value.omissions).toEqual([
      { kind: "skill", name: "u", reason: "agent_exclusive" },
    ]);
  });

  it("a personal skill named like a listed built-in is shadowed by it", () => {
    const r = resolveEffective(
      with_({ agent: { builtinSkills: ["xlsx"] }, user: { skills: [sk("xlsx"), sk("mine")] } }),
    );
    expect(r.ok && r.value.skills.map((s) => s.name)).toEqual(["mine"]);
    expect(r.ok && r.value.omissions).toEqual([
      { kind: "skill", name: "xlsx", reason: "shadowed_by_agent" },
    ]);
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

  it("KOBE-313: versions a rescan suspended are omitted as suspended, agent's and user's", () => {
    const r = resolveEffective(
      with_({
        agent: { skills: [sk("a")], suspendedSkills: ["held"] },
        user: { skills: [], suspendedSkills: ["mine"] },
      }),
    );
    expect(r.ok && r.value.skills.map((s) => s.name)).toEqual(["a"]);
    expect(r.ok && r.value.omissions).toEqual([
      { kind: "skill", name: "held", reason: "suspended" },
      { kind: "skill", name: "mine", reason: "suspended" },
    ]);
    const off = resolveEffective(
      with_({
        team: { personalSkillsDisabled: true },
        user: { skills: [], suspendedSkills: ["mine"] },
      }),
    );
    expect(off.ok && off.value.omissions).toEqual([
      { kind: "skill", name: "mine", reason: "team_disabled" },
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

describe("team skills offered to all agents (KOBE-297)", () => {
  const names = (input: ResolveInput) => {
    const r = resolveEffective(input);
    return r.ok ? r.value.skills.map((s) => s.name) : [];
  };

  // KOBE-315 (SK27): offered (On by default) team skills are step 3, before personal skills.
  it("a non-exclusive agent gets every offered skill, after its own and before the user's", () => {
    const input = with_({
      agent: { skills: [sk("named")] },
      user: { skills: [sk("mine")] },
      team: { offeredSkills: [sk("offered"), sk("also")] },
    });
    expect(names(input)).toEqual(["named", "offered", "also", "mine"]);
    const r = resolveEffective(input);
    expect(r.ok && r.value.omissions).toEqual([]);
  });

  it("an exclusive agent gets none of them, without a notice", () => {
    const r = resolveEffective(
      with_({
        agent: { skills: [sk("named")], exclusiveSkills: true },
        team: { offeredSkills: [sk("offered")] },
      }),
    );
    expect(r.ok && r.value.skills.map((s) => s.name)).toEqual(["named"]);
    expect(r.ok && r.value.omissions).toEqual([]);
  });

  it("is deduplicated with the agent's named skills, built-ins and the user's skills", () => {
    expect(
      names(
        with_({
          agent: { skills: [sk("dup")], builtinSkills: ["pdf"] },
          user: { skills: [sk("mine", "h-personal")] },
          team: { offeredSkills: [sk("dup"), sk("pdf"), sk("mine"), sk("fresh"), sk("fresh")] },
        }),
      ),
    ).toEqual(["dup", "mine", "fresh"]);
  });

  it("an offered skill fills in for a personal one the team switch hides", () => {
    expect(
      names(
        with_({
          user: { skills: [sk("same", "h-personal")] },
          team: { personalSkillsDisabled: true, offeredSkills: [sk("same")] },
        }),
      ),
    ).toEqual(["same"]);
  });

  it("caps the run at the run.start limit: named, then offered, then personal; the rest are skill_limit", () => {
    const many = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => sk(`${prefix}-${String(i).padStart(2, "0")}`));
    const r = resolveEffective(
      with_({
        agent: { skills: many("named", 32) },
        user: { skills: many("mine", 3) },
        team: { offeredSkills: many("offered", 32) },
      }),
    );
    expect(RUN_SKILLS_MAX).toBe(64);
    const names = r.ok ? r.value.skills.map((s) => s.name) : [];
    expect(names).toHaveLength(64);
    expect(names.slice(0, 64)).toEqual([
      ...many("named", 32).map((s) => s.name),
      ...many("offered", 32).map((s) => s.name),
    ]);
    expect(r.ok && r.value.omissions).toEqual(
      ["mine-00", "mine-01", "mine-02"].map((name) => ({
        kind: "skill",
        name,
        reason: "skill_limit",
      })),
    );
  });

  it("exactly at the limit, nothing is omitted", () => {
    const r = resolveEffective(
      with_({
        agent: { skills: Array.from({ length: 32 }, (_, i) => sk(`n${i}`)) },
        team: { offeredSkills: Array.from({ length: 32 }, (_, i) => sk(`o${i}`)) },
      }),
    );
    expect(r.ok && r.value.skills).toHaveLength(64);
    expect(r.ok && r.value.omissions).toEqual([]);
  });

  it("a blocklisted offered skill is left out", () => {
    const r = resolveEffective(
      with_({ team: { offeredSkills: [sk("bad", "bad"), sk("ok")] }, blockedHashes: ["bad"] }),
    );
    expect(r.ok && r.value.skills.map((s) => s.name)).toEqual(["ok"]);
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
    // KOBE-254: `all` is the team's list, still filtered by the user's connections; it names
    // nothing, so a connector the user has not connected is left out without a notice.
    ["all: the team's list, user-connected only", "all", ["a", "b"], ["a", "u"], ["a"], []],
    ["all with no team connectors", "all", [], ["u"], [], []],
  ] as const)("%s", (_n, agent, team, user, want, omissions) => {
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
