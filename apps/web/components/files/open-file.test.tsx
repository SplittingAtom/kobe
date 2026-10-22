// @vitest-environment happy-dom
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { composer, openApp } from "../chat/testing";

/**
 * KOBE-484 (ac-2): the agent's `open_file` opens the workspace file's tab for the thread's owner
 * on the live `file.opened` event (text in the editor with Rendered/Raw), shows "Opened <name>"
 * with Open again, never reopens old files after a reload, and offers a shared reader no Open.
 */
let fake: FakeKobe;
const enc = (s: string) => new TextEncoder().encode(s);

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const editorToolbar = () => screen.queryByRole("toolbar", { name: "notes.md view" });

/** A thread whose history holds an `open_file` call for `notes.md` (tool call `of1`). */
function threadWithOpenCall() {
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

describe("open_file in the web (KOBE-484, ac-2)", () => {
  it("a live file.opened opens the file in the editor tab, once, with an Opened card", async () => {
    fake.workspaceFiles.set("notes.md", enc("# Notes\n"));
    const thread = fake.addThread("Notes");
    openApp(fake, thread);
    const user = userEvent.setup();
    await user.type(await composer(), "Open notes.md{Enter}");
    await waitFor(() => expect(fake.submittedBodies).toHaveLength(1));
    const run = must([...fake.runs.values()].at(-1)).run_id;
    act(() => fake.agent.toolCall(run, "of9", "open_file", { path: "notes.md" }));
    await screen.findByRole("region", { name: /Tool call open_file/ });
    expect(editorToolbar()).toBeNull();
    act(() => fake.emit(run, "file.opened", { tool_call_id: "of9", path: "notes.md" }));
    expect(await screen.findByRole("toolbar", { name: "notes.md view" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rendered" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Raw" })).toBeTruthy();
    expect(await screen.findByText("Opened notes.md")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open notes.md again" })).toBeTruthy();
  });

  it("after a reload nothing opens by itself; Open again opens the editor", async () => {
    const thread = threadWithOpenCall();
    openApp(fake, thread);
    expect(await screen.findByText("Opened notes.md")).toBeTruthy();
    expect(editorToolbar()).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Open notes.md again" }));
    expect(await screen.findByRole("toolbar", { name: "notes.md view" })).toBeTruthy();
  });

  it("a replayed backlog of another tab's run does not open the file", async () => {
    fake.workspaceFiles.set("notes.md", enc("# Notes\n"));
    const thread = fake.addThread("Notes");
    const runId = fake.queueRetry(thread, "Open notes.md");
    const run = fake.run(runId);
    Object.assign(run, { status: "running", retry_of_run_id: undefined });
    fake.emit(runId, "run.started", { thread_id: thread, agent_id: null, agent_version: null });
    fake.agent.toolCall(runId, "of2", "open_file", { path: "notes.md" });
    fake.emit(runId, "file.opened", { tool_call_id: "of2", path: "notes.md" });
    openApp(fake, thread);
    expect(await screen.findByText("Opened notes.md")).toBeTruthy();
    expect(editorToolbar()).toBeNull();
  });

  it("a shared reader sees the card without Open again", async () => {
    const thread = threadWithOpenCall();
    Object.assign(must(fake.threads.get(thread)), { read_only: true, owner_name: "Alice" });
    openApp(fake, thread);
    expect(await screen.findByText("Opened notes.md")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open notes.md again" })).toBeNull();
  });

  it("a failed open_file shows no card", async () => {
    fake.workspaceFiles.set("other.md", enc("x"));
    const thread = fake.addThread("Notes");
    const u = fake.addEntry(thread, null, { role: "user", content: "Open nope.md" });
    const call = fake.addEntry(thread, u, {
      role: "assistant",
      content: [{ type: "toolCall", id: "of3", name: "open_file", arguments: { path: "nope.md" } }],
    });
    const res = fake.addEntry(thread, call, {
      role: "toolResult",
      toolCallId: "of3",
      toolName: "open_file",
      content: [{ type: "text", text: "not_found: There is no such file in the workspace." }],
      isError: true,
    });
    fake.addEntry(thread, res, {
      role: "assistant",
      content: [{ type: "text", text: "Missing." }],
    });
    openApp(fake, thread);
    expect(await screen.findByText("Missing.")).toBeTruthy();
    expect(screen.queryByText("Opened nope.md")).toBeNull();
  });
});
