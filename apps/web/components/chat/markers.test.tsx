// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import {
  REGENERATE_FIRST_WITH_OTHER_MODEL,
  SAME_MODEL_RESELECT,
  type PiLine,
} from "../../lib/chat/testing/pi-sequences";
import { must } from "../../lib/testing/must";
import { browserSpaced, composer, crushedIconButtons, openApp, streaming } from "./testing";

/**
 * KOBE-209 (CE12, CE16): thin marker rows between messages for what is not a conversation turn:
 * model changes, compactions, forks, interrupted and budget-stopped runs, approval outcomes.
 */
let fake: FakeKobe;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
});

const call = (id: string, name: string) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: { to: "team" } }],
});
const result = (id: string, name: string, text: string, isError = false) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text }],
  isError,
});
const say = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const ask = (content: string) => ({ role: "user", content });

/**
 * A recorded thread: a model change, two approvals, an interrupted run, a compaction, a second
 * model change, then an edit (two branches) whose run the budget stopped.
 */
function recordedThread() {
  const thread = fake.addThread("Launch plan");
  const add = (parent: string | null, message: Record<string, unknown>) =>
    fake.addEntry(thread, parent, message);
  const m0 = fake.addSystemEntry(thread, null, "model_change", {
    provider: "kobe",
    modelId: "kobe/fast",
  });
  const u1 = add(m0, ask("Plan the launch"));
  const a1 = add(u1, call("tc1", "bash"));
  const r1 = add(a1, result("tc1", "bash", "ok"));
  const a2 = add(r1, call("tc2", "send_email"));
  const r2 = add(a2, result("tc2", "send_email", "Denied by the user.", true));
  const a3 = add(r2, say("Draft one."));
  const u2 = add(a3, ask("Shorter"));
  const a4 = add(u2, say("Draft two."));
  const c1 = fake.addSystemEntry(thread, a4, "compaction", {
    summary: "We planned the launch and drafted it twice.",
    firstKeptEntryId: u2,
    tokensBefore: 120_000,
  });
  const m1 = fake.addSystemEntry(thread, c1, "model_change", {
    provider: "kobe",
    modelId: "kobe/deep",
  });
  const u3 = add(m1, ask("Final?"));
  const a5 = add(u3, say("Final."));
  const u3b = add(m1, ask("Final, please"));
  add(u3b, say("Final version."));
  fake.threadMarkers.set(thread, {
    runs: [run("r-2", "interrupted", u2, a3), run("r-3", "budget_stopped", u3b, m1)],
    approvals: [approval("tc1", "allowed", "user", u1), approval("tc2", "denied", "user", u1)],
  });
  return { thread, a5 };
}

function run(id: string, status: string, userEntryId: string, parentEntryId: string) {
  return {
    run_id: id,
    status,
    user_entry_id: userEntryId,
    parent_entry_id: parentEntryId,
  };
}

function approval(toolCallId: string, status: string, cause: string, userEntryId: string) {
  return {
    approval_id: `ap-${userEntryId}-${toolCallId}`,
    run_id: `run-${userEntryId}`,
    user_entry_id: userEntryId,
    tool_call_id: toolCallId,
    status,
    cause,
  };
}

/** Each marker's kind and visible text (a closed compaction's summary is hidden). */
const markers = () =>
  [...document.querySelectorAll<HTMLElement>("[data-kobe-marker]")].map((el) => {
    const shown = el.cloneNode(true) as HTMLElement;
    for (const hidden of shown.querySelectorAll("[hidden]")) hidden.remove();
    return [el.dataset.kobeMarker, (shown.textContent ?? "").replace(/\s+/g, " ").trim()];
  });

const marker = (kind: string) =>
  must(document.querySelector<HTMLElement>(`[data-kobe-marker="${kind}"]`));

describe("how a stopped or failed run ended, after a reload (KOBE-290)", () => {
  it("shows Stopped after the stopped run's answer and Run failed under a prompt without one", async () => {
    const thread = fake.addThread("Ends");
    const u1 = fake.addEntry(thread, null, ask("Long task"));
    const a1 = fake.addEntry(thread, u1, say("Partial answer"));
    const u2 = fake.addEntry(thread, a1, ask("Try again"));
    fake.threadMarkers.set(thread, {
      runs: [
        run("r-1", "cancelled", u1, "root"),
        { ...run("r-2", "failed", u2, a1), message: "The run could not start." },
      ],
      approvals: [],
    });
    openApp(fake, thread);
    await screen.findByText("Try again");
    await waitFor(() => expect(markers().map(([kind]) => kind)).toContain("failed"));
    expect(markers()).toEqual([
      ["stopped", "Stopped"],
      ["failed", "Run failed: The run could not start."],
    ]);
  });
});

describe("inline markers on a recorded thread (ac-1, ac-3)", () => {
  it("renders each kind in place, between the messages it sits between", async () => {
    const { thread } = recordedThread();
    openApp(fake, thread);
    await screen.findByText("Final version.");
    await waitFor(() => expect(markers().map(([kind]) => kind)).toContain("budget"));
    expect(markers()).toEqual([
      ["model", "Model: kobe/fast"],
      ["approval", "Approval granted"],
      ["approval", "Approval denied"],
      ["run", "Run interrupted"],
      ["compaction", "Context compacted"],
      ["model", "Model changed to kobe/deep"],
      ["fork", expect.stringMatching(/^Forked here · 2 branches/)],
      ["budget", "Run stopped by the budget"],
    ]);
    // Grouping is unchanged: three prompts and three answers on the branch shown.
    expect(document.querySelectorAll('[data-role="user"]')).toHaveLength(3);
    expect(document.querySelectorAll('[data-role="assistant"]')).toHaveLength(3);
    // The approval outcome sits right after its tool card, inside the answer.
    const card = screen.getByRole("region", { name: "Tool call send_email" });
    expect(card.nextElementSibling?.textContent).toContain("Approval denied");
    expect(crushedIconButtons()).toEqual([]);
    // Marker chrome resets its own spacing; Pi's summary is Markdown and keeps its own.
    const chrome = [...document.querySelectorAll("[data-kobe-marker]")].map((el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      copy.querySelector("[data-kobe-summary]")?.remove();
      return copy;
    });
    expect(chrome.flatMap((el) => browserSpaced(el))).toEqual([]);
  });

  it("expands a compaction to Pi's summary and the count of folded messages", async () => {
    const { thread } = recordedThread();
    openApp(fake, thread);
    await screen.findByText("Final version.");
    const toggle = within(marker("compaction")).getByRole("button", { name: /Context compacted/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    const body = must(document.getElementById(must(toggle.getAttribute("aria-controls"))));
    expect(body.hidden).toBe(false);
    expect(body.textContent).toContain("6 earlier messages folded into this summary");
    expect(body.textContent).toContain("We planned the launch and drafted it twice.");
  });
});

/**
 * KOBE-302: on gate1 the e2e click "did not open" the compaction. The trace showed the marker
 * already open (the member's stored Detail toggle was on), so the click closed it; it never
 * remounted. These pin both halves: the open state survives every refresh, and it follows Detail.
 */
describe("a compaction's open state (KOBE-302)", () => {
  const toggle = () =>
    within(marker("compaction")).getByRole("button", { name: /Context compacted/ });
  const body = () => must(document.getElementById(must(toggle().getAttribute("aria-controls"))));
  const markerReads = (thread: string) =>
    fake.requests.filter((r) => r.method === "GET" && r.path === `/v1/threads/${thread}/markers`);

  it("stays open across a new turn, the markers read after it and a new title", async () => {
    const { thread } = recordedThread();
    openApp(fake, thread);
    await screen.findByText("Final version.");
    await waitFor(() => expect(markerReads(thread).length).toBeGreaterThan(0));
    const user = userEvent.setup();
    await user.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    const opened = toggle();
    const reads = markerReads(thread).length;

    await user.type(await composer(), "One more thing{Enter}");
    await waitFor(() => expect(fake.activeRun(thread)).toBeDefined());
    const runId = must(fake.activeRun(thread)).run_id;
    await streaming(fake, runId);
    fake.agent.commitPrompt(runId);
    fake.agent.delta(runId, "m9", "Noted.");
    fake.agent.commit(runId, say("Noted."), "m9");
    fake.agent.complete(runId, { epilogue: ["title"] });
    fake.agent.retitle(runId, "Launch plan, final");
    await waitFor(() =>
      expect(document.getElementById("kobe-thread-title")?.textContent).toBe("Launch plan, final"),
    );
    await waitFor(() => expect(markerReads(thread).length).toBeGreaterThan(reads));

    expect(toggle()).toBe(opened);
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(body().hidden).toBe(false);
  });

  it("opens with the stored Detail toggle; a click then closes it", async () => {
    fake.preferences = { detail_expanded: true };
    const { thread } = recordedThread();
    openApp(fake, thread);
    await screen.findByText("Final version.");
    await waitFor(() => expect(toggle().getAttribute("aria-expanded")).toBe("true"));
    expect(body().hidden).toBe(false);
    const user = userEvent.setup();
    await user.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(body().hidden).toBe(true);
    await user.click(toggle());
    expect(body().hidden).toBe(false);
  });
});

describe("fork markers (ac-2)", () => {
  it("shows the branch count with a picker that switches the leaf", async () => {
    const { thread, a5 } = recordedThread();
    openApp(fake, thread);
    await screen.findByText("Final version.");
    const fork = marker("fork");
    expect(fork.textContent).toContain("Version 2 of 2");
    await userEvent.click(within(fork).getByRole("button", { name: "Previous version" }));
    await screen.findByText("Final.");
    expect(screen.queryByText("Final version.")).toBeNull();
    await waitFor(() =>
      expect(
        fake.requests.some(
          (r) =>
            r.method === "POST" &&
            r.path === `/v1/threads/${thread}/leaf` &&
            (r.body as { entry_id?: string } | undefined)?.entry_id === a5,
        ),
      ).toBe(true),
    );
    expect(marker("fork").textContent).toContain("Version 1 of 2");
    // The budget stop belonged to the other branch.
    expect(document.querySelector('[data-kobe-marker="budget"]')).toBeNull();
  });
});

/** Real Pi entries (`pi-sequences.ts`) stored on a new thread; the leaf ends on the last one. */
function piThread(lines: readonly PiLine[]) {
  const thread = fake.addThread("Real Pi");
  const ids = new Map<string, string>();
  for (const { type, id, parentId, ...fields } of lines) {
    const parent = parentId === null ? null : must(ids.get(parentId));
    const stored =
      type === "message"
        ? fake.addEntry(thread, parent, fields.message as Record<string, unknown>)
        : fake.addSystemEntry(thread, parent, type, fields);
    ids.set(id, stored);
  }
  return thread;
}

describe("model markers on real Pi entry orders (KOBE-280)", () => {
  it("Regenerate with… another model shows the thread's model and one change on version 2 (ac-1)", async () => {
    openApp(fake, piThread(REGENERATE_FIRST_WITH_OTHER_MODEL));
    await screen.findByText("anthropic one");
    expect(markers()).toEqual([
      ["fork", expect.stringMatching(/^Forked here · 2 branches/)],
      ["model", "Model: openai/gpt-fake"],
      ["model", "Model changed to anthropic/claude-fake"],
    ]);
    await userEvent.click(within(marker("fork")).getByRole("button", { name: "Previous version" }));
    await screen.findByText("openai one");
    expect(markers()).toEqual([
      ["fork", expect.stringMatching(/^Forked here · 2 branches/)],
      ["model", "Model: openai/gpt-fake"],
    ]);
  });

  it("a same-model model_change shows no marker (ac-2)", async () => {
    openApp(fake, piThread(SAME_MODEL_RESELECT));
    await screen.findByText("openai two");
    expect(markers()).toEqual([["model", "Model: openai/gpt-fake"]]);
  });
});

describe("approval and run outcomes (KOBE-209 review)", () => {
  /** Two runs whose models both named their first tool call "call_0". */
  function reusedIds(second: { status: string; cause: string }) {
    const thread = fake.addThread("Reused ids");
    const u1 = fake.addEntry(thread, null, ask("first"));
    const a1 = fake.addEntry(thread, u1, call("call_0", "bash"));
    const r1 = fake.addEntry(thread, a1, result("call_0", "bash", "ok"));
    const a2 = fake.addEntry(thread, r1, say("One."));
    const u2 = fake.addEntry(thread, a2, ask("second"));
    const a3 = fake.addEntry(thread, u2, call("call_0", "send_email"));
    const r3 = fake.addEntry(thread, a3, result("call_0", "send_email", "no", true));
    fake.addEntry(thread, r3, say("Two."));
    fake.threadMarkers.set(thread, {
      runs: [],
      approvals: [
        approval("call_0", "allowed", "user", u1),
        approval("call_0", second.status, second.cause, u2),
      ],
    });
    return thread;
  }

  const afterCard = (name: string) =>
    screen.getByRole("region", { name: `Tool call ${name}` }).nextElementSibling?.textContent;

  it("keys an approval's outcome by its run, not by a tool call id runs reuse", async () => {
    openApp(fake, reusedIds({ status: "denied", cause: "user" }));
    await screen.findByText("Two.");
    await waitFor(() => expect(afterCard("bash")).toBe("Approval granted"));
    expect(afterCard("send_email")).toBe("Approval denied");
  });

  it.each([
    ["ttl", "Approval expired"],
    ["run_cancelled", "Approval ended: run stopped"],
    ["run_interrupted", "Approval ended: run interrupted"],
    ["budget_exhausted", "Approval ended: budget reached"],
    ["run_failed", "Approval ended: run failed"],
  ])("labels an approval that ended with cause %s by its cause", async (cause, label) => {
    openApp(fake, reusedIds({ status: "expired", cause }));
    await screen.findByText("Two.");
    await waitFor(() => expect(afterCard("send_email")).toBe(label));
  });

  const markerReads = (thread: string) =>
    fake.requests.filter((r) => r.method === "GET" && r.path === `/v1/threads/${thread}/markers`);

  it("reads the outcomes again when an approval is decided during a run, not while streaming", async () => {
    const thread = fake.addThread("Live");
    openApp(fake, thread);
    const user = userEvent.setup();
    await user.type(await composer(), "file a ticket{Enter}");
    await waitFor(() => expect(fake.activeRun(thread)).toBeDefined());
    const runId = must(fake.activeRun(thread)).run_id;
    await streaming(fake, runId);
    await waitFor(() => expect(markerReads(thread).length).toBeGreaterThan(0));
    const before = markerReads(thread).length;
    fake.agent.toolCall(runId, "tc1", "bash", { command: "ls" }, "m1");
    fake.agent.delta(runId, "m1", "Working on it", 1);
    await screen.findByText(/Working on it/);
    expect(markerReads(thread)).toHaveLength(before);
    fake.emit(runId, "approval.resolved", {
      approval_id: "00000000-0000-4000-8000-000900000001",
      tool_call_id: "tc1",
      decision: "allowed",
      cause: "user",
      remembered: false,
    });
    await waitFor(() => expect(markerReads(thread)).toHaveLength(before + 1));
  });

  it("tries a failed read once more before giving up quietly", async () => {
    const { thread } = recordedThread();
    fake.failNext.set(
      `GET /v1/threads/${thread}/markers`,
      Response.json({ code: "unavailable", message: "x" }, { status: 503 }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    openApp(fake, thread);
    await screen.findByText("Final version.");
    await waitFor(() => expect(markers().map(([kind]) => kind)).toContain("budget"));
    expect(markerReads(thread)).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
  });
});
