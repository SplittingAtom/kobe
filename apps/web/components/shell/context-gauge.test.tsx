// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { composer, openApp, streaming } from "../chat/testing";
import { ContextGauge } from "./context-gauge";
import { IconActionProvider } from "./icon-action";

/**
 * KOBE-211 (CE14): the context gauge, under the composer since KOBE-418. Numerator: the newest
 * model call's prompt plus cache-read tokens (run_usage on load, message usage while a run goes);
 * denominator: the
 * thread model's context window (KOBE-210).
 */
let fake: FakeKobe;

beforeEach(() => {
  sessionStorage.clear();
  fake = new FakeKobe();
  fake.teamModels.push(
    {
      alias: "kimi",
      label: "Kimi K2.7 Code",
      enabled: true,
      is_default: true,
      context_window: 200_000,
    },
    { alias: "glm", label: "GLM 5.3", enabled: true, is_default: false, context_window: 1_000_000 },
    { alias: "blank", label: "Blank", enabled: true, is_default: false },
  );
  vi.stubGlobal("fetch", fake.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const meter = () => screen.findByRole("meter", { name: "Context used" });

const usageReads = (t: string) => (r: { method: string; path: string }) =>
  r.method === "GET" && r.path === `/v1/threads/${t}/usage`;

/** run_usage's newest call: `tokens` of prompt, 1k read from and 2k written to the cache. */
const latestCall = (tokens: number, runId = "00000000-0000-4000-8000-0000000000aa") => ({
  run_id: runId,
  at: "2026-10-14T10:00:00.000Z",
  model: "ollama/kimi",
  input_tokens: tokens - 3_000,
  cache_read_tokens: 1_000,
  cache_write_tokens: 2_000,
});

function threadWith(tokens: number | null, model: string | null = null): string {
  const t = fake.addThread("Report");
  must(fake.threads.get(t)).model = model;
  if (tokens !== null) fake.threadLatestCall.set(t, latestCall(tokens));
  return t;
}

const valueOf = (el: HTMLElement) => ({
  now: Number(el.getAttribute("aria-valuenow")),
  max: Number(el.getAttribute("aria-valuemax")),
  text: el.getAttribute("aria-valuetext"),
  level: el.getAttribute("data-level"),
});

describe("context gauge", () => {
  it("is hidden before the first model call", async () => {
    openApp(fake, threadWith(null));
    await screen.findByRole("combobox", { name: "Model for this conversation" });
    await composer();
    expect(screen.queryByRole("meter")).toBeNull();
    expect(document.querySelector("[data-context-gauge]")).toBeNull();
  });

  it("is hidden after a compaction that no model call followed yet", async () => {
    const t = threadWith(190_000);
    const answer = fake.addEntry(t, null, {
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
      usage: { input: 1_000, cacheRead: 189_000, cacheWrite: 0 },
    });
    const thread = must(fake.threads.get(t));
    thread.entries.push({
      entry_id: "c1",
      parent_id: answer,
      seq: thread.entries.length + 1,
      type: "compaction",
      payload: { type: "compaction", id: "c1", parentId: answer, summary: "…", tokensBefore: 1 },
      payload_offloaded: false,
      created_at: "2026-10-14T10:01:00.000Z",
    });
    openApp(fake, t);
    await composer();
    await screen.findByText("Done.");
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("shows run_usage's newest call on load, follows message usage during a run, then run_usage again", async () => {
    const t = threadWith(42_000);
    openApp(fake, t);
    const gauge = await meter();
    await waitFor(() => expect(valueOf(gauge).now).toBe(42_000));

    const user = userEvent.setup();
    await user.type(await composer(), "Go on{Enter}");
    const run = await waitFor(() => must(fake.activeRun(t)));
    await streaming(fake, run.run_id);
    fake.agent.commitPrompt(run.run_id);
    fake.agent.commit(run.run_id, {
      role: "assistant",
      content: [{ type: "text", text: "Reading the files." }],
      usage: { input: 1_000, output: 50, cacheRead: 99_000, cacheWrite: 0 },
    });
    await waitFor(() => expect(valueOf(gauge).now).toBe(100_000));
    expect(valueOf(gauge).text).toBe("100k of 200k tokens (50%) · Kimi K2.7 Code");

    // The gateway's count of that call lands in run_usage late: a read that still has only the
    // previous run's call keeps the streamed value, and the gauge reads again.
    fake.agent.complete(run.run_id);
    await waitFor(() => expect(fake.requests.filter(usageReads(t))).toHaveLength(2), {
      timeout: 4_000,
    });
    expect(valueOf(gauge).now).toBe(100_000);
    fake.threadLatestCall.set(t, latestCall(100_200, run.run_id));
    await waitFor(() => expect(valueOf(gauge).now).toBe(100_200), { timeout: 6_000 });
  }, 15_000);

  it.each([
    [129_000, "ok", "129k of 200k tokens (64%)"],
    [130_000, "warn", "130k of 200k tokens (65%)"],
    [169_999, "warn", "170k of 200k tokens (84%)"],
    [170_000, "full", "170k of 200k tokens (85%)"],
    [260_000, "full", "260k of 200k tokens (130%)"],
  ])("at %i tokens is %s and says %s", async (tokens, level, text) => {
    openApp(fake, threadWith(tokens));
    const gauge = await meter();
    await waitFor(() => expect(valueOf(gauge).level).toBe(level));
    expect(valueOf(gauge).text).toBe(`${text} · Kimi K2.7 Code`);
    expect(valueOf(gauge).now).toBe(Math.min(tokens, 200_000));
  });

  it("names the numbers and the model in its tooltip", async () => {
    openApp(fake, threadWith(142_000));
    const gauge = await meter();
    await waitFor(() => expect(valueOf(gauge).now).toBe(142_000));
    await userEvent.setup().hover(gauge);
    const tip = await waitFor(() =>
      must(document.querySelector<HTMLElement>('[data-slot="tooltip-content"]')),
    );
    expect(tip.textContent).toContain("142k of 200k tokens (71%) · Kimi K2.7 Code");
  });

  it("shows tokens only when the model's context window is blank", async () => {
    openApp(fake, threadWith(142_000, "blank"));
    const tokens = await screen.findByText("142k tokens");
    expect(screen.queryByRole("meter")).toBeNull();
    expect(must(tokens.closest("[data-context-gauge]")).textContent).toBe(
      "Context used: 142k tokens",
    );
  });

  it("re-scales on a model change without clearing the fill", async () => {
    const t = threadWith(150_000);
    openApp(fake, t);
    const gauge = await meter();
    await waitFor(() => expect(valueOf(gauge).level).toBe("warn"));
    const picker = (await screen.findByRole("combobox", {
      name: "Model for this conversation",
    })) as HTMLSelectElement;
    await userEvent.setup().selectOptions(picker, "glm");
    await waitFor(() =>
      expect(valueOf(gauge)).toEqual({
        now: 150_000,
        max: 1_000_000,
        // Kimi's tokenizer counted them; GLM's window is the scale from now on.
        text: "150k of 1M tokens (15%) · GLM 5.3 · counted by Kimi K2.7 Code",
        level: "ok",
      }),
    );
  });

  it("offers Compact this thread at red, disabled while there is nothing to compact (B9)", async () => {
    openApp(fake, threadWith(190_000));
    const gauge = await meter();
    await waitFor(() => expect(valueOf(gauge).level).toBe("full"));
    const action = await screen.findByRole(
      "button",
      { name: "Compact this thread" },
      { timeout: 10_000 },
    );
    expect(action.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("under the composer (KOBE-418 ac-5)", () => {
  /** The row under the composer box: the hint, then the gauge at its end. */
  const footer = () =>
    waitFor(() => must(document.querySelector<HTMLElement>("[data-composer-footer]")));

  it("sits under the composer, right-aligned, not in the bar", async () => {
    openApp(fake, threadWith(142_000));
    const gauge = await meter();
    const row = await footer();
    expect(document.querySelector("header")?.contains(gauge)).toBe(false);
    expect(row.contains(gauge)).toBe(true);
    // Below the composer's box, in the same column.
    const box = must(document.querySelector("[data-kobe-composer-box]"));
    expect(box.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.closest("[data-kobe-composer]")).not.toBeNull();
    // The gauge is the row's last item, pushed to its end.
    const slot = must(row.querySelector<HTMLElement>("[data-composer-gauge]"));
    expect(slot.contains(gauge)).toBe(true);
    expect(row.lastElementChild).toBe(slot);
    expect(slot.className).toContain("ms-auto");
  });

  it("keeps its row while there is no gauge yet, so nothing moves when it appears", async () => {
    openApp(fake, threadWith(null));
    await composer();
    const row = await footer();
    expect(row.querySelector("[data-composer-gauge]")).not.toBeNull();
    expect(row.className).toContain("min-h-6");
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("stays under a shared thread's banner, where there is no composer", async () => {
    const t = threadWith(142_000);
    must(fake.threads.get(t)).read_only = true;
    openApp(fake, t);
    const gauge = await meter();
    expect((await footer()).contains(gauge)).toBe(true);
    expect(screen.getByText(/You are reading a shared conversation/)).toBeTruthy();
  });
});

describe("ContextGauge with a compact handler (B9)", () => {
  const renderGauge = (tokens: number, onCompact: () => void) =>
    render(
      <IconActionProvider>
        <ContextGauge tokens={tokens} window={200_000} model="Kimi" onCompact={onCompact} />
      </IconActionProvider>,
    );

  it("offers Compact this thread at red only", async () => {
    const onCompact = vi.fn();
    const { rerender } = renderGauge(160_000, onCompact);
    expect(screen.queryByRole("button", { name: "Compact this thread" })).toBeNull();
    rerender(
      <IconActionProvider>
        <ContextGauge tokens={180_000} window={200_000} model="Kimi" onCompact={onCompact} />
      </IconActionProvider>,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Compact this thread" }));
    expect(onCompact).toHaveBeenCalledOnce();
  });
});
