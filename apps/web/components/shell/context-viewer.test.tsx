// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contextOf, section } from "../../lib/chat/testing/context-fixtures";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { openApp } from "../chat/testing";

/**
 * KOBE-471: the context gauge opens the context viewer, a panel over the workspace with the raw
 * text (labelled sections, windowed, searchable) and a stacked gauge by kind with its legend.
 */
let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear();
  fake = new FakeKobe();
  fake.teamModels.push({
    alias: "kimi",
    label: "Kimi K2.7 Code",
    enabled: true,
    is_default: true,
    context_window: 200_000,
  });
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function thread(readOnly = false): string {
  const t = fake.addThread("Report");
  if (readOnly) must(fake.threads.get(t)).read_only = true;
  fake.threadLatestCall.set(t, {
    run_id: "00000000-0000-4000-8000-0000000000aa",
    at: "2026-10-21T10:00:00.000Z",
    model: "ollama/kimi",
    input_tokens: 1_000,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  });
  return t;
}

const SECTIONS = [
  section("system_prompt", 400, "You are Pi.\nBe brief.", "preamble"),
  section("tool_definitions", 200, '{"name":"read"}', "read"),
  section("user_message", 100, "<b>not bold</b> Hello there"),
  section("tool_call", 50, '{"path":"a.txt"}', "read"),
  section("tool_result", 50, "file body", "read"),
  section("assistant_message", 200, "Hello back"),
];

const contextReads = (t: string) =>
  fake.requests.filter((r) => r.method === "GET" && r.path === `/v1/threads/${t}/context`);

const meter = () => screen.findByRole("meter", { name: "Context used" });

async function openViewer(t: string) {
  openApp(fake, t);
  const gauge = await meter();
  await userEvent.setup().click(gauge);
  return { gauge, dialog: await screen.findByRole("dialog", { name: "Context" }) };
}

describe("context viewer", () => {
  it("opens from the gauge over the workspace, shows labelled plain text, closes with Escape", async () => {
    const t = thread();
    fake.threadContext.set(t, [{ status: 200, body: contextOf(SECTIONS, { thread_id: t }) }]);
    const { gauge, dialog } = await openViewer(t);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const text = within(dialog).getByRole("region", { name: "Context text" });
    await within(text).findByText(/System prompt · preamble · 400 tokens/);
    within(text).getByText(/Tool call · read · 50 tokens/);
    // Untrusted text stays text: no element is made from it.
    expect(within(text).getByText(/<b>not bold<\/b> Hello there/)).toBeTruthy();
    expect(text.querySelector("b")).toBeNull();
    // The rest of the chat is inert behind it.
    expect(gauge.closest("[inert]")).not.toBeNull();

    await userEvent.setup().keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Context" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(gauge));
  });

  it("stacks the gauge by kind with a legend of tokens and shares; a legend row scrolls to its first section", async () => {
    const t = thread();
    const many = Array.from({ length: 300 }, (_, i) => section("user_message", 1, `line ${i}`));
    const sections = [...SECTIONS, ...many, section("compaction_summary", 99, "Summary here")];
    fake.threadContext.set(t, [{ status: 200, body: contextOf(sections, { thread_id: t }) }]);
    const { dialog } = await openViewer(t);
    const legend = await within(dialog).findByRole("list", { name: "Context by kind" });
    const rows = within(legend)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(rows).toEqual([
      "System prompt400 tokens40%",
      "Tool definitions200 tokens20%",
      "User prompts400 tokens40%",
      "Assistant replies200 tokens20%",
      "Tool calls and results100 tokens10%",
      "Compaction summary99 tokens9.9%",
      "Free0 tokens0%",
    ]);
    expect(dialog.querySelectorAll("[data-context-segment]")).toHaveLength(6);
    const text = within(dialog).getByRole("region", { name: "Context text" });
    // Windowed: the compaction summary, at the end, is not rendered yet.
    expect(within(text).queryByText(/Compaction summary · 99 tokens/)).toBeNull();
    await userEvent
      .setup()
      .click(within(legend).getByRole("button", { name: /Compaction summary/ }));
    const label = await within(text).findByText(/Compaction summary · 99 tokens/);
    expect(label.closest("[data-active]")).not.toBeNull();
    expect(text.scrollTop).toBeGreaterThan(0);
  });

  it("searches the text and steps through the matches", async () => {
    const t = thread();
    fake.threadContext.set(t, [{ status: 200, body: contextOf(SECTIONS, { thread_id: t }) }]);
    const { dialog } = await openViewer(t);
    const user = userEvent.setup();
    await user.type(within(dialog).getByRole("searchbox", { name: "Search the context" }), "hello");
    await within(dialog).findByText("1 of 2");
    expect(dialog.querySelectorAll("mark")).toHaveLength(2);
    await user.keyboard("{Enter}");
    await within(dialog).findByText("2 of 2");
    await user.clear(within(dialog).getByRole("searchbox", { name: "Search the context" }));
    await user.type(within(dialog).getByRole("searchbox", { name: "Search the context" }), "zzz");
    await within(dialog).findByText("No matches");
  });

  it("shows waking progress, asks again after the server's hint, then shows the context", async () => {
    const t = thread();
    fake.threadContext.set(t, [
      { status: 202, body: { status: "waking", retry_after_ms: 2000 } },
      { status: 200, body: contextOf(SECTIONS, { thread_id: t }) },
    ]);
    const { dialog } = await openViewer(t);
    await within(dialog).findByText(/Waking your workspace/);
    await within(dialog).findByText(/System prompt · preamble/, undefined, { timeout: 4_000 });
    expect(contextReads(t)).toHaveLength(2);
  });

  it("marks an approximate answer and re-reads on Refresh", async () => {
    const t = thread();
    fake.threadContext.set(t, [
      {
        status: 200,
        body: contextOf(SECTIONS, {
          thread_id: t,
          exact: false,
          source: "session",
          missing: ["memory"],
          context_window: null,
        }),
      },
    ]);
    const { dialog } = await openViewer(t);
    await within(dialog).findByText(/Approximate — the sandbox restarted/);
    // Without the call's window, the gauge's (200k) scales it.
    await within(dialog).findByText(/1k of 200k tokens/);
    await userEvent
      .setup()
      .click(within(dialog).getByRole("button", { name: "Refresh the context" }));
    await waitFor(() => expect(contextReads(t)).toHaveLength(2));
  });

  it("stops at a terminal error and offers Try again on a retryable one", async () => {
    const t = thread();
    fake.threadContext.set(t, [
      {
        status: 409,
        body: {
          code: "sandbox_refused",
          message:
            "Your workspace can't be started, so its context can't be read. Ask a site admin to check it.",
        },
      },
    ]);
    const { dialog } = await openViewer(t);
    await within(dialog).findByText(/can't be started/);
    expect(within(dialog).queryByRole("button", { name: "Try again" })).toBeNull();
    cleanup();

    const u = thread();
    fake.threadContext.set(u, [
      { status: 503, body: { code: "sandbox_unavailable", message: "x" } },
      { status: 200, body: contextOf(SECTIONS, { thread_id: u }) },
    ]);
    const second = await openViewer(u);
    await within(second.dialog).findByText(/not available right now/);
    await userEvent.setup().click(within(second.dialog).getByRole("button", { name: "Try again" }));
    await within(second.dialog).findByText(/System prompt · preamble/);
  });

  it("is not offered to a shared reader: the gauge does not open it", async () => {
    const t = thread(true);
    openApp(fake, t);
    const gauge = await meter();
    expect(gauge.hasAttribute("data-context-open")).toBe(false);
    expect(gauge.getAttribute("aria-haspopup")).toBeNull();
    await userEvent.setup().click(gauge);
    expect(screen.queryByRole("dialog", { name: "Context" })).toBeNull();
    expect(contextReads(t)).toHaveLength(0);
  });

  it("opens from the keyboard", async () => {
    const t = thread();
    fake.threadContext.set(t, [{ status: 200, body: contextOf(SECTIONS, { thread_id: t }) }]);
    openApp(fake, t);
    const gauge = await meter();
    expect(gauge.getAttribute("aria-haspopup")).toBe("dialog");
    gauge.focus();
    await userEvent.setup().keyboard("{Enter}");
    await screen.findByRole("dialog", { name: "Context" });
  });
});
