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
 * KOBE-211 (CE14): the context gauge in bar row two. Numerator: the newest model call's prompt
 * plus cache-read tokens (run_usage on load, message usage while a run goes); denominator: the
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

/** A thread whose newest model call (run_usage) read `tokens`: 1k of them from the cache. */
function threadWith(tokens: number | null, model: string | null = null): string {
  const t = fake.addThread("Report");
  must(fake.threads.get(t)).model = model;
  if (tokens !== null) {
    fake.threadLatestCall.set(t, {
      at: "2026-10-14T10:00:00.000Z",
      model: "ollama/kimi",
      input_tokens: tokens - 1_000,
      cache_read_tokens: 1_000,
    });
  }
  return t;
}

const valueOf = (el: HTMLElement) => ({
  now: Number(el.getAttribute("aria-valuenow")),
  max: Number(el.getAttribute("aria-valuemax")),
  text: el.getAttribute("aria-valuetext"),
  level: el.getAttribute("data-level"),
});

describe("context gauge", () => {
  it("is empty before the first turn, scaled to the thread model's window", async () => {
    openApp(fake, threadWith(null));
    const gauge = await meter();
    await waitFor(() =>
      expect(valueOf(gauge)).toEqual({
        now: 0,
        max: 200_000,
        text: "0 of 200k tokens (0%) · Kimi K2.7 Code",
        level: "ok",
      }),
    );
    expect(gauge.getAttribute("aria-valuemin")).toBe("0");
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

    // The gateway's own count of that call lands in run_usage; the gauge reads it after the run.
    fake.threadLatestCall.set(t, {
      at: "2026-10-14T10:05:00.000Z",
      model: "ollama/kimi",
      input_tokens: 1_200,
      cache_read_tokens: 99_000,
    });
    fake.agent.complete(run.run_id);
    await waitFor(() => expect(valueOf(gauge).now).toBe(100_200), { timeout: 4_000 });
  });

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
        text: "150k of 1M tokens (15%) · GLM 5.3",
        level: "ok",
      }),
    );
  });

  it("offers no Compact action at red until compaction lands (B9)", async () => {
    openApp(fake, threadWith(190_000));
    const gauge = await meter();
    await waitFor(() => expect(valueOf(gauge).level).toBe("full"));
    expect(screen.queryByRole("button", { name: "Compact this thread" })).toBeNull();
  });
});

describe("ContextGauge with a compact handler (B9 wires it)", () => {
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
