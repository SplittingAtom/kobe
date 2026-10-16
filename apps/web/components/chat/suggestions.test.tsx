// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { initialThreadState } from "../../lib/chat/thread-state";
import { must } from "../../lib/testing/must";
import type { KobeThreadExtras } from "./kobe-runtime";
import { FollowupChips } from "./suggestion-chips";
import { composer, openApp, streaming } from "./testing";

/**
 * KOBE-222 (CE21): the agent's starters on the welcome screen send at once; the server's follow-ups
 * show as chips above the composer after a run until the next send, and a chip sends its text.
 */
let fake: FakeKobe;

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

const followups = () => screen.queryByRole("group", { name: "Suggested follow-ups" });

const sentMessages = () =>
  fake.requests
    .filter((r) => r.method === "POST" && /\/v1\/threads\/[^/]+\/messages$/.test(r.path))
    .map((r) => (r.body as { content?: string } | undefined)?.content);

/** Opens a thread, sends `text`, and completes its run announcing follow-ups. */
async function completedRun(text: string): Promise<{ threadId: string; runId: string }> {
  const threadId = fake.addThread("Sales");
  openApp(fake, threadId);
  const user = userEvent.setup();
  await user.type(await composer(), `${text}{Enter}`);
  const run = must(await waitFor(() => must(fake.activeRun(threadId))));
  await streaming(fake, run.run_id);
  fake.agent.commitPrompt(run.run_id);
  fake.agent.complete(run.run_id, { epilogue: ["followups"] });
  return { threadId, runId: run.run_id };
}

describe("agent starters on the welcome screen (ac-1)", () => {
  it("shows the default agent's starters; one click sends it as the first message", async () => {
    fake.runnableAgents.push({
      id: "00000000-0000-4000-8000-0000000000aa",
      scope: "gallery",
      galleryKey: "kobe",
      name: "Kobe",
      model: null,
      starters: ["Summarise my workspace", "Chart the CSV in my files"],
    });
    openApp(fake);
    const group = await screen.findByRole("group", { name: "Conversation starters" });
    // The agent's own starters replace the generic suggestions.
    expect(screen.queryByRole("button", { name: /Analyse a spreadsheet/ })).toBeNull();
    await userEvent
      .setup()
      .click(within(group).getByRole("button", { name: "Chart the CSV in my files" }));
    await waitFor(() => expect(sentMessages()).toEqual(["Chart the CSV in my files"]));
    expect(fake.threads.size).toBe(1);
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Conversation starters" })).toBeNull(),
    );
  });

  it("keeps the generic suggestions (which only fill the composer) without agent starters", async () => {
    openApp(fake);
    expect(await screen.findByRole("button", { name: /Analyse a spreadsheet/ })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Conversation starters" })).toBeNull();
  });
});

describe("follow-up chips (ac-1, ac-6)", () => {
  it("appear above the composer after the run; a chip sends its text and the chips go", async () => {
    const { runId } = await completedRun("What drives revenue?");
    expect(followups()).toBeNull();
    fake.agent.suggest(runId, ["Chart it by region", "What about Q4?", "Compare with last year"]);
    const group = await screen.findByRole("group", { name: "Suggested follow-ups" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Chart it by region", "What about Q4?", "Compare with last year"]);
    // Above the composer, outside the message list.
    const box = must(document.querySelector("[data-kobe-composer-box]"));
    expect(group.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await userEvent.setup().click(within(group).getByRole("button", { name: "What about Q4?" }));
    await waitFor(() => expect(sentMessages()).toEqual(["What drives revenue?", "What about Q4?"]));
    await waitFor(() => expect(followups()).toBeNull());
  });

  it("disappear when the member sends their own message", async () => {
    const { runId } = await completedRun("What drives revenue?");
    fake.agent.suggest(runId, ["Chart it by region"]);
    await screen.findByRole("group", { name: "Suggested follow-ups" });
    await userEvent.setup().type(await composer(), "Something else{Enter}");
    await waitFor(() => expect(followups()).toBeNull());
    await waitFor(() => expect(sentMessages()).toEqual(["What drives revenue?", "Something else"]));
  });

  it("are never shown without the server's suggestions (switch off: no epilogue)", async () => {
    const threadId = fake.addThread("Sales");
    openApp(fake, threadId);
    await userEvent.setup().type(await composer(), "Hi{Enter}");
    const run = must(await waitFor(() => must(fake.activeRun(threadId))));
    await streaming(fake, run.run_id);
    fake.agent.commitPrompt(run.run_id);
    fake.agent.complete(run.run_id);
    await waitFor(() => expect(fake.activeRun(threadId)).toBeUndefined());
    expect(followups()).toBeNull();
  });
});

describe("FollowupChips for a reader of a shared thread (KOBE-221)", () => {
  it("renders nothing: a reader cannot send here", () => {
    const base = initialThreadState("t1");
    const extras = {
      controller: null,
      projection: { items: [], headId: null, lastEntryOfNode: new Map() },
      state: {
        ...base,
        phase: "ready",
        summary: { readOnly: true },
        followups: { runId: "r1", suggestions: ["Chart it"] },
      },
    } as unknown as KobeThreadExtras;
    const { container } = render(<FollowupChips extras={extras} />);
    expect(container.innerHTML).toBe("");
  });
});
