// @vitest-environment happy-dom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { getChunks } from "@codemirror/merge";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tabsKey } from "../../lib/chat/artifact-tabs";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { sha256Hex } from "../../lib/files/editor";
import { must } from "../../lib/testing/must";
import { composer, openApp } from "../chat/testing";
import { AGENT_CHANGED_BANNER, UPDATED_NOTE } from "./outside-change-notice";

/**
 * KOBE-491: an open file tab notices the agent's change to its file. Clean: it reloads in place
 * and says so (ac-1). With a draft: nothing is replaced; the banner offers Compare, Keep mine and
 * Take theirs (ac-2). Saving after the change offers the same choices (ac-3). Checks come from a
 * live write, the run's end and window focus, bounded (ac-4).
 */
let fake: FakeKobe;
const enc = (s: string) => new TextEncoder().encode(s);
const sha = (s: string) => sha256Hex(enc(s));
const PATH = "docs/notes.md";
const ORIGINAL = "# Notes\n\nline two\nline three\n";
const THEIRS = "# Notes (agent)\n\nline two\nline three\n";

function answerConfirm(answer: boolean) {
  const confirm = vi.fn(() => answer);
  Object.defineProperty(window, "confirm", { value: confirm, configurable: true, writable: true });
  return confirm;
}

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

function threadWithFile() {
  fake.workspaceFiles.set(PATH, enc(ORIGINAL));
  const thread = fake.addThread("Notes");
  const u = fake.addEntry(thread, null, { role: "user", content: "hi" });
  fake.addEntry(thread, u, { role: "assistant", content: [{ type: "text", text: "done" }] });
  const tab = `file:${PATH}`;
  localStorage.setItem(tabsKey(fake.teamId, thread), JSON.stringify({ open: [tab], active: tab }));
  return thread;
}

async function editorView(label = "Edit notes.md"): Promise<EditorView> {
  const content = await screen.findByLabelText(label);
  return must(EditorView.findFromDOM(content as HTMLElement));
}

function replaceText(view: EditorView, text: string) {
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }));
}

/** Opens the thread with the file in Raw, starts a run; returns the run and the editor. */
async function openAndRun() {
  const thread = threadWithFile();
  openApp(fake, thread);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Raw" }));
  const view = await editorView();
  await user.type(await composer(), "edit it{Enter}");
  await waitFor(() => expect(fake.activeRun(thread)).toBeDefined());
  return { user, view, run: must(fake.activeRun(thread)).run_id };
}

/** The agent writes the file and the sync has landed when the tool result arrives. */
function agentWrites(run: string, id: string, text = THEIRS) {
  fake.workspaceFiles.set(PATH, enc(text));
  act(() => fake.agent.toolCall(run, id, "edit", { path: `/workspace/${PATH}` }));
  act(() => fake.agent.toolResult(run, id, "edit", "ok"));
}

describe("a clean tab reloads in place (ac-1)", () => {
  it("picks up the agent's write, keeps the cursor's line and announces it", async () => {
    const { view, run } = await openAndRun();
    const lineThree = view.state.doc.line(4).from + 2;
    act(() => view.dispatch({ selection: { anchor: lineThree } }));
    agentWrites(run, "e1");
    expect(await screen.findByText(UPDATED_NOTE, undefined, { timeout: 3_000 })).toBeTruthy();
    await waitFor(() => expect(view.state.doc.toString()).toBe(THEIRS));
    expect(screen.getByText(UPDATED_NOTE).getAttribute("role")).toBe("status");
    // The same editor (no remount): the cursor stays on "line three".
    expect(EditorView.findFromDOM(await screen.findByLabelText("Edit notes.md"))).toBe(view);
    const cursor = view.state.selection.main.head;
    expect(view.state.doc.lineAt(cursor).text).toBe("line three");
    expect(screen.queryByText("Unsaved changes.")).toBeNull();
    // The next save is based on the agent's version.
    replaceText(view, `${THEIRS}more\n`);
    expect(screen.queryByText(UPDATED_NOTE)).toBeNull();
  });

  it("checks after the run ends and on window focus, at most once per focus interval", async () => {
    const { run } = await openAndRun();
    fake.workspaceFiles.set(PATH, enc(THEIRS)); // synced after the run, no write seen live
    const listed = () => fake.workspaceListings.filter((d) => d === "docs").length;
    const before = listed();
    act(() => fake.agent.complete(run));
    expect(await screen.findByText(UPDATED_NOTE, undefined, { timeout: 4_000 })).toBeTruthy();
    expect(listed()).toBe(before + 1);
    expect((await editorView()).state.doc.toString()).toBe(THEIRS);

    fake.workspaceFiles.set(PATH, enc("third\n"));
    act(() => void window.dispatchEvent(new Event("focus")));
    await waitFor(async () => expect((await editorView()).state.doc.toString()).toBe("third\n"));
    const afterFocus = listed();
    act(() => void window.dispatchEvent(new Event("focus")));
    act(() => void window.dispatchEvent(new Event("focus")));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(listed()).toBe(afterFocus);
  });
});

describe("focus during a pending write schedule (review)", () => {
  it("a refocus mid-run does not lose the write's later checks", async () => {
    const { run } = await openAndRun();
    const listed = () => fake.workspaceListings.filter((d) => d === "docs").length;
    // The write is seen live but not synced yet: the first check finds nothing new.
    act(() => fake.agent.toolCall(run, "e1", "edit", { path: `/workspace/${PATH}` }));
    act(() => fake.agent.toolResult(run, "e1", "edit", "ok"));
    await waitFor(() => expect(listed()).toBeGreaterThan(0));
    const before = listed();
    act(() => void window.dispatchEvent(new Event("focus")));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(listed()).toBe(before); // skipped: the write's schedule is pending
    fake.workspaceFiles.set(PATH, enc(THEIRS)); // the sync lands
    expect(await screen.findByText(UPDATED_NOTE, undefined, { timeout: 3_000 })).toBeTruthy();
  });
});

describe("a tab with unsaved edits is never replaced (ac-2)", () => {
  it("shows the banner; Compare opens the diff; Take theirs asks first", async () => {
    const { user, view, run } = await openAndRun();
    replaceText(view, "# Mine\n");
    agentWrites(run, "e1");
    const banner = await screen.findByRole("alert", undefined, { timeout: 3_000 });
    expect(banner.textContent).toContain(AGENT_CHANGED_BANNER);
    expect(view.state.doc.toString()).toBe("# Mine\n");

    await user.click(within(banner).getByRole("button", { name: "Compare" }));
    const diff = await editorView("Your notes.md against the agent's version");
    expect(diff.state.doc.toString()).toBe("# Mine\n");
    expect(getChunks(diff.state)?.chunks.length).toBeGreaterThan(0);

    const confirm = answerConfirm(false);
    await user.click(within(banner).getByRole("button", { name: "Take theirs" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Unsaved changes.")).toBeTruthy();

    answerConfirm(true);
    await user.click(within(banner).getByRole("button", { name: "Take theirs" }));
    await waitFor(async () => expect((await editorView()).state.doc.toString()).toBe(THEIRS));
    expect(screen.queryByText("Unsaved changes.")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fake.workspaceSaves).toEqual([]);
  });
});

describe("saving after an outside change (ac-3)", () => {
  it("Keep mine dismisses the banner; Save offers the choices; Keep mine saves over theirs", async () => {
    const { user, view, run } = await openAndRun();
    replaceText(view, "# Mine\n");
    agentWrites(run, "e1");
    const banner = await screen.findByRole("alert", undefined, { timeout: 3_000 });
    await user.click(within(banner).getByRole("button", { name: "Keep mine" }));
    expect(screen.queryByRole("alert")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Save" }));
    const conflict = await screen.findByRole("alert");
    expect(conflict.textContent).toContain("nothing was saved");
    expect(fake.workspaceSaves).toEqual([]);
    for (const name of ["Compare", "Keep mine", "Take theirs"]) {
      expect(within(conflict).getByRole("button", { name })).toBeTruthy();
    }
    await user.click(within(conflict).getByRole("button", { name: "Keep mine" }));
    await waitFor(() => expect(fake.workspaceSaves).toHaveLength(1));
    expect(fake.workspaceSaves[0]).toEqual({
      path: PATH,
      base: await sha(THEIRS),
      text: "# Mine\n",
    });
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Keep mine never saves over a version newer than the one it named", async () => {
    const thread = threadWithFile();
    openApp(fake, thread);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Raw" }));
    replaceText(await editorView(), "# Mine\n");
    fake.workspaceFiles.set(PATH, enc(THEIRS));
    await user.click(screen.getByRole("button", { name: "Save" }));
    const conflict = await screen.findByRole("alert");
    await within(conflict).findByRole("button", { name: "Keep mine" });
    // Wait for the conflict's version read, then the agent writes again.
    await waitFor(() => expect(fake.workspaceListings).toContain("docs"));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    fake.workspaceFiles.set(PATH, enc("newer\n"));
    await user.click(within(conflict).getByRole("button", { name: "Keep mine" }));
    expect(await screen.findByText(/changed again, so nothing was saved/)).toBeTruthy();
    expect(fake.workspaceSaves).toEqual([]);
    expect(new TextDecoder().decode(fake.workspaceFiles.get(PATH))).toBe("newer\n");
  });
});
