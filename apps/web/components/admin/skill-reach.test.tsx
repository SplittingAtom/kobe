// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { AgentBuilderPage } from "./team/agent-builder/agent-builder-page";
import { SkillAdminPage } from "./team/skill-editor/skill-admin-page";
import { forbidNativeConfirm, renderTeam, stubApi } from "./testing";

beforeEach(forbidNativeConfirm);

/**
 * KOBE-297 ac-2, KOBE-316 ac-2: a team skill's page lists the agents that use it (named, or by its
 * access mode), lets builders set the access mode (Required: team admins only, with a warning from
 * 5), and opens a team agent's draft with the skill added ("Add to agent…"). Usage is shown to the
 * owner and team admins.
 */
const SKILL = {
  id: "s-1",
  scope: "team",
  slug: "report-writer",
  description: "Writes reports",
  latest_version: 1,
  owner_user_id: "u-other",
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-02T10:00:00Z",
};
const BUNDLE = zipSync({
  "SKILL.md": strToU8("---\nname: report-writer\ndescription: Writes reports\n---\nUse tables.\n"),
});
const agent = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  scope: "team",
  slug: id,
  name,
  via: null,
  exclusive: false,
  in_draft: false,
  can_edit: true,
  ...extra,
});
const REACH = {
  offer_to_all: false,
  access: "available",
  approved: true,
  agents: [
    agent("a-named", "Named", { via: "named" }),
    agent("a-plain", "Plain"),
    agent("a-draft", "Drafted", { in_draft: true }),
    agent("a-solo", "Solo", { exclusive: true }),
    agent("a-locked", "Locked", { can_edit: false }),
    agent("g-kobe", "Kobe", { scope: "gallery", can_edit: false }),
  ],
};
const OFFERED = {
  ...REACH,
  offer_to_all: true,
  access: "default_on",
  agents: REACH.agents.map((a) => (a.via === null && !a.exclusive ? { ...a, via: "offer" } : a)),
};
const USAGE = {
  uses: 3,
  last_used_at: "2026-10-15T09:00:00Z",
  agents: [
    { agent_id: "a-named", scope: "team", name: "Named", uses: 2 },
    { agent_id: null, scope: null, name: null, uses: 1 },
  ],
};
const BASE = {
  "GET /v1/skills/s-1": [200, { skill: SKILL }],
  "GET /v1/skills/s-1/versions/1/bundle": [200, BUNDLE],
} as const;
const ADMIN = { role: "team_admin" as const, permissions: ["team.skills.review"] };

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const reachList = async () => screen.findByRole("list", { name: "Agents using this skill" });
const rows = (list: HTMLElement) =>
  within(list)
    .getAllByRole("listitem")
    .map((li) => (li.textContent ?? "").replace(/\s+/g, " ").trim());

describe("team skill reach (KOBE-297)", () => {
  it("lists the agents that use it and states the rule", async () => {
    stubApi({
      ...BASE,
      "GET /v1/skills/s-1/reach": [200, REACH],
      "GET /v1/skills/s-1/usage": [200, USAGE],
    });
    renderTeam(<SkillAdminPage skillId="s-1" />, ADMIN);
    expect(rows(await reachList())).toEqual(["Named Team · names it"]);
    expect(screen.getByText(/reaches the agents that name it/)).toBeTruthy();
    expect(screen.getByText(/Used 3 times/)).toBeTruthy();
    expect(screen.getByText(/Named: 2/)).toBeTruthy();
    expect(screen.getByText(/Other agents: 1/)).toBeTruthy();
  });

  it("a team admin sets On by default; the list then shows every non-exclusive agent", async () => {
    const calls = stubApi({
      ...BASE,
      "GET /v1/skills/s-1/reach": [
        [200, REACH],
        [200, OFFERED],
      ],
      "GET /v1/skills/s-1/usage": [200, USAGE],
      "PUT /v1/skills/s-1/access": [200, { access: "default_on", required_count: 0 }],
    });
    renderTeam(<SkillAdminPage skillId="s-1" />, ADMIN);
    await reachList();
    const mode = screen.getByRole("combobox", { name: "Access" }) as HTMLSelectElement;
    expect(mode.value).toBe("available");
    await userEvent.selectOptions(mode, "default_on");
    const put = must(calls.find((c) => c.method === "PUT"));
    expect(JSON.parse(put.body as string)).toEqual({ access: "default_on" });
    await waitFor(async () =>
      expect(rows(await reachList())).toEqual([
        "Named Team · names it",
        "Plain Team · by its access mode",
        "Drafted Team · by its access mode",
        "Locked Team · by its access mode",
        "Kobe Built-in · by its access mode",
      ]),
    );
  });

  it("warns when the team reaches 5 Required skills", async () => {
    stubApi({
      ...BASE,
      "GET /v1/skills/s-1/reach": [200, REACH],
      "GET /v1/skills/s-1/usage": [200, USAGE],
      "PUT /v1/skills/s-1/access": [
        200,
        { access: "required", required_count: 5, warning: "many_required" },
      ],
    });
    renderTeam(<SkillAdminPage skillId="s-1" />, ADMIN);
    await reachList();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Access" }), "required");
    expect((await screen.findByText(/5 Required skills/)).textContent).toMatch(/limit of 64/);
  });

  it("shows the server's refusal when the team already has the most skills on for everyone", async () => {
    stubApi({
      ...BASE,
      "GET /v1/skills/s-1/reach": [200, REACH],
      "GET /v1/skills/s-1/usage": [200, USAGE],
      "PUT /v1/skills/s-1/access": [
        409,
        { code: "offer_limit", message: "A team can have at most 32 skills On by default." },
      ],
    });
    renderTeam(<SkillAdminPage skillId="s-1" />, ADMIN);
    await reachList();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Access" }), "default_on");
    expect((await screen.findByRole("alert")).textContent).toMatch(/at most 32 skills/);
  });

  it("Add to agent… opens the builder of a team agent the caller may edit, with the skill added", async () => {
    stubApi({
      ...BASE,
      "GET /v1/skills/s-1/reach": [200, REACH],
      "GET /v1/skills/s-1/usage": [403, { code: "forbidden", message: "no" }],
    });
    renderTeam(<SkillAdminPage skillId="s-1" />, {
      role: "builder",
      permissions: ["team.skills.publish"],
    });
    await reachList();
    // A builder sets the access mode, but not Required.
    const mode = screen.getByRole("combobox", { name: "Access" }) as HTMLSelectElement;
    expect(mode.disabled).toBe(false);
    expect([...mode.options].filter((o) => o.disabled).map((o) => o.value)).toEqual(["required"]);
    const select = screen.getByRole("combobox", { name: "Add to agent…" }) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "Choose an agent",
      "Plain",
      "Solo",
    ]);
    await userEvent.selectOptions(select, "a-plain");
    await userEvent.click(screen.getByRole("button", { name: "Open in builder" }));
    expect(assign).toHaveBeenCalledWith("/admin/team/agents/a-plain?addSkill=report-writer");
    // Usage is for the owner and team admins: a builder sees none, and no error.
    expect(screen.queryByText(/Used \d+ times/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains that nothing reaches runs before a version is approved", async () => {
    stubApi({
      ...BASE,
      "GET /v1/skills/s-1/reach": [200, { ...REACH, approved: false }],
      "GET /v1/skills/s-1/usage": [200, { uses: 0, last_used_at: null, agents: [] }],
    });
    renderTeam(<SkillAdminPage skillId="s-1" />, ADMIN);
    await reachList();
    expect(screen.getByText(/No version is approved yet/)).toBeTruthy();
    expect(screen.getByText("Not used yet.")).toBeTruthy();
  });
});

describe("agent builder with ?addSkill (KOBE-297)", () => {
  const AGENT = {
    id: "a-plain",
    scope: "team",
    slug: "plain",
    name: "Plain",
    status: "active",
    ownerUserId: "u-me",
    currentVersion: 1,
    revision: 1,
    updatedAt: "2026-10-01T10:00:00Z",
    canEdit: true,
    canPublish: true,
    canExport: true,
    starters: [],
    frontmatter: { name: "Plain", skills: ["other"] },
    prompt: "Be helpful.",
  };
  const READ = {
    "GET /v1/team/models": [200, { models: [], default: null }],
    "GET /v1/agents/a-plain": [200, { agent: AGENT }],
    "GET /v1/agents/a-plain/versions": [
      200,
      { current_version: 1, versions: [], next_before: null },
    ],
  } as const;

  it("adds the skill to the draft's skills, unsaved, and says so", async () => {
    stubApi(READ);
    renderTeam(<AgentBuilderPage agentId="a-plain" addSkill="report-writer" />, ADMIN);
    const skills = (await screen.findByLabelText("Skills")) as HTMLTextAreaElement;
    expect(skills.value).toBe("other\nreport-writer");
    expect(screen.getByText(/Added report-writer to this agent's skills/)).toBeTruthy();
  });

  it("ignores a malformed name", async () => {
    stubApi(READ);
    renderTeam(<AgentBuilderPage agentId="a-plain" addSkill="../Bad Name" />, ADMIN);
    const skills = (await screen.findByLabelText("Skills")) as HTMLTextAreaElement;
    expect(skills.value).toBe("other");
  });
});
