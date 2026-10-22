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

  it("downloads a skill's latest version as a portable zip, with or without evals (KOBE-345)", async () => {
    const calls = stubApi({
      "GET /v1/skills?scope=team": [200, { skills: [SKILL] }],
      "GET /v1/skills/s-1/versions/2/export?format=portable": [200, new Uint8Array([80, 75])],
      "GET /v1/skills/s-1/versions/2/export?format=portable_evals": [200, new Uint8Array([80, 75])],
    });
    renderTeam(<SkillList scope="team" />, MEMBER);
    await userEvent.click(
      await screen.findByRole("button", { name: /^Download house-style v[0-9.]+$/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: /with evals$/ }));
    await waitFor(() =>
      expect(calls.filter((c) => c.url.includes("/export?format=")).map((c) => c.url)).toEqual([
        "/v1/skills/s-1/versions/2/export?format=portable",
        "/v1/skills/s-1/versions/2/export?format=portable_evals",
      ]),
    );
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

describe("Import (KOBE-344)", () => {
  const BUILDER = {
    role: "builder",
    permissions: ["team.personal.create", "team.skills.publish"],
  } as const;

  it("imports a git commit's folder as a draft; members don't see it", async () => {
    const calls = stubApi({
      "GET /v1/skills/drafts/templates": [200, TEMPLATES],
      "POST /v1/skills/drafts/import": [201, { draft: DRAFT }],
    });
    renderTeam(<NewDraft teamId="t-1" />, BUILDER);
    const form = await screen.findByRole("form", { name: "Import a skill" });
    expect(form).toBeDefined();
    await userEvent.type(
      screen.getByLabelText("Repository URL (https)"),
      "https://github.com/acme/skills",
    );
    await userEvent.type(screen.getByLabelText("Commit SHA"), "A".repeat(40));
    await userEvent.type(screen.getByLabelText("Folder (optional)"), "skills/pdf");
    await userEvent.click(screen.getByRole("button", { name: "Import as a draft" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/me/skills/drafts/d-9"));
    const post = must(calls.find((c) => c.url === "/v1/skills/drafts/import"));
    expect(JSON.parse(post.body as string)).toEqual({
      kind: "git",
      url: "https://github.com/acme/skills",
      commit: "a".repeat(40),
      path: "skills/pdf",
    });
    cleanup();
    stubApi({ "GET /v1/skills/drafts/templates": [200, TEMPLATES] });
    renderTeam(<NewDraft teamId="t-1" />, MEMBER);
    await screen.findByLabelText("Skill name");
    expect(screen.queryByRole("form", { name: "Import a skill" })).toBeNull();
  });

  it("shows the server's refusal", async () => {
    stubApi({
      "GET /v1/skills/drafts/templates": [200, TEMPLATES],
      "POST /v1/skills/drafts/import": [
        403,
        {
          code: "import_not_allowed",
          message:
            "That host (or owner) is not on this site's import allowlist. A Site admin can add it.",
        },
      ],
    });
    renderTeam(<NewDraft teamId="t-1" />, BUILDER);
    await userEvent.selectOptions(await screen.findByLabelText("Import from"), "Zip URL");
    await userEvent.type(
      screen.getByLabelText("Zip URL (https)"),
      "https://evil.example.org/x.zip",
    );
    await userEvent.type(screen.getByLabelText("SHA-256 of the zip"), "b".repeat(64));
    await userEvent.click(screen.getByRole("button", { name: "Import as a draft" }));
    expect(await screen.findByText(/not on this site's import allowlist/)).toBeDefined();
  });
});
