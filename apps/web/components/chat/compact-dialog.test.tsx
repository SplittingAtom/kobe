// @vitest-environment happy-dom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { COMPACT_THREAD_ERROR_MESSAGES } from "@kobe/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { DESKTOP_WIDTH, resizeWindow } from "../../lib/testing/viewport";
import { announcement, composer, openApp, streaming, threadGroup } from "./testing";

/**
 * Compact now (CE15, KOBE-213): the dialog behind the gauge's red action and the Compact now icon
 * beside the latest answer's thumbs down (KOBE-418). Enabled only while the thread is idle; the
 * focus reaches the server; the summary then shows in the conversation's "context compacted"
 * marker; a refusal shows the server's message.
 */
let fake: FakeKobe;
/** The gauge and the button appear after the thread, its usage and the team's models were read. */
const WAIT = { timeout: 10_000 };

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
function conversation(tokens = 10_000, title = "Report"): string {
  const t = fake.addThread(title);
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

const answers = () => [...document.querySelectorAll<HTMLElement>('[data-role="assistant"]')];

/** The latest answer's Compact now icon (KOBE-418), beside its thumbs down. */
const compactNow = async () =>
  waitFor(() => within(must(answers().at(-1))).getByRole("button", { name: "Compact now" }), WAIT);

/** Whether the latest answer offers Compact now: enabled, disabled, or absent. */
function offered(): "enabled" | "disabled" | "absent" {
  const latest = answers().at(-1);
  const button = latest && within(latest).queryByRole("button", { name: "Compact now" });
  if (!button) return "absent";
  return button.getAttribute("aria-disabled") === "true" ? "disabled" : "enabled";
}

const usageReads = (t: string) => (r: { method: string; path: string }) =>
  r.method === "GET" && r.path === `/v1/threads/${t}/usage`;

const compactRequests = (t: string) =>
  fake.requests.filter((r) => r.method === "POST" && r.path === `/v1/threads/${t}/compact`);

describe("Compact now (KOBE-213)", { timeout: 30_000 }, () => {
  it("compacts from the gauge's red action with a focus; the marker shows the summary", async () => {
    const t = conversation(190_000);
    openApp(fake, t);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Compact this thread" }, WAIT));
    const dialog = await screen.findByRole("dialog", { name: "Compact this thread" }, WAIT);
    // Inside the chat root, where the theme tokens live (dark mode).
    expect(dialog.closest("[data-kobe-chat]")).not.toBeNull();
    await user.type(
      within(dialog).getByRole("textbox", { name: /What should the summary keep/ }),
      "keep the final numbers",
    );
    await user.click(within(dialog).getByRole("button", { name: "Compact now" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), WAIT);
    expect(compactRequests(t).map((r) => r.body)).toEqual([{ focus: "keep the final numbers" }]);
    // The compaction entry is read back: the marker carries Pi's summary.
    const marker = await waitFor(
      () => must(document.querySelector<HTMLElement>('[data-kobe-marker="compaction"]')),
      WAIT,
    );
    await user.click(within(marker).getByText(/compacted/i));
    expect(
      await within(marker).findByText(
        /Summary of the earlier conversation\. Focus: keep/,
        {},
        WAIT,
      ),
    ).toBeTruthy();
    // The gauge hides until the next model call (KOBE-211).
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("on a phone the gauge sits under the composer and its Compact opens the dialog", async () => {
    resizeWindow(390);
    try {
      const t = conversation(190_000);
      openApp(fake, t);
      const user = userEvent.setup();
      const header = await screen.findByRole("banner");
      await waitFor(() => expect(header.getAttribute("data-bar-layout")).toBe("single"), WAIT);
      const gauge = await screen.findByRole("meter", { name: "Context used" }, WAIT);
      expect(header.contains(gauge)).toBe(false);
      expect(gauge.closest("[data-kobe-composer]")).not.toBeNull();
      await user.click(await screen.findByRole("button", { name: "Compact this thread" }, WAIT));
      expect(await screen.findByRole("dialog", { name: "Compact this thread" }, WAIT)).toBeTruthy();
    } finally {
      resizeWindow(DESKTOP_WIDTH);
    }
  });

  it("is offered on the latest answer only, beside its thumbs down", async () => {
    const t = fake.addThread("Two answers");
    const q1 = fake.addEntry(t, null, { role: "user", content: "Sum the numbers" });
    const a1 = fake.addEntry(t, q1, {
      role: "assistant",
      content: [{ type: "text", text: "Forty-two." }],
    });
    const q2 = fake.addEntry(t, a1, { role: "user", content: "And doubled?" });
    fake.addEntry(t, q2, { role: "assistant", content: [{ type: "text", text: "Eighty-four." }] });
    fake.addEndedRun(t, q1);
    fake.addEndedRun(t, q2);
    openApp(fake, t);
    await screen.findByText("Eighty-four.", {}, WAIT);
    const button = await compactNow();
    await waitFor(
      () => expect(screen.getAllByRole("button", { name: "Bad answer" })).toHaveLength(2),
      WAIT,
    );
    const [older, latest] = answers();
    expect(within(must(older)).queryByRole("button", { name: "Compact now" })).toBeNull();
    expect(must(latest).contains(button)).toBe(true);
    const names = within(must(latest))
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names[names.indexOf("Bad answer") + 1]).toBe("Compact now");
  });

  it("offers Compact now as an icon on the answer and sends no focus when left empty", async () => {
    const t = conversation();
    openApp(fake, t);
    const item = await compactNow();
    expect(item.getAttribute("aria-disabled")).toBe("false");
    const user = userEvent.setup();
    await user.click(item);
    const dialog = await screen.findByRole("dialog", { name: "Compact this thread" }, WAIT);
    await user.click(within(dialog).getByRole("button", { name: "Compact now" }));
    await waitFor(() => expect(compactRequests(t)).toHaveLength(1), WAIT);
    expect(compactRequests(t)[0]?.body).toEqual({});
  });

  it("is disabled while a run is on, and while a compaction is in progress", async () => {
    const t = conversation();
    openApp(fake, t);
    await screen.findByText("They add up to 42.", {}, WAIT);
    const user = userEvent.setup();
    await user.type(await composer(), "one more{Enter}");
    // The run's answer is the latest now, and its actions wait for the run: nothing to press.
    await waitFor(() => expect(offered()).not.toBe("enabled"), WAIT);
    expect(screen.queryByRole("dialog")).toBeNull();
    // Done: idle again.
    fake.agent.complete(fake.latestRun(t).run_id);
    await waitFor(
      async () => expect((await compactNow()).getAttribute("aria-disabled")).toBe("false"),
      WAIT,
    );
    // Held by the server: the dialog says it is working.
    let release: () => void = () => undefined;
    fake.compactGate = new Promise<void>((resolve) => (release = resolve));
    await user.click(await compactNow());
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Compact now" }));
    expect(await within(dialog).findByRole("button", { name: "Compacting…" })).toBeTruthy();
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), WAIT);
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
    await user.click(await compactNow());
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Compact now" }));
    expect((await within(dialog).findByRole("alert", {}, WAIT)).textContent).toBe(
      COMPACT_THREAD_ERROR_MESSAGES.nothing_to_compact,
    );
  });

  it("offers nothing on a conversation shared with you read-only", async () => {
    const t = conversation(190_000);
    must(fake.threads.get(t)).read_only = true;
    openApp(fake, t);
    await screen.findByRole("meter", { name: "Context used" }, WAIT);
    expect(screen.queryByRole("button", { name: "Compact this thread" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Compact now" })).toBeNull();
  });

  /** A server answer held until `release()`; `answer` is what it then says (default: success). */
  function hold(t: string, answer?: Response) {
    let release: () => void = () => undefined;
    fake.compactGate = new Promise<void>((resolve) => (release = resolve));
    if (answer) fake.failNext.set(`POST /v1/threads/${t}/compact`, answer);
    return () => release();
  }
  const refusal = (code: keyof typeof COMPACT_THREAD_ERROR_MESSAGES, status: number) =>
    Response.json({ code, message: COMPACT_THREAD_ERROR_MESSAGES[code] }, { status });

  it("reports a refusal that comes after the dialog was closed, and reopens without it", async () => {
    const t = conversation();
    const release = hold(t, refusal("compaction_failed", 502));
    openApp(fake, t);
    const user = userEvent.setup();
    await user.click(await compactNow());
    const dialog = await screen.findByRole("dialog", {}, WAIT);
    await user.click(within(dialog).getByRole("button", { name: "Compact now" }));
    await within(dialog).findByRole("button", { name: "Compacting…" }, WAIT);
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), WAIT);
    release();
    // The thread's error banner says it, though the dialog is gone.
    expect(
      await screen.findByText(COMPACT_THREAD_ERROR_MESSAGES.compaction_failed, {}, WAIT),
    ).toBeTruthy();
    await user.click(await compactNow());
    const again = await screen.findByRole("dialog", {}, WAIT);
    expect(within(again).queryByRole("alert")).toBeNull();
  });

  it("keeps each thread's dialog to itself: A's progress and focus never reach B", async () => {
    const a = conversation(10_000, "Alpha");
    const b = conversation(10_000, "Beta");
    const release = hold(a);
    openApp(fake, a);
    const user = userEvent.setup();
    await user.click(await compactNow());
    let dialog = await screen.findByRole("dialog", {}, WAIT);
    await user.type(within(dialog).getByRole("textbox"), "alpha only");
    await user.click(within(dialog).getByRole("button", { name: "Compact now" }));
    await within(dialog).findByRole("button", { name: "Compacting…" }, WAIT);
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    const threads = within(await threadGroup("Your threads"));
    await user.click(threads.getByRole("button", { name: "Beta" }));
    await waitFor(() => expect(window.location.search).toBe(`?thread=${b}`), WAIT);
    await user.click(await compactNow());
    dialog = await screen.findByRole("dialog", {}, WAIT);
    expect((within(dialog).getByRole("textbox") as HTMLInputElement).value).toBe("");
    expect(within(dialog).getByRole("button", { name: "Compact now" })).toBeTruthy();
    // A finishes while B's dialog is open: B's stays open and untouched.
    release();
    await waitFor(() => expect(compactRequests(a)).toHaveLength(1), WAIT);
    expect(compactRequests(a)[0]?.body).toEqual({ focus: "alpha only" });
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(compactRequests(b)).toEqual([]);
  });

  it("reads the thread again after thread_busy, so Compact is no longer offered", async () => {
    const t = conversation();
    const release = hold(t, refusal("thread_busy", 409));
    openApp(fake, t);
    const user = userEvent.setup();
    await user.click(await compactNow());
    const dialog = await screen.findByRole("dialog", {}, WAIT);
    await user.click(within(dialog).getByRole("button", { name: "Compact now" }));
    await within(dialog).findByRole("button", { name: "Compacting…" }, WAIT);
    // Another tab started a run meanwhile.
    must(fake.threads.get(t)).status = "running";
    release();
    expect((await within(dialog).findByRole("alert", {}, WAIT)).textContent).toBe(
      COMPACT_THREAD_ERROR_MESSAGES.thread_busy,
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(offered()).not.toBe("enabled"), WAIT);
  });

  it("says why on an interrupted thread: Retry or continue first", async () => {
    const t = conversation();
    must(fake.threads.get(t)).status = "interrupted";
    openApp(fake, t);
    const item = await waitFor(async () => {
      const found = await compactNow();
      expect(found.getAttribute("aria-disabled")).toBe("true");
      return found;
    }, WAIT);
    const description = must(document.getElementById(must(item.getAttribute("aria-describedby"))));
    expect(description.textContent).toBe(
      "Retry the interrupted run, or continue without retry, first.",
    );
  });

  it("returns focus to the answer's Compact now when the dialog closes", async () => {
    const t = conversation();
    openApp(fake, t);
    const user = userEvent.setup();
    const button = await compactNow();
    await user.click(button);
    await screen.findByRole("dialog", {}, WAIT);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), WAIT);
    expect(document.activeElement).toBe(button);
  });

  it("/compact and the palette open the same dialog; focus then returns to the answer's button", async () => {
    const t = conversation();
    openApp(fake, t);
    const user = userEvent.setup();
    const button = await compactNow();
    const input = await composer();
    await user.type(input, "/compact");
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog", { name: "Compact this thread" }, WAIT);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), WAIT);
    // Opened from the message box: focus goes back there.
    expect(document.activeElement === input || document.activeElement === button).toBe(true);
  });
});

describe("the gauge after Compact now, once a run streamed in this tab (KOBE-293)", () => {
  // ~30k tokens, as the KOBE-285 compact-now spec sends: stored, but streamed without its body.
  const LONG = `Reply only with OK. ${Array.from({ length: 2400 }, (_, i) => `Entry ${i}: the harbour log notes the tide near the beacon.`).join(" ")}`;

  /** Sends `text` (pasted: typing 100 KB key by key is slow) and streams its run to the end. */
  async function runTurn(t: string, text: string, tokens: number) {
    const user = userEvent.setup();
    await user.click(await composer());
    await user.paste(text);
    await user.keyboard("{Enter}");
    const run = await waitFor(() => must(fake.activeRun(t)), WAIT);
    await streaming(fake, run.run_id);
    fake.agent.commitPrompt(run.run_id);
    fake.agent.commit(
      run.run_id,
      {
        role: "assistant",
        content: [{ type: "text", text: `Answer ${tokens}` }],
        usage: { input: tokens, cacheRead: 0, cacheWrite: 0 },
      },
      "m1",
    );
    fake.threadLatestCall.set(t, {
      run_id: run.run_id,
      at: "2026-10-14T10:05:00.000Z",
      model: "ollama/kimi",
      input_tokens: tokens,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    });
    fake.agent.complete(run.run_id);
    await screen.findByText(`Answer ${tokens}`, {}, WAIT);
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeTruthy(), WAIT);
  }

  const gaugeNow = () =>
    Number(screen.getByRole("meter", { name: "Context used" }).getAttribute("aria-valuenow"));

  it.each([
    ["a prompt over 64 KiB (stored, streamed without its body)", LONG],
    ["a short prompt", "Reply only with OK."],
  ])(
    "after %s: unknown until the next model call",
    async (_name, prompt) => {
      const t = conversation();
      openApp(fake, t);
      await screen.findByText("They add up to 42.", {}, WAIT);
      await runTurn(t, prompt, 40_800);
      await waitFor(() => expect(gaugeNow()).toBe(40_800), WAIT);

      const user = userEvent.setup();
      await user.click(await compactNow());
      const dialog = await screen.findByRole("dialog", { name: "Compact this thread" }, WAIT);
      await user.click(within(dialog).getByRole("button", { name: "Compact now" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), WAIT);
      await waitFor(() => must(document.querySelector('[data-kobe-marker="compaction"]')), WAIT);
      await waitFor(() => expect(announcement()).toBe("The conversation was compacted."), WAIT);
      await waitFor(
        () => expect(fake.requests.filter(usageReads(t)).length).toBeGreaterThan(0),
        WAIT,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(screen.queryByRole("meter")).toBeNull();

      // The next call is the size after the compaction.
      await runTurn(t, "And now?", 3_000);
      await waitFor(() => expect(gaugeNow()).toBe(3_000), WAIT);
    },
    30_000,
  );
});
