// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { COMPACT_THREAD_ERROR_MESSAGES } from "@kobe/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { composer, openApp } from "./testing";

/**
 * Compact now (CE15, KOBE-213): the dialog behind the gauge's red action and the thread's actions
 * menu. Enabled only while the thread is idle; the focus reaches the server; the summary then shows
 * in the conversation's "context compacted" marker; a refusal shows the server's message.
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

/** An idle thread with one exchange; `tokens` is its newest call's prompt (red at 85%). */
function conversation(tokens = 10_000): string {
  const t = fake.addThread("Report");
  const question = fake.addEntry(t, null, { role: "user", content: "Sum the numbers" });
  fake.addEntry(t, question, {
    role: "assistant",
    content: [{ type: "text", text: "They add up to 42." }],
    usage: { input: tokens, cacheRead: 0, cacheWrite: 0 },
  });
  fake.threadLatestCall.set(t, {
    run_id: "00000000-0000-4000-8000-0000000000aa",
    at: "2026-10-14T10:00:00.000Z",
    model: "ollama/kimi",
    input_tokens: tokens,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  });
  return t;
}

/** Opens the thread's actions menu (a `<details>` disclosure) and returns its Compact now item. */
const menuItem = async () => {
  const summary = await waitFor(() =>
    must(document.querySelector<HTMLElement>('summary[aria-label="Conversation actions"]')),
  );
  const details = must(summary.closest("details"));
  details.open = true;
  return within(details).getByRole("button", { name: /Compact now/ });
};

const compactRequests = (t: string) =>
  fake.requests.filter((r) => r.method === "POST" && r.path === `/v1/threads/${t}/compact`);

describe("Compact now (KOBE-213)", () => {
  it("compacts from the gauge's red action with a focus; the marker shows the summary", async () => {
    const t = conversation(190_000);
    openApp(fake, t);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Compact this thread" }));
    const dialog = await screen.findByRole("dialog", { name: "Compact this thread" });
    await user.type(
      within(dialog).getByRole("textbox", { name: /What should the summary keep/ }),
      "keep the final numbers",
    );
    await user.click(within(dialog).getByRole("button", { name: "Compact now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(compactRequests(t).map((r) => r.body)).toEqual([{ focus: "keep the final numbers" }]);
    // The compaction entry is read back: the marker carries Pi's summary.
    const marker = await waitFor(() =>
      must(document.querySelector<HTMLElement>('[data-kobe-marker="compaction"]')),
    );
    await user.click(within(marker).getByText(/compacted/i));
    expect(
      await within(marker).findByText(/Summary of the earlier conversation\. Focus: keep/),
    ).toBeTruthy();
    // The gauge hides until the next model call (KOBE-211).
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("offers Compact now in the thread's actions menu and sends no focus when left empty", async () => {
    const t = conversation();
    openApp(fake, t);
    const item = await menuItem();
    expect(item.getAttribute("aria-disabled")).toBe("false");
    const user = userEvent.setup();
    await user.click(item);
    const dialog = await screen.findByRole("dialog", { name: "Compact this thread" });
    await user.click(within(dialog).getByRole("button", { name: "Compact now" }));
    await waitFor(() => expect(compactRequests(t)).toHaveLength(1));
    expect(compactRequests(t)[0]?.body).toEqual({});
  });

  it("is disabled while a run is on, and while a compaction is in progress", async () => {
    const t = conversation();
    openApp(fake, t);
    await screen.findByText("They add up to 42.");
    const user = userEvent.setup();
    await user.type(await composer(), "one more{Enter}");
    await waitFor(async () =>
      expect((await menuItem()).getAttribute("aria-disabled")).toBe("true"),
    );
    await user.click(await menuItem());
    expect(screen.queryByRole("dialog")).toBeNull();
    // Done: idle again.
    fake.agent.complete(fake.latestRun(t).run_id);
    await waitFor(async () =>
      expect((await menuItem()).getAttribute("aria-disabled")).toBe("false"),
    );
    // Held by the server: the dialog says it is working, the menu waits.
    let release: () => void = () => undefined;
    fake.compactGate = new Promise<void>((resolve) => (release = resolve));
    await user.click(await menuItem());
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Compact now" }));
    expect(await within(dialog).findByRole("button", { name: "Compacting…" })).toBeTruthy();
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows the server's message when it refuses, and keeps the dialog open", async () => {
    const t = conversation();
    fake.failNext.set(
      `POST /v1/threads/${t}/compact`,
      Response.json(
        { code: "nothing_to_compact", message: COMPACT_THREAD_ERROR_MESSAGES.nothing_to_compact },
        { status: 409 },
      ),
    );
    openApp(fake, t);
    const user = userEvent.setup();
    await user.click(await menuItem());
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Compact now" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      COMPACT_THREAD_ERROR_MESSAGES.nothing_to_compact,
    );
  });

  it("offers nothing on a conversation shared with you read-only", async () => {
    const t = conversation(190_000);
    must(fake.threads.get(t)).read_only = true;
    openApp(fake, t);
    await screen.findByRole("meter", { name: "Context used" });
    expect(screen.queryByRole("button", { name: "Compact this thread" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Conversation actions" })).toBeNull();
  });
});
