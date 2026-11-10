// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true},"width":1280,"height":800}
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { composer, openApp, streaming } from "../chat/testing";

/**
 * KOBE-608: an answer whose tool call renders an MCP App shows only the app card(s); the rest
 * (prose, reasoning, other tool cards) is behind a collapsed "Show response", in its original
 * order. Text cards, failed loads, approvals and problems render as before; Copy copies the text.
 */
let fake: FakeKobe;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fake = new FakeKobe();
  vi.stubGlobal("fetch", fake.fetch);
  // happy-dom never lays out: every card is in view.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private readonly cb: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.cb([{ isIntersecting: true, target } as IntersectionObserverEntry], this as never);
      }
      disconnect() {}
      unobserve() {}
    },
  );
});

const SHA = "e".repeat(64);
const APP_ID = "a".repeat(64);
const TOOL = "mcp__catalyst__open_explorer";
const BEFORE = "Let me open the explorer.";
const AFTER = "Here it is, with 18 catalogs.";

function view(prompt: string, id: string, extra: Record<string, unknown> = {}) {
  return {
    result_ref: `ref-${id}`,
    run_id: "run-1",
    user_entry_id: prompt,
    tool_call_id: id,
    entry_id: null,
    connector_id: "c1",
    connector_name: "Catalyst",
    tool: "open_explorer",
    app_id: APP_ID,
    template_sha256: SHA,
    view: "app",
    app: { title: "Lakehouse Explorer" },
    ...extra,
  };
}

const result = (id: string, name: string, text: string) => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text }],
  isError: false,
});

/** Prose, the app call, a bash call, prose; optionally ending on a model error. */
function thread(options: { readonly problem?: boolean } = {}) {
  const t = fake.addThread("Explorer");
  const prompt = fake.addEntry(t, null, { role: "user", content: "Open the explorer" });
  const a1 = fake.addEntry(t, prompt, {
    role: "assistant",
    content: [
      { type: "text", text: BEFORE },
      { type: "toolCall", id: "tc1", name: TOOL, arguments: { q: "x" } },
    ],
  });
  const r1 = fake.addEntry(t, a1, result("tc1", TOOL, "18 catalogs"));
  const a2 = fake.addEntry(t, r1, {
    role: "assistant",
    content: [{ type: "toolCall", id: "tc2", name: "bash", arguments: { command: "ls" } }],
  });
  const r2 = fake.addEntry(t, a2, result("tc2", "bash", "ok"));
  const a3 = fake.addEntry(t, r2, { role: "assistant", content: [{ type: "text", text: AFTER }] });
  if (options.problem) {
    fake.addEntry(t, a3, {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Provider returned 529",
    });
  }
  return { t, prompt };
}

const frames = () => screen.queryAllByTitle("Lakehouse Explorer (app from Catalyst)");
const bashCard = () => screen.queryByRole("region", { name: "Tool call bash" });
const toggle = () => screen.queryByRole("button", { name: "Show response" });

async function appShown() {
  await waitFor(() => expect(frames()).toHaveLength(1), { timeout: 4_000 });
}

describe("answers with an MCP app show only the app (KOBE-608)", () => {
  it("hides prose and other tool cards behind a collapsed Show response", async () => {
    const { t, prompt } = thread();
    fake.appResults.set(t, [view(prompt, "tc1")]);
    fake.appResultBodies.set("ref-tc1", { id: "tc1" });
    openApp(fake, t);
    await appShown();
    expect(screen.queryByText(BEFORE)).toBeNull();
    expect(screen.queryByText(AFTER)).toBeNull();
    expect(bashCard()).toBeNull();
    expect(screen.getByRole("region", { name: `Tool call ${TOOL}` })).toBeTruthy();
    expect(must(toggle()).getAttribute("aria-expanded")).toBe("false");
  });

  it("reveals the hidden parts in their original order, from the keyboard too", async () => {
    const { t, prompt } = thread();
    fake.appResults.set(t, [view(prompt, "tc1")]);
    fake.appResultBodies.set("ref-tc1", { id: "tc1" });
    openApp(fake, t);
    await appShown();
    const user = userEvent.setup();
    must(toggle()).focus();
    await user.keyboard("{Enter}");
    expect(must(toggle()).getAttribute("aria-expanded")).toBe("true");
    const before = screen.getByText(BEFORE);
    const bash = must(bashCard());
    const after = screen.getByText(AFTER);
    const follows = (a: Node, b: Node) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(before, bash)).toBe(true);
    expect(follows(bash, after)).toBe(true);
    // The app stays where it was: one frame, above the toggle.
    expect(frames()).toHaveLength(1);
    expect(follows(must(frames()[0]), must(toggle()))).toBe(true);
    await user.keyboard("{Enter}");
    expect(screen.queryByText(BEFORE)).toBeNull();
  });

  it("renders as before when the viewer gets the text card (MA10)", async () => {
    const { t, prompt } = thread();
    fake.appResults.set(t, [
      view(prompt, "tc1", { view: "text", reason: "no_access", app: undefined }),
    ]);
    openApp(fake, t);
    await screen.findByText("Connect Catalyst to use this app.", {}, { timeout: 4_000 });
    expect(screen.getByText(BEFORE)).toBeTruthy();
    expect(screen.getByText(AFTER)).toBeTruthy();
    expect(bashCard()).toBeTruthy();
    expect(toggle()).toBeNull();
  });

  it("renders as before when the app's stored result could not be read", async () => {
    const { t, prompt } = thread();
    fake.appResults.set(t, [view(prompt, "tc1")]);
    // No stored body: the read fails.
    openApp(fake, t);
    await screen.findByText(/This app could not be loaded/, {}, { timeout: 4_000 });
    await waitFor(() => expect(screen.getByText(BEFORE)).toBeTruthy());
    expect(screen.getByText(AFTER)).toBeTruthy();
    expect(bashCard()).toBeTruthy();
    expect(toggle()).toBeNull();
  });

  it("never hides problems or approval outcomes", async () => {
    const { t, prompt } = thread({ problem: true });
    fake.appResults.set(t, [view(prompt, "tc1")]);
    fake.appResultBodies.set("ref-tc1", { id: "tc1" });
    fake.threadMarkers.set(t, {
      runs: [],
      approvals: [
        {
          approval_id: "ap-1",
          run_id: "run-1",
          user_entry_id: prompt,
          tool_call_id: "tc2",
          status: "allowed",
          cause: "user",
        },
      ],
    });
    openApp(fake, t);
    await appShown();
    await screen.findByText("Approval granted");
    expect(screen.getByText("Provider returned 529")).toBeTruthy();
    expect(bashCard()).toBeNull();
    expect(screen.queryByText(AFTER)).toBeNull();
    // Opening the rest shows each once.
    fireEvent.click(must(toggle()));
    expect(screen.getAllByText("Approval granted")).toHaveLength(1);
    expect(screen.getAllByText("Provider returned 529")).toHaveLength(1);
  });

  it("copies the answer's text, hidden or not", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const { t, prompt } = thread();
    fake.appResults.set(t, [view(prompt, "tc1")]);
    fake.appResultBodies.set("ref-tc1", { id: "tc1" });
    openApp(fake, t);
    await appShown();
    const copies = screen.getAllByRole("button", { name: "Copy" });
    fireEvent.click(must(copies[copies.length - 1]));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = String((writeText.mock.calls[0] as unknown[])[0]);
    expect(copied).toContain(BEFORE);
    expect(copied).toContain(AFTER);
  });

  it("keeps the rest hidden in a live run once the app card appeared; approvals still show", async () => {
    const t = fake.addThread("Live");
    openApp(fake, t);
    const user = userEvent.setup();
    await user.type(await composer(), "open the explorer{Enter}");
    await waitFor(() => expect(fake.activeRun(t)).toBeDefined());
    const run = must(fake.activeRun(t));
    await streaming(fake, run.run_id);
    fake.agent.delta(run.run_id, "m1", BEFORE);
    await screen.findByText(BEFORE);
    fake.agent.toolCall(run.run_id, "tc1", TOOL, { q: "x" }, "m1");
    fake.appResults.set(t, [{ ...view("", "tc1"), user_entry_id: null, run_id: run.run_id }]);
    fake.appResultBodies.set("ref-tc1", { id: "tc1" });
    fake.emit(run.run_id, "tool.result", {
      tool_call_id: "tc1",
      tool: TOOL,
      is_error: false,
      preview: "18 catalogs",
      truncated: false,
      app: {
        connector_id: "11111111-1111-4111-8111-111111111111",
        app_id: APP_ID,
        template_sha256: SHA,
        result_ref: "22222222-2222-4222-8222-222222222222",
      },
    });
    // The marker decides at once: the prose goes before the frame loads.
    await waitFor(() => expect(screen.queryByText(BEFORE)).toBeNull());
    await appShown();
    expect(screen.getByText("Working…")).toBeTruthy();
    fake.agent.delta(run.run_id, "m2", AFTER);
    fake.agent.toolCall(run.run_id, "tc2", "mcp__jira__create_issue", { summary: "x" }, "m2");
    fake.requestApproval(run.run_id, {
      approval_id: "00000000-0000-4000-8000-000900000001",
      tool_call_id: "tc2",
      tool: "mcp__jira__create_issue",
      input: { summary: "x" },
      risk: "write",
      reasons: [{ code: "risk_write", stage: "risk_class", message: "Changes data." }],
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await screen.findByRole("group", { name: /Approval needed/ });
    expect(screen.queryByText(AFTER)).toBeNull();
    expect(screen.queryByText(BEFORE)).toBeNull();
  });
});
