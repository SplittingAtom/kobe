// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { renderTeam, stubApi } from "../admin/testing";
import { SkillEditorPage } from "../admin/team/skill-editor/skill-editor-page";
import { SkillsPage } from "../admin/team/skill-editor/skills-page";

const MEMBER = { role: "member", permissions: ["team.personal.create"] } as const;
const SKILL = {
  id: "s-1",
  scope: "personal",
  slug: "my-notes",
  description: "Notes",
  latest_version: 1,
  owner_user_id: "u-me",
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-02T10:00:00Z",
};
const SAVED = {
  skill: SKILL,
  version: { version: 1, content_hash: "h", size_bytes: 1, file_count: 1, uploaded_at: "x" },
};
const BUNDLE = zipSync({
  "SKILL.md": strToU8("---\nname: my-notes\ndescription: Notes\n---\nBe brief.\n"),
});

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("My skills list", () => {
  it("asks for personal skills only and links inside /me/skills", async () => {
    const calls = stubApi({ "GET /v1/skills?scope=personal": [200, { skills: [SKILL] }] });
    renderTeam(<SkillsPage area="my" />, MEMBER);
    const link = await screen.findByRole("link", { name: "my-notes" });
    expect(link.getAttribute("href")).toBe("/me/skills/s-1");
    expect(screen.getByRole("link", { name: "New skill" }).getAttribute("href")).toBe(
      "/me/skills/new",
    );
    expect(calls.map((c) => c.url)).toEqual(["/v1/skills?scope=personal"]);
    expect(screen.queryByText("Scope")).toBeNull();
  });
});

describe("My skill editor", () => {
  it("creates a personal skill without a scope choice and without admin permissions", async () => {
    const calls = stubApi({ "POST /v1/skills?scope=personal": [201, SAVED] });
    renderTeam(<SkillEditorPage area="my" />, MEMBER);
    expect(screen.queryByLabelText("Scope")).toBeNull();
    expect(screen.getByRole("link", { name: "My skills" }).getAttribute("href")).toBe("/me/skills");
    await userEvent.type(screen.getByLabelText("Name"), "my-notes");
    await userEvent.type(screen.getByLabelText("Description"), "Notes");
    await userEvent.type(screen.getByLabelText("Instructions (SKILL.md body)"), "Be brief.");
    await userEvent.click(screen.getByRole("button", { name: "Create skill" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/me/skills/s-1"));
    const post = must(calls.find((c) => c.method === "POST"));
    const files = unzipSync(post.body as Uint8Array);
    expect(strFromU8(must(files["SKILL.md"]))).toContain("name: my-notes");
  });

  it("saves an edit as the next personal version", async () => {
    const calls = stubApi({
      "GET /v1/skills/s-1": [200, { skill: SKILL }],
      "GET /v1/skills/s-1/versions/1/bundle": [200, BUNDLE],
      "POST /v1/skills?scope=personal": [
        201,
        { ...SAVED, version: { ...SAVED.version, version: 2 } },
      ],
    });
    renderTeam(<SkillEditorPage area="my" skillId="s-1" />, MEMBER);
    const body = await screen.findByLabelText("Instructions (SKILL.md body)");
    await userEvent.type(body, "More.");
    await userEvent.click(screen.getByRole("button", { name: "Save as new version" }));
    await waitFor(() => expect(screen.getByText("Saved as v2.")).toBeTruthy());
    expect(calls.some((c) => c.method === "POST")).toBe(true);
  });

  it("shows the server's answer when another member's skill is requested", async () => {
    stubApi({ "GET /v1/skills/s-9": [404, { code: "not_found", message: "No such skill." }] });
    renderTeam(<SkillEditorPage area="my" skillId="s-9" />, MEMBER);
    expect((await screen.findByRole("alert")).textContent).toMatch(/no such skill/i);
  });
});
