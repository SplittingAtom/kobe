// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { COMMANDS } from "../../lib/shell/commands";
import { forbidNativeConfirm, renderTeam, stubApi, summary } from "../admin/testing";
import { skillTab } from "../../lib/skills/tabs";
import { SkillsPage } from "./skills-page";

/** KOBE-321 (ac-1): the Skills page's tabs; the Workbench lists my drafts and shared ones. */
const MEMBER = { role: "member", permissions: ["team.personal.create"] } as const;
const SKILL = (id: string, scope: string, slug: string) => ({
  id,
  scope,
  slug,
  description: `${slug} things`,
  latest_version: 1,
  latest_semver: "1.0.0",
  owner_user_id: "u-me",
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-02T10:00:00Z",
});
const DRAFT = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  shared: false,
  mine: true,
  ownerUserId: "u-me",
  startedFrom: "blank",
  parentRef: null,
  fromConversation: false,
  coEdited: false,
  rev: 1,
  sizeBytes: 10,
  fileCount: 1,
  createdAt: "2026-10-01T10:00:00Z",
  updatedAt: "2026-10-02T10:00:00Z",
  updatedBy: "u-me",
  ...extra,
});
const ROUTES = {
  "GET /v1/skills?scope=team": [200, { skills: [SKILL("t-1", "team", "house-style")] }],
  "GET /v1/skills?scope=personal": [200, { skills: [SKILL("p-1", "personal", "my-notes")] }],
  "GET /v1/me/skills/enablements": [200, { personal: [], team: [], catalog: [] }],
  "GET /v1/skills/catalog": [200, { skills: [], tags: [] }],
  "GET /v1/skills/drafts": [
    200,
    {
      drafts: [
        DRAFT("d-1", "report-writer"),
        DRAFT("d-2", "team-checklist", { mine: false, shared: true, ownerUserId: "u-2" }),
      ],
      next: "c-1",
    },
  ],
  "GET /v1/skills/drafts?cursor=c-1": [200, { drafts: [DRAFT("d-3", "older-draft")], next: null }],
} as const;

let assign: ReturnType<typeof vi.fn>;
let replaced: string[];
beforeEach(() => {
  forbidNativeConfirm();
  assign = vi.fn();
  replaced = [];
  vi.stubGlobal("location", { ...window.location, assign, href: "http://kobe.test/me/skills" });
  vi.spyOn(window.history, "replaceState").mockImplementation((_s, _t, url) => {
    replaced.push(String(url));
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Skills page", () => {
  it("has the Catalog, Team, Mine and Workbench tabs, Team first open", async () => {
    stubApi(ROUTES);
    renderTeam(<SkillsPage />, MEMBER);
    const tabs = within(screen.getByRole("tablist", { name: "Skills" })).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Catalog", "Team", "Mine", "Workbench"]);
    expect(screen.getByRole("tab", { name: "Team" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByText("house-style")).toBeDefined();
  });

  it("shows my personal skills and choices on Mine, and the Catalog tab (KOBE-336)", async () => {
    const calls = stubApi(ROUTES);
    renderTeam(<SkillsPage initialTab="mine" />, MEMBER);
    expect(await screen.findByText("my-notes")).toBeDefined();
    expect(summary(calls)).toEqual(
      expect.arrayContaining(["GET /v1/skills?scope=personal", "GET /v1/me/skills/enablements"]),
    );
    await userEvent.click(screen.getByRole("tab", { name: "Catalog" }));
    expect(await screen.findByText("No catalog skill matches.")).toBeDefined();
    expect(replaced.at(-1)).toContain("tab=catalog");
  });

  it("lists my drafts and the ones shared with me in the Workbench, paged", async () => {
    stubApi(ROUTES);
    renderTeam(<SkillsPage initialTab="workbench" />, MEMBER);
    const mine = await screen.findByRole("link", { name: "report-writer" });
    expect(mine.getAttribute("href")).toBe("/me/skills/drafts/d-1");
    const row = must(screen.getByRole("link", { name: "team-checklist" }).closest("tr"));
    expect(within(row).getByText("Shared with you")).toBeDefined();
    expect(within(must(mine.closest("tr"))).getByText("Private")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Show more drafts" }));
    expect(await screen.findByRole("link", { name: "older-draft" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Show more drafts" })).toBeNull();
  });

  it("starts a draft and opens it in the editor", async () => {
    const calls = stubApi({
      ...ROUTES,
      "POST /v1/skills/drafts": [201, { draft: DRAFT("d-9", "new-skill") }],
    });
    renderTeam(<SkillsPage initialTab="workbench" />, MEMBER);
    await userEvent.click(await screen.findByRole("button", { name: "Start a draft" }));
    expect(screen.getByText("Use lowercase letters, digits and hyphens.")).toBeDefined();
    await userEvent.type(screen.getByLabelText("Skill name"), "new-skill");
    await userEvent.click(screen.getByRole("button", { name: "Start a draft" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/me/skills/drafts/d-9"));
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(post.body as string)).toEqual({ name: "new-skill" });
  });

  it("offers no new draft to a role that can't write skills", async () => {
    stubApi(ROUTES);
    renderTeam(<SkillsPage initialTab="workbench" />, { role: "member", permissions: [] });
    expect(await screen.findByText(/doesn't allow writing skills/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Start a draft" })).toBeNull();
  });
});

describe("reaching the Skills page", () => {
  it("is a bar area and a palette command (/skills)", () => {
    const command = must(COMMANDS.find((c) => c.id === "skills"));
    expect(command).toMatchObject({
      scope: "bar",
      group: "areas",
      href: "/me/skills",
      slash: "skills",
    });
  });

  it("reads ?tab=, falling back to Team", () => {
    expect(skillTab("workbench")).toBe("workbench");
    expect(skillTab(["mine", "team"])).toBe("mine");
    expect(skillTab("nope")).toBe("team");
    expect(skillTab(undefined)).toBe("team");
  });
});
