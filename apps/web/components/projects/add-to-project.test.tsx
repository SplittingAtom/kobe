// @vitest-environment happy-dom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  artifactProjectFileName,
  firstFreeName,
  numberedName,
  projectFolders,
} from "../../lib/projects/add-to-project";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { openApp } from "../chat/testing";

/**
 * KOBE-585 (ac-2): Add to project on the artifact header, the file tab and the file card, for the
 * conversation's owner only; the dialog asks for project, folder and name, and offers Add as copy
 * when the project already has that name.
 */
let fake: FakeKobe;
const enc = (s: string) => new TextEncoder().encode(s);

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  const settings = (window as unknown as { happyDOM?: { settings: Record<string, boolean> } })
    .happyDOM?.settings;
  if (settings) {
    settings.disableIframePageLoading = true;
    settings.handleDisabledFileLoadingAsSuccess = true;
  }
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function threadWith(artifact: Parameters<FakeKobe["addArtifact"]>[1]) {
  const t = fake.addThread("Reports");
  const u = fake.addEntry(t, null, { role: "user", content: "make it" });
  fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "done" }] });
  const id = fake.addArtifact(t, artifact);
  return { t, id };
}

/** A thread whose history holds an `open_file` card for `notes.md`. */
function threadWithOpenCard() {
  fake.workspaceFiles.set("notes.md", enc("# Notes\n"));
  const thread = fake.addThread("Notes");
  const u = fake.addEntry(thread, null, { role: "user", content: "Open notes.md" });
  const call = fake.addEntry(thread, u, {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "of1",
        name: "open_file",
        arguments: { path: "/workspace/notes.md" },
      },
    ],
  });
  const res = fake.addEntry(thread, call, {
    role: "toolResult",
    toolCallId: "of1",
    toolName: "open_file",
    content: [{ type: "text", text: '{"status":"opened","path":"notes.md"}' }],
    isError: false,
  });
  fake.addEntry(thread, res, { role: "assistant", content: [{ type: "text", text: "Opened." }] });
  return thread;
}

async function openArtifact(title: string) {
  const user = userEvent.setup();
  const list = await screen.findByRole("navigation", {
    name: "Artifacts and files in this conversation",
  });
  await user.click(within(list).getByRole("button", { name: `Open artifact ${title}` }));
  const panel = await screen.findByRole("region", { name: title });
  return { user, panel };
}

const imports = () =>
  fake.requests.filter((r) => r.method === "POST" && r.path.endsWith("/files/import"));

describe("Add to project helpers", () => {
  it("names copies, lists folders and prefills the artifact's name as the server does", () => {
    expect(numberedName("plan.md", 2)).toBe("plan-2.md");
    expect(numberedName("README", 3)).toBe("README-3");
    expect(numberedName(".env", 2)).toBe(".env-2");
    expect(projectFolders([{ path: "a/b/c.md" }, { path: "x.md" }, { path: "a/d.md" }])).toEqual([
      "a",
      "a/b",
    ]);
    expect(artifactProjectFileName("Q3 Plan: draft!", "markdown", null)).toBe("q3-plan-draft.md");
    expect(artifactProjectFileName("!!!", "code", "python")).toBe("artifact.py");
    expect(firstFreeName("plan.md", "", new Set(["plan.md", "plan-2.md"]))).toBe("plan-3.md");
    expect(firstFreeName("plan.md", "docs", new Set(["plan-2.md"]))).toBe("plan-2.md");
  });
});

describe("Add to project on an artifact (KOBE-585)", () => {
  it("adds the shown version with project, folder and name, then says where it is", async () => {
    const projectId = fake.addProject("Launch");
    fake.projectFiles.set(projectId, ["docs/old.md"]);
    const { t, id } = threadWith({
      kind: "markdown",
      title: "Q3 Plan",
      versions: ["# v1", "# v2"],
    });
    openApp(fake, t);
    const { user, panel } = await openArtifact("Q3 Plan");
    await within(panel).findByRole("heading", { name: "v2" });
    await user.click(within(panel).getByRole("button", { name: "Add q3-plan.md to a project" }));
    const dialog = await within(panel).findByRole("dialog", { name: "Add to project" });
    expect((within(dialog).getByLabelText("Project") as HTMLSelectElement).value).toBe(projectId);
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("q3-plan.md");
    await within(dialog).findByRole("option", { name: "docs" });
    await user.selectOptions(within(dialog).getByLabelText("Folder"), "docs");
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(
      await within(dialog).findByText("Added to Launch as projects/launch/docs/q3-plan.md"),
    ).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: "Open the project's files" })).toBeTruthy();
    expect(imports()).toMatchObject([
      {
        path: `/v1/projects/${projectId}/files/import`,
        team: fake.teamId,
        body: {
          source: { kind: "artifact", artifact_id: id, version: 2 },
          folder: "docs",
          name: "q3-plan.md",
        },
      },
    ]);
  });

  it("offers Add as copy on a clash and takes the next free name", async () => {
    const projectId = fake.addProject("Launch");
    fake.projectFiles.set(projectId, ["plan.md", "plan-2.md"]);
    const { t } = threadWith({ kind: "markdown", title: "Plan", versions: ["# p"] });
    openApp(fake, t);
    const { user, panel } = await openArtifact("Plan");
    await within(panel).findByRole("heading", { name: "p" });
    await user.click(within(panel).getByRole("button", { name: "Add plan.md to a project" }));
    const dialog = await within(panel).findByRole("dialog", { name: "Add to project" });
    await user.click(await within(dialog).findByRole("button", { name: "Add" }));
    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Add as copy" }));
    expect(
      await within(dialog).findByText("Added to Launch as projects/launch/plan-3.md"),
    ).toBeTruthy();
    expect(must(fake.projectFiles.get(projectId))).toContain("plan-3.md");
    // One request for the copy: the free name came from the project's file list.
    expect(imports().map((r) => (r.body as { name: string }).name)).toEqual([
      "plan.md",
      "plan-3.md",
    ]);
  });

  it("is absent for a shared reader", async () => {
    fake.addProject("Launch");
    const { t } = threadWith({ kind: "markdown", title: "Plan", versions: ["# p"] });
    Object.assign(must(fake.threads.get(t)), { read_only: true, owner_name: "Alice" });
    openApp(fake, t);
    const { panel } = await openArtifact("Plan");
    await within(panel).findByRole("heading", { name: "p" });
    expect(within(panel).getByRole("link", { name: "Download version 1" })).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: /to a project/ })).toBeNull();
  });
});

describe("Add to project on files (KOBE-585)", () => {
  it("the file card and the file tab add the owner's workspace file", async () => {
    const projectId = fake.addProject("Launch");
    const thread = threadWithOpenCard();
    openApp(fake, thread);
    const user = userEvent.setup();
    expect(await screen.findByText("Opened notes.md")).toBeTruthy();
    const cardAction = screen.getByRole("button", { name: "Add notes.md to a project" });
    // The file tab offers it too, once open.
    await user.click(screen.getByRole("button", { name: "Open notes.md again" }));
    const tab = await screen.findByRole("region", { name: "notes.md" });
    expect(within(tab).getByRole("button", { name: "Add notes.md to a project" })).toBeTruthy();
    await user.click(cardAction);
    const dialog = await screen.findByRole("dialog", { name: "Add to project" });
    await user.click(await within(dialog).findByRole("button", { name: "Add" }));
    expect(
      await within(dialog).findByText("Added to Launch as projects/launch/notes.md"),
    ).toBeTruthy();
    expect(imports()).toMatchObject([
      {
        path: `/v1/projects/${projectId}/files/import`,
        body: { source: { kind: "workspace_file", path: "notes.md" }, name: "notes.md" },
      },
    ]);
  });

  it("the file card has no action for a shared reader", async () => {
    fake.addProject("Launch");
    const thread = threadWithOpenCard();
    Object.assign(must(fake.threads.get(thread)), { read_only: true, owner_name: "Alice" });
    openApp(fake, thread);
    expect(await screen.findByText("Opened notes.md")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /to a project/ })).toBeNull();
  });
});
