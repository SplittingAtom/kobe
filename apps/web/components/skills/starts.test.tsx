// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { forbidNativeConfirm, renderTeam, stubApi } from "../admin/testing";
import { CatalogForks } from "./catalog-forks";
import { NewDraft } from "./new-draft";
import { SkillList } from "./skill-list";

/** KOBE-322 (ac-1): each start makes a draft in the active team and opens it. */
const MEMBER = { role: "member", permissions: ["team.personal.create"] } as const;
const DRAFT = { id: "d-9", name: "x", shared: false, mine: true, rev: 1 };
const TEMPLATES = {
  templates: [{ id: "house-style", title: "House style", summary: "Your team's writing rules." }],
};

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  forbidNativeConfirm();
  assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("New draft", () => {
  it("starts from a template, blank by default", async () => {
    const calls = stubApi({
      "GET /v1/skills/drafts/templates": [200, TEMPLATES],
      "POST /v1/skills/drafts": [201, { draft: DRAFT }],
    });
    renderTeam(<NewDraft teamId="t-1" />, MEMBER);
    await userEvent.type(screen.getByLabelText("Skill name"), "our-style");
    await userEvent.selectOptions(
      await screen.findByLabelText("Start from"),
      "Template: House style",
    );
    expect(screen.getByText("Your team's writing rules.")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Start a draft" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/me/skills/drafts/d-9"));
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(post.body as string)).toEqual({ name: "our-style", template: "house-style" });
  });

  it("uploads a zip or a SKILL.md as a draft", async () => {
    const calls = stubApi({
      "GET /v1/skills/drafts/templates": [200, TEMPLATES],
      "POST /v1/skills/drafts/upload?kind=zip": [201, { draft: DRAFT }],
      "POST /v1/skills/drafts/upload?kind=skill_md": [
        400,
        { code: "invalid_skill_md", message: "SKILL.md must start with a YAML frontmatter block." },
      ],
    });
    renderTeam(<NewDraft teamId="t-1" />, MEMBER);
    const input = screen.getByLabelText("Upload a zip or SKILL.md");
    await userEvent.upload(input, new File([new Uint8Array([80, 75])], "skill.zip"));
    await userEvent.click(screen.getByRole("button", { name: "Upload as a draft" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/me/skills/drafts/d-9"));
    const zip = must(calls.find((c) => c.url.endsWith("kind=zip")));
    expect(zip.headers.get("content-type")).toBe("application/zip");
    await userEvent.upload(input, new File(["no frontmatter"], "SKILL.md"));
    await userEvent.click(screen.getByRole("button", { name: "Upload as a draft" }));
    expect(await screen.findByText(/must start with a YAML frontmatter/)).toBeDefined();
  });
});

describe("Fork (Edit in Workbench)", () => {
  const SKILL = {
    id: "s-1",
    scope: "team",
    slug: "house-style",
    description: "Style.",
    latest_version: 2,
    latest_semver: "1.2.0",
    owner_user_id: "u-2",
    created_at: "x",
    updated_at: "2026-10-02T10:00:00Z",
  };

  it("forks a team skill's latest version under its own name: the edit path", async () => {
    const calls = stubApi({
      "GET /v1/skills?scope=team": [200, { skills: [SKILL] }],
      "POST /v1/skills/drafts/fork": [201, { draft: DRAFT }],
    });
    renderTeam(<SkillList scope="team" />, MEMBER);
    await userEvent.click(
      await screen.findByRole("button", { name: "Edit house-style in the Workbench" }),
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/me/skills/drafts/d-9"));
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(post.body as string)).toEqual({ source: { kind: "team", skillId: "s-1" } });
  });

  it("forks an installed catalog skill under a name of its own", async () => {
    const calls = stubApi({
      "GET /v1/me/skills/enablements": [
        200,
        {
          personal: [],
          team: [],
          catalog: [{ skill_id: "c-1", name: "xlsx", access: "available", enabled: true }],
        },
      ],
      "POST /v1/skills/drafts/fork": [201, { draft: DRAFT }],
    });
    renderTeam(<CatalogForks />, MEMBER);
    await userEvent.click(
      await screen.findByRole("button", { name: "Fork xlsx into the Workbench" }),
    );
    await waitFor(() => expect(assign).toHaveBeenCalled());
    const post = must(calls.find((c) => c.method === "POST"));
    expect(JSON.parse(post.body as string)).toEqual({
      source: { kind: "catalog", skillId: "c-1" },
      name: "xlsx-custom",
    });
  });
});
