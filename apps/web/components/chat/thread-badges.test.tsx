// @vitest-environment happy-dom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { composer, openApp } from "./testing";

/**
 * KOBE-488 (ac-2..ac-4): the badge row under the thread title lists the thread's artifacts and the
 * workspace files the agent wrote, with distinct icons and names; each opens in its own viewer or
 * editor; a live write adds its badge, and a file gone from the list loses it.
 */
let fake: FakeKobe;
const enc = (s: string) => new TextEncoder().encode(s);
const ROW = "Artifacts and files in this conversation";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A wire-cased file entry as `GET /v1/threads/{id}/files` answers it. */
function entry(path: string, size = 8) {
  return {
    name: path.slice(path.lastIndexOf("/") + 1),
    path,
    type: "file",
    size_bytes: size,
    mtime: "2026-10-22T10:00:00Z",
    source: "synced",
    owner: "sandbox",
    area: "workspace",
  };
}

function threadWithBoth() {
  const t = fake.addThread("Budget");
  const u = fake.addEntry(t, null, { role: "user", content: "make it" });
  fake.addEntry(t, u, { role: "assistant", content: [{ type: "text", text: "done" }] });
  fake.addArtifact(t, { kind: "markdown", title: "Budget summary", versions: ["# Summary"] });
  fake.workspaceFiles.set("reports/budget-notes.md", enc("# Notes\n"));
  fake.threadFiles.set(t, [entry("reports/budget-notes.md")]);
  return t;
}

describe("thread badges (KOBE-488)", () => {
  it("lists artifacts and files with distinct names, icons and full-name titles", async () => {
    openApp(fake, threadWithBoth());
    const row = await screen.findByRole("navigation", { name: ROW });
    const artifact = await within(row).findByRole("button", {
      name: "Open artifact Budget summary",
    });
    const file = await within(row).findByRole("button", {
      name: "Open file reports/budget-notes.md",
    });
    expect(artifact.textContent).toBe("Budget summary");
    expect(file.textContent).toBe("budget-notes.md");
    expect(file.getAttribute("title")).toBe("reports/budget-notes.md");
    expect(artifact.getAttribute("title")).toBe("Budget summary");
    const icon = (el: HTMLElement) => must(el.querySelector("svg")).getAttribute("class") ?? "";
    expect(icon(artifact)).not.toBe(icon(file));
    expect(row.className).toContain("flex-wrap");
  });

  it("opens an artifact in its viewer and a file in the editor, reflecting the open tab", async () => {
    openApp(fake, threadWithBoth());
    const user = userEvent.setup();
    const row = await screen.findByRole("navigation", { name: ROW });
    const artifact = await within(row).findByRole("button", {
      name: "Open artifact Budget summary",
    });
    await user.click(artifact);
    const panel = await screen.findByRole("region", { name: "Budget summary" });
    expect(await within(panel).findByRole("heading", { name: "Summary" })).toBeTruthy();
    expect(artifact.getAttribute("aria-expanded")).toBe("true");

    const file = within(row).getByRole("button", { name: "Open file reports/budget-notes.md" });
    await user.click(file);
    expect(await screen.findByRole("toolbar", { name: "budget-notes.md view" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Raw" }));
    expect(await screen.findByLabelText("Edit budget-notes.md")).toBeTruthy();
    expect(file.getAttribute("aria-expanded")).toBe("true");
    expect(artifact.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows a shared reader the artifact badges only", async () => {
    const t = threadWithBoth();
    Object.assign(must(fake.threads.get(t)), { read_only: true, owner_name: "Alice" });
    fake.threadFilesHidden.add(t);
    openApp(fake, t);
    const row = await screen.findByRole("navigation", { name: ROW });
    expect(
      await within(row).findByRole("button", { name: "Open artifact Budget summary" }),
    ).toBeTruthy();
    await waitFor(() => expect(fake.threadFilesReads).toBeGreaterThan(0));
    expect(within(row).queryByRole("button", { name: /^Open file/ })).toBeNull();
  });

  it("adds a file's badge on a live write once synced, and drops it once the file is gone", async () => {
    const t = fake.addThread("Live");
    fake.workspaceFiles.set("notes.md", enc("# Notes\n"));
    openApp(fake, t);
    const user = userEvent.setup();
    await user.type(await composer(), "write it{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
    const run = must(fake.activeRun(t)).run_id;
    expect(screen.queryByRole("navigation", { name: ROW })).toBeNull();

    act(() => fake.agent.toolCall(run, "w1", "write", { path: "/workspace/notes.md" }));
    act(() => fake.agent.toolResult(run, "w1", "write", "ok"));
    // Not synced yet when the result arrives: the list is read again until it lists the file.
    await waitFor(() => expect(fake.threadFilesReads).toBeGreaterThan(1));
    fake.threadFiles.set(t, [entry("notes.md")]);
    expect(
      await screen.findByRole("button", { name: "Open file notes.md" }, { timeout: 4_000 }),
    ).toBeTruthy();

    // A failed edit is no write: no new read of the list.
    const reads = fake.threadFilesReads;
    act(() => fake.agent.toolCall(run, "w2", "edit", { path: "notes.md" }));
    act(() => fake.agent.toolResult(run, "w2", "edit", "no match", true));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(fake.threadFilesReads).toBe(reads);

    // An agent-internal write is never listed: no read for it.
    act(() => fake.agent.toolCall(run, "w4", "write", { path: "/workspace/.kobe/state.json" }));
    act(() => fake.agent.toolResult(run, "w4", "write", "ok"));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(fake.threadFilesReads).toBe(reads);

    // The file was deleted; the next write's refresh drops its badge.
    fake.threadFiles.set(t, [entry("other.md")]);
    act(() => fake.agent.toolCall(run, "w3", "write", { path: "other.md" }));
    act(() => fake.agent.toolResult(run, "w3", "write", "ok"));
    expect(await screen.findByRole("button", { name: "Open file other.md" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open file notes.md" })).toBeNull();
  });
});
