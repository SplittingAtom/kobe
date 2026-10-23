// @vitest-environment happy-dom
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { tabsKey } from "../../lib/chat/artifact-tabs";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { sha256Hex } from "../../lib/files/editor";
import { must } from "../../lib/testing/must";
import { composer, openApp } from "../chat/testing";
import { AUTO_OPEN_HELD_NOTE, AUTO_OPEN_LABEL, autoOpenDecision } from "./file-edit-card";

/**
 * KOBE-489: the proposed-edit card's "Open edits automatically" switch (a stored member
 * preference, owner only). On, a live `file.edit_proposed` opens its file with the inline diff
 * once, without taking focus from the composer and never over unsaved changes; replayed or
 * reloaded proposals never open by themselves; off, nothing opens (today's behaviour).
 */
let fake: FakeKobe;
const enc = (s: string) => new TextEncoder().encode(s);
const BASE = "alpha\nbeta\n";
const PROPOSED = "alpha\nBETA\n";
let baseSha = "";

beforeAll(async () => {
  baseSha = await sha256Hex(enc(BASE));
});

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

const proposal = (id: string, summary = "Capitalises beta") => ({
  tool_call_id: id,
  path: "notes.txt",
  base_sha256: baseSha,
  content: PROPOSED,
  summary,
});

const reviewRegion = () => screen.queryByRole("region", { name: "Proposed edit to notes.txt" });

/** No review opened (effects included: let them run first). */
async function expectNoReview() {
  await act(() => new Promise((r) => setTimeout(r, 150)));
  expect(reviewRegion()).toBeNull();
}

/** Sends a message and returns the run and the composer (which keeps focus). */
async function startRun(thread: string) {
  openApp(fake, thread);
  const user = userEvent.setup();
  const input = await composer();
  await user.type(input, "Tidy{Enter}");
  await waitFor(() => expect(fake.submittedBodies).toHaveLength(1));
  const run = must([...fake.runs.values()].at(-1)).run_id;
  return { user, input, run };
}

function propose(run: string, id: string, summary?: string) {
  act(() => {
    fake.agent.toolCall(run, id, "propose_file_edit", { path: "notes.txt" });
    fake.emit(run, "file.edit_proposed", proposal(id, summary));
  });
}

/** A reloaded thread whose history holds a recorded proposal for notes.txt (tool call `pe1`). */
function recordedThread() {
  const thread = notesThread();
  const u = fake.addEntry(thread, null, { role: "user", content: "Tidy" });
  const call = fake.addEntry(thread, u, {
    role: "assistant",
    content: [
      { type: "toolCall", id: "pe1", name: "propose_file_edit", arguments: { path: "notes.txt" } },
    ],
  });
  const res = fake.addEntry(thread, call, {
    role: "toolResult",
    toolCallId: "pe1",
    toolName: "propose_file_edit",
    content: [{ type: "text", text: '{"ok":true,"status":"awaiting_user"}' }],
    isError: false,
  });
  fake.addEntry(thread, res, { role: "assistant", content: [{ type: "text", text: "Proposed." }] });
  fake.fileEditProposals.set(thread, [
    {
      ...proposal("pe1"),
      run_id: "00000000-0000-4000-8000-000000000001",
      created_at: "2026-10-21T00:00:00.000Z",
    },
  ]);
  return thread;
}

function notesThread() {
  fake.workspaceFiles.set("notes.txt", enc(BASE));
  return fake.addThread("Notes");
}

describe("the switch (ac-1)", () => {
  it("is off by default for the owner and stores the member's choice", async () => {
    const thread = notesThread();
    const { user, run } = await startRun(thread);
    propose(run, "pe1");
    const toggle = await screen.findByRole("switch", { name: AUTO_OPEN_LABEL });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(fake.preferences).toEqual({ auto_open_edits: true }));
    // A proposal that arrived while it was off never opens by turning it on.
    await expectNoReview();
    // The keyboard toggles it too.
    toggle.focus();
    await user.keyboard(" ");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(fake.preferences).toEqual({ auto_open_edits: false }));
  });

  it("a shared reader sees no switch", async () => {
    const thread = recordedThread();
    Object.assign(must(fake.threads.get(thread)), { read_only: true, owner_name: "Alice" });
    fake.preferences = { auto_open_edits: true };
    openApp(fake, thread);
    expect(await screen.findByText("Capitalises beta")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: AUTO_OPEN_LABEL })).toBeNull();
  });
});

describe("auto-open (ac-2, ac-3)", () => {
  it("on: a live proposal opens the file with the inline diff once, focus stays in the composer", async () => {
    fake.preferences = { auto_open_edits: true };
    const thread = notesThread();
    const { input, run } = await startRun(thread);
    expect(document.activeElement).toBe(input);
    propose(run, "pe1");
    expect(await screen.findByRole("region", { name: "Proposed edit to notes.txt" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /notes\.txt/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(document.activeElement).toBe(input);
    // Nothing is written by itself: committing stays the member's click.
    expect(fake.workspaceSaves).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Commit all" })).toBeTruthy();
    // Once per proposal: after Discard all, later events of the run never start it again.
    await userEvent.setup().click(screen.getByRole("button", { name: "Discard all" }));
    await waitFor(() => expect(reviewRegion()).toBeNull());
    act(() => fake.agent.delta(run, "m1", "More text."));
    await expectNoReview();
  });

  it("off: a live proposal opens nothing (today's behaviour)", async () => {
    const thread = notesThread();
    const { run } = await startRun(thread);
    propose(run, "pe1");
    expect(await screen.findByText("Capitalises beta")).toBeTruthy();
    await expectNoReview();
    expect(screen.queryByRole("tab", { name: /notes\.txt/ })).toBeNull();
  });

  it("a replayed backlog of another tab's run never opens", async () => {
    fake.preferences = { auto_open_edits: true };
    const thread = notesThread();
    const runId = fake.queueRetry(thread, "Tidy");
    Object.assign(fake.run(runId), { status: "running", retry_of_run_id: undefined });
    fake.emit(runId, "run.started", { thread_id: thread, agent_id: null, agent_version: null });
    fake.agent.toolCall(runId, "pe1", "propose_file_edit", { path: "notes.txt" });
    fake.emit(runId, "file.edit_proposed", proposal("pe1"));
    openApp(fake, thread);
    expect(await screen.findByText("Capitalises beta")).toBeTruthy();
    await expectNoReview();
  });

  it("a proposal that arrived before the preferences loaded never opens once they do", async () => {
    fake.preferences = { auto_open_edits: true };
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const real = fake.fetch;
    const delayed: typeof fetch = async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://x");
      if (url.pathname === "/v1/me/preferences" && (init?.method ?? "GET") === "GET") await gate;
      return real(input, init);
    };
    Object.assign(fake, { fetch: delayed });
    vi.stubGlobal("fetch", delayed);
    const { run } = await startRun(notesThread());
    propose(run, "pe1");
    expect(await screen.findByText("Capitalises beta")).toBeTruthy();
    act(() => release());
    const toggle = await screen.findByRole("switch", { name: AUTO_OPEN_LABEL });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    await expectNoReview();
  });

  it("a reloaded thread's proposal never opens by itself; Review still does", async () => {
    fake.preferences = { auto_open_edits: true };
    openApp(fake, recordedThread());
    expect(await screen.findByText("Capitalises beta")).toBeTruthy();
    const toggle = await screen.findByRole("switch", { name: AUTO_OPEN_LABEL });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    await expectNoReview();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Review the proposed edit to notes.txt" }));
    expect(await screen.findByRole("region", { name: "Proposed edit to notes.txt" })).toBeTruthy();
  });

  it("never opens over unsaved changes: it holds back and says so; Review stays", async () => {
    fake.preferences = { auto_open_edits: true };
    const thread = notesThread();
    const tab = "file:notes.txt";
    localStorage.setItem(
      tabsKey(fake.teamId, thread),
      JSON.stringify({ open: [tab], active: tab }),
    );
    const { user, input, run } = await startRun(thread);
    await user.click(await screen.findByRole("button", { name: "Raw" }));
    const content = await screen.findByLabelText("Edit notes.txt");
    const view = must(EditorView.findFromDOM(content as HTMLElement));
    act(() => view.dispatch({ changes: { from: 0, insert: "mine\n" } }));
    input.focus();
    propose(run, "pe1");
    expect(await screen.findByText(AUTO_OPEN_HELD_NOTE)).toBeTruthy();
    await expectNoReview();
    expect(view.state.doc.toString()).toBe(`mine\n${BASE}`);
    expect(
      screen.getByRole("button", { name: "Review the proposed edit to notes.txt" }),
    ).toBeTruthy();
  });
});

describe("autoOpenDecision (KOBE-489 review)", () => {
  const at = { known: true, enabled: true, panel: true, proposal: true, unsaved: false };
  it("opens only when known, on, with a column and the proposal; holds over unsaved changes", () => {
    expect(autoOpenDecision(at)).toBe("opened");
    expect(autoOpenDecision({ ...at, unsaved: true })).toBe("held");
    expect(autoOpenDecision({ ...at, proposal: false })).toBeUndefined();
  });

  it("skips at arrival while the switch is unknown or off, or there is no column", () => {
    expect(autoOpenDecision({ ...at, known: false })).toBe("skipped");
    expect(autoOpenDecision({ ...at, enabled: false })).toBe("skipped");
    expect(autoOpenDecision({ ...at, panel: false })).toBe("skipped");
  });
});
