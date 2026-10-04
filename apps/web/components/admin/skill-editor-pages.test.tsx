// @vitest-environment happy-dom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { must } from "../../lib/testing/must";
import { SkillEditorPage } from "./team/skill-editor/skill-editor-page";
import { SkillsPage } from "./team/skill-editor/skills-page";
import { renderTeam, stubApi, type RecordedCall } from "./testing";

const SKILL = {
  id: "s-1",
  scope: "team",
  slug: "report-writer",
  description: "Writes reports",
  latest_version: 2,
  owner_user_id: "u-me",
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-02T10:00:00Z",
};
const PNG = new Uint8Array([0x89, 0x50, 0, 1, 0xff]);
const BUNDLE = zipSync({
  "SKILL.md": strToU8(
    "---\nname: report-writer\ndescription: Writes reports\nlicense: MIT\n---\nUse tables.\n",
  ),
  "refs/guide.md": strToU8("# Guide"),
  "img/logo.png": PNG,
});
const SAVED = (version: number) => ({
  skill: { ...SKILL, latest_version: version },
  version: { version, content_hash: "h", size_bytes: 1, file_count: 3, uploaded_at: "x" },
});
const EXISTING = {
  "GET /v1/skills/s-1": [200, { skill: SKILL }],
  "GET /v1/skills/s-1/versions/2/bundle": [200, BUNDLE],
} as const;

const uploaded = (calls: RecordedCall[]) => {
  const call = must(calls.find((c) => c.method === "POST"));
  expect(call.headers.get("content-type")).toBe("application/zip");
  return unzipSync(call.body as Uint8Array);
};

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  assign = vi.fn();
  vi.stubGlobal("location", { ...window.location, assign });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Blocklisted skill version (KOBE-81)", () => {
  it("shows the server's message when the bundle is refused", async () => {
    stubApi({
      "GET /v1/skills/s-1": [200, { skill: SKILL }],
      "GET /v1/skills/s-1/versions/2/bundle": [
        422,
        {
          code: "skill_blocklisted",
          message: "This skill version is on the install's blocklist and can't be opened.",
        },
      ],
    });
    renderTeam(<SkillEditorPage skillId="s-1" />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("on the install's blocklist");
  });
});

describe("Skills list", () => {
  it("lists skills with a link to edit each", async () => {
    stubApi({ "GET /v1/skills": [200, { skills: [SKILL] }] });
    renderTeam(<SkillsPage />);
    const link = await screen.findByRole("link", { name: "report-writer" });
    expect(link.getAttribute("href")).toBe("/admin/team/skills/s-1");
    expect(screen.getByRole("link", { name: "New skill" }).getAttribute("href")).toBe(
      "/admin/team/skills/new",
    );
  });
});

describe("Skill editor: create", () => {
  it("builds a zip from the form and uploads it to the chosen scope", async () => {
    const calls = stubApi({ "POST /v1/skills?scope=personal": [201, SAVED(1)] });
    renderTeam(<SkillEditorPage />);
    await userEvent.selectOptions(screen.getByLabelText("Scope"), "personal");
    await userEvent.type(screen.getByLabelText("Name"), "demo-skill");
    await userEvent.type(screen.getByLabelText("Description"), "Does demos");
    await userEvent.type(screen.getByLabelText("Instructions (SKILL.md body)"), "Be brief.");
    await userEvent.click(screen.getByRole("button", { name: "Add file" }));
    await userEvent.type(screen.getByLabelText("Path of file 1"), "refs/a.txt");
    await userEvent.type(screen.getByLabelText("Contents of file 1"), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Create skill" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/admin/team/skills/s-1"));
    const files = uploaded(calls);
    expect(Object.keys(files).sort()).toEqual(["SKILL.md", "refs/a.txt"]);
    expect(strFromU8(must(files["SKILL.md"]))).toBe(
      "---\nname: demo-skill\ndescription: Does demos\n---\nBe brief.",
    );
    expect(strFromU8(must(files["refs/a.txt"]))).toBe("hello");
    expect(calls[0]?.headers.get("x-kobe-team")).toBe("t-1");
  });

  it("shows field errors with accessible labels and sends nothing", async () => {
    const calls = stubApi({});
    renderTeam(<SkillEditorPage />);
    await userEvent.type(screen.getByLabelText("Name"), "Bad Name");
    await userEvent.click(screen.getByRole("button", { name: "Add file" }));
    await userEvent.type(screen.getByLabelText("Path of file 1"), "../x");
    await userEvent.click(screen.getByRole("button", { name: "Create skill" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/fix 3 problems/i);
    expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText("Description").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText("Path of file 1").getAttribute("aria-invalid")).toBe("true");
    expect(calls).toEqual([]);
  });

  it("shows the server's message when it refuses the upload", async () => {
    stubApi({
      "POST /v1/skills?scope=team": [
        429,
        { code: "rate_limited", message: "Too many uploads. Wait a few minutes and try again." },
      ],
    });
    renderTeam(<SkillEditorPage />);
    await userEvent.type(screen.getByLabelText("Name"), "demo");
    await userEvent.type(screen.getByLabelText("Description"), "d");
    await userEvent.click(screen.getByRole("button", { name: "Create skill" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/too many uploads/i);
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("Skill editor: edit", () => {
  it("loads the current version and saves changes as a new version, keeping binaries", async () => {
    const calls = stubApi({ ...EXISTING, "POST /v1/skills?scope=team": [201, SAVED(3)] });
    renderTeam(<SkillEditorPage skillId="s-1" />);
    const body = await screen.findByLabelText("Instructions (SKILL.md body)");
    expect((body as HTMLTextAreaElement).value).toBe("Use tables.\n");
    expect((screen.getByLabelText("Name") as HTMLInputElement).readOnly).toBe(true);
    expect((screen.getByLabelText("Contents of file 1") as HTMLTextAreaElement).value).toBe(
      "# Guide",
    );
    expect(screen.getByText(/img\/logo\.png/)).toBeTruthy();
    expect(screen.getByText("Current version: v2.")).toBeTruthy();

    await userEvent.type(body, "More.");
    await userEvent.click(screen.getByRole("button", { name: "Save as new version" }));
    await waitFor(() => expect(screen.getByText("Saved as v3.")).toBeTruthy());
    expect(screen.getByText("Current version: v3.")).toBeTruthy();

    const files = uploaded(calls);
    expect(Object.keys(files).sort()).toEqual(["SKILL.md", "img/logo.png", "refs/guide.md"]);
    expect(files["img/logo.png"]).toEqual(PNG);
    const md = strFromU8(must(files["SKILL.md"]));
    expect(md).toContain("name: report-writer");
    expect(md).toContain("license: MIT");
    expect(md).toContain("Use tables.\nMore.");
  });

  it("explains an unchanged save from the server", async () => {
    stubApi({
      ...EXISTING,
      "POST /v1/skills?scope=team": [
        409,
        { code: "unchanged", message: "That bundle is identical to the current version." },
      ],
    });
    renderTeam(<SkillEditorPage skillId="s-1" />);
    await userEvent.click(await screen.findByRole("button", { name: "Save as new version" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/identical/);
  });

  it("shows an error when the skill can't be found", async () => {
    stubApi({ "GET /v1/skills/s-9": [404, { code: "not_found", message: "No such skill." }] });
    renderTeam(<SkillEditorPage skillId="s-9" />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/no such skill/i);
  });
});
