// @vitest-environment happy-dom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { sha256Hex } from "../../lib/files/editor";
import { composer, openApp } from "../chat/testing";

/**
 * KOBE-492 (ac-2): a workspace sync conflict shows as a notice in its thread, naming both files,
 * with Open both, Compare (the inline diff of the agent's copy against the member's file), Delete
 * the copy (asks first) and Dismiss; it is read when the thread opens and again after a run ends.
 * A shared reader (404) sees no notice.
 */
let fake: FakeKobe;
const enc = (s: string) => new TextEncoder().encode(s);
const COPY = "notes.conflict-20261023T120000Z.md";

beforeEach(async () => {
  memberSha = await sha256Hex(new TextEncoder().encode(MEMBER));
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

const MEMBER = "# Notes\nmember line\n";
let memberSha = "a".repeat(64);
const row = (id = "11111111-1111-4111-8111-111111111111") => ({
  id,
  path: "notes.md",
  conflict_path: COPY,
  member_sha256: memberSha,
  agent_sha256: "b".repeat(64),
  created_at: "2026-10-23T12:00:00.000Z",
});

function threadWithConflict(): string {
  fake.workspaceFiles.set("notes.md", enc(MEMBER));
  fake.workspaceFiles.set(COPY, enc("# Notes\nagent line\n"));
  const thread = fake.addThread("Notes");
  fake.syncConflicts.set(thread, [row()]);
  return thread;
}

const notice = () => screen.findByText(/The agent's change to notes\.md conflicted with your save/);

describe("sync conflict notice (KOBE-492, ac-2)", () => {
  it("names both files and offers Open both, Compare, Delete the copy and Dismiss", async () => {
    openApp(fake, threadWithConflict());
    const text = await notice();
    expect(text.textContent).toBe(
      `The agent's change to notes.md conflicted with your save. Your version was kept; the agent's is in ${COPY}.`,
    );
    for (const name of ["Open both", "Compare", "Delete the copy"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(
      screen.getByRole("button", { name: "Dismiss the conflict notice for notes.md" }),
    ).toBeTruthy();
  });

  it("Open both opens a tab for each file", async () => {
    openApp(fake, threadWithConflict());
    await notice();
    await userEvent.setup().click(screen.getByRole("button", { name: "Open both" }));
    expect(await screen.findByRole("tab", { name: /notes\.md/ })).toBeTruthy();
    expect(
      await screen.findByRole("tab", { name: new RegExp(COPY.replace(/\./g, "\\.")) }),
    ).toBeTruthy();
  });

  it("Compare opens the member's file with the agent's copy as an inline diff", async () => {
    openApp(fake, threadWithConflict());
    await notice();
    await userEvent.setup().click(screen.getByRole("button", { name: "Compare" }));
    const review = await screen.findByRole("region", { name: "Proposed edit to notes.md" });
    expect(within(review).getByText(/the agent's version from/)).toBeTruthy();
    expect(within(review).getByRole("button", { name: "Commit all" })).toBeTruthy();
  });

  it("Delete the copy asks first, deletes it and resolves the notice", async () => {
    openApp(fake, threadWithConflict());
    await notice();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Delete the copy" }));
    const confirm = screen.getByRole("group", { name: `Delete ${COPY}?` });
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(fake.workspaceDeletes).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Delete the copy" }));
    await user.click(
      within(screen.getByRole("group", { name: `Delete ${COPY}?` })).getByRole("button", {
        name: "Delete",
      }),
    );
    await waitFor(() => expect(fake.syncConflictActions).toHaveLength(1));
    expect(fake.workspaceDeletes).toEqual([COPY]);
    expect(fake.workspaceFiles.has(COPY)).toBe(false);
    expect(fake.syncConflictActions[0]?.action).toBe("resolved");
    expect(screen.queryByText(/conflicted with your save/)).toBeNull();
  });

  it("Dismiss hides it and tells the server", async () => {
    openApp(fake, threadWithConflict());
    await notice();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Dismiss the conflict notice for notes.md" }));
    await waitFor(() =>
      expect(fake.syncConflictActions).toEqual([{ conflictId: row().id, action: "dismissed" }]),
    );
    expect(screen.queryByText(/conflicted with your save/)).toBeNull();
    expect(fake.workspaceDeletes).toEqual([]);
  });

  it("is read again after a run ends, so a conflict found by the run's sync shows up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fake.workspaceFiles.set("notes.md", enc("# Notes\n"));
      const thread = fake.addThread("Notes");
      openApp(fake, thread);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await user.type(await composer(), "Edit notes.md{Enter}");
      await waitFor(() => expect(fake.submittedBodies).toHaveLength(1));
      const run = must([...fake.runs.values()].at(-1)).run_id;
      const before = fake.syncConflictReads;
      fake.syncConflicts.set(thread, [row()]);
      act(() => fake.agent.complete(run));
      await act(() => vi.advanceTimersByTimeAsync(3_000));
      expect(await notice()).toBeTruthy();
      expect(fake.syncConflictReads).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a shared reader (404) sees no notice", async () => {
    const thread = threadWithConflict();
    fake.threadFilesHidden.add(thread);
    openApp(fake, thread);
    await waitFor(() => expect(fake.syncConflictReads).toBeGreaterThan(0));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByText(/conflicted with your save/)).toBeNull();
  });
});
