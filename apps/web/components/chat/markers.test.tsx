// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { browserSpaced, crushedIconButtons, openApp } from "./testing";

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
    approvals: [approval("tc1", "allowed", "user"), approval("tc2", "denied", "user")],
  });
  return { thread, a5 };
}

function run(id: string, status: string, userEntryId: string, parentEntryId: string) {
  return {
    run_id: id,
    status,
    user_entry_id: userEntryId,
    parent_entry_id: parentEntryId,
    ended_at: "2026-10-02T10:00:00.000Z",
  };
}

function approval(toolCallId: string, status: string, cause: string) {
  return {
    approval_id: `ap-${toolCallId}`,
    run_id: "r-1",
    tool_call_id: toolCallId,
    status,
    cause,
    decided_at: "2026-10-02T10:00:00.000Z",
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

describe("inline markers on a recorded thread (ac-1, ac-3)", () => {
  it("renders each kind in place, between the messages it sits between", async () => {
    const { thread } = recordedThread();
    openApp(fake, thread);
    await screen.findByText("Final version.");
    await waitFor(() => expect(markers().map(([kind]) => kind)).toContain("budget"));
    expect(markers()).toEqual([
      ["model", "Model changed to kobe/fast"],
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
