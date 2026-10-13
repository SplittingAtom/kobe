// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { Profiler } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { IconActionProvider } from "../shell/icon-action";
import { splitWords } from "./arriving-words";
import { Markdown } from "./markdown";
import { composer, openApp, streamed, streaming } from "./testing";

/**
 * KOBE-207 (CE11): words arriving in a streaming answer fade from the accent tint, CSS only. Words
 * that arrive after the text mounted are spans keyed by source offset (the CSS animation runs on
 * mount); the fade runs while the part is being written; its tint is set only while pinned.
 */
// A variable path: Vite rewrites `new URL("literal", import.meta.url)` into a served asset URL.
const css = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const CSS = css("../../app/chat-global.css");
const flat = (source: string) => source.replace(/\s+/g, " ");

const spans = (root: ParentNode) => [...root.querySelectorAll("[data-kobe-word]")];
const words = (root: ParentNode) => spans(root).map((w) => w.textContent);
const spanOf = (root: ParentNode, word: string) =>
  must(spans(root).find((w) => w.textContent?.trim() === word));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Agent Markdown mounted with `text`; `update` streams more, `finish` ends the part. */
function renderMarkdown(text: string, arriving = true, onRender?: () => void) {
  const tree = (t: string, running: boolean) => (
    <IconActionProvider>
      <Profiler id="markdown" onRender={() => onRender?.()}>
        <Markdown text={t} words arriving={running} />
      </Profiler>
    </IconActionProvider>
  );
  const view = render(tree(text, arriving));
  let current = text;
  return {
    ...view,
    update: (t: string) => {
      current = t;
      view.rerender(tree(t, arriving));
    },
    finish: () => view.rerender(tree(current, false)),
  };
}

/** Mounted empty, then streamed `text`. */
function streamMarkdown(text: string) {
  const view = renderMarkdown("");
  view.update(text);
  return view;
}

describe("splitWords", () => {
  it("splits leading whitespace and words with their offsets", () => {
    expect(splitWords("  Here is\nit")).toEqual({
      lead: "  ",
      words: [
        { offset: 2, text: "Here " },
        { offset: 7, text: "is\n" },
        { offset: 10, text: "it" },
      ],
    });
    expect(splitWords(" ")).toEqual({ lead: " ", words: [] });
  });
});

describe("arriving words (ac-1)", () => {
  it("wraps each word that arrives in a span, keeping the text and Markdown", () => {
    const { container } = streamMarkdown("Here is **the** chart\n\n- one");
    const root = must(container.querySelector("[data-kobe-arrive]"));
    expect(root.getAttribute("data-kobe-arrive")).toBe("running");
    expect(words(root)).toEqual(["Here ", "is ", "the", "chart", "one"]);
    expect(root.querySelector("strong [data-kobe-word]")?.textContent).toBe("the");
    expect(root.textContent?.replace(/\s+/g, " ")).toBe("Here is the chart one ");
  });

  it("history (mounted finished) renders plain text, without spans", () => {
    const { container } = renderMarkdown("Here is the chart", false);
    expect(container.querySelector("[data-kobe-arrive]")).toBeNull();
    expect(words(container)).toEqual([]);
    expect(screen.getByText("Here is the chart")).toBeTruthy();
  });

  it("text already there at mount (a resume mid-run) stays plain; only later words fade", () => {
    const { container, update } = renderMarkdown("Here is the");
    expect(words(container)).toEqual([]);
    update("Here is the chart you asked for");
    expect(words(container)).toEqual(["chart ", "you ", "asked ", "for"]);
  });

  it("keeps the spans when the part finishes and only drops the fade marker", () => {
    const { container, update, finish } = renderMarkdown("");
    update("Here is the chart");
    const before = spans(container);
    finish();
    expect(container.querySelector("[data-kobe-arrive]")).toBeNull();
    expect(spans(container)).toEqual(before);
    expect(spans(container).every((s, i) => s === before[i])).toBe(true);
  });

  it("leaves code blocks and inline code plain, however long", () => {
    const code = Array.from({ length: 400 }, (_, i) => `let value${i} = compute(${i});`).join("\n");
    const { container } = streamMarkdown(
      `Intro words\n\n\`\`\`js\n${code}\n\`\`\`\n\nuse \`npm ci\``,
    );
    expect(words(container)).toEqual(["Intro ", "words", "use "]);
    expect(must(container.querySelector("pre")).querySelector("[data-kobe-word]")).toBeNull();
    expect(must(container.querySelector("pre")).textContent).toContain("let value399");
  });
});

describe("word identity across re-renders and re-parses (ac-1, ac-2)", () => {
  it("arrived words keep their element as text grows, so only new words mount", () => {
    const { container, update } = streamMarkdown("Here is");
    const first = spanOf(container, "Here");
    update("Here is the chart");
    expect(words(container)).toEqual(["Here ", "is ", "the ", "chart"]);
    expect(spanOf(container, "Here")).toBe(first);
  });

  /** Streams `from`, then `to`: `kept` words keep their element; `fresh` words get new ones. */
  function reparse(from: string, to: string, kept: readonly string[], fresh: readonly string[]) {
    const { container, update } = streamMarkdown(from);
    const before = new Set(spans(container));
    const keptBefore = kept.map((w) => spanOf(container, w));
    update(to);
    kept.forEach((w, i) => expect(spanOf(container, w), w).toBe(keptBefore[i]));
    for (const w of fresh) expect(before.has(spanOf(container, w)), w).toBe(false);
  }

  it("a closing backtick: earlier words stay, words after the code are new", () => {
    reparse("Use the `npm", "Use the `npm` command now", ["Use", "the"], ["command", "now"]);
  });

  it("a closing **: earlier words stay, words after the bold are new", () => {
    reparse("a **b c", "a **b c** d e", ["a"], ["d", "e"]);
  });

  it("a setext heading: words after it are new, not reused spans", () => {
    reparse("Title\nmore", "Title\n===\n\nNext words", [], ["Next", "words"]);
  });
});

describe("render count (ac-2)", () => {
  it("costs no React renders per token over plain Markdown", () => {
    const tokens = ["Here", " is", " the", " chart", " you", " asked", " for."];
    const count = (fade: boolean) => {
      let renders = 0;
      const tree = (t: string) => (
        <IconActionProvider>
          <Profiler id="markdown" onRender={() => renders++}>
            <Markdown text={t} words={fade} arriving={fade} />
          </Profiler>
        </IconActionProvider>
      );
      const view = render(tree(""));
      let text = "";
      for (const token of tokens) {
        text += token;
        view.rerender(tree(text));
      }
      cleanup();
      return renders;
    };
    const before = count(false);
    expect(before).toBe(tokens.length + 1);
    expect(count(true)).toBe(before);
  });
});

describe("the fade's CSS (ac-1, ac-3)", () => {
  it("animates arriving words over 600 ms from the tint", () => {
    const source = flat(CSS);
    expect(source).toMatch(
      /\[data-kobe-arrive="running"\] \[data-kobe-word\] \{ color: [^;]+; animation: kobe-arrive 600ms/,
    );
  });

  it("mixes two colours in one space; it never interpolates a colour (KOBE-269)", () => {
    const source = flat(CSS);
    // Endpoints: the tint at the start (0% arrived), the inherited text colour at the end and at
    // rest (100%); the text colour first, so the build's no-color-mix fallback is the text colour.
    expect(source).toContain(
      '@property --kobe-arrived { syntax: "<percentage>"; inherits: false; initial-value: 100%; }',
    );
    expect(source).toContain(
      "@keyframes kobe-arrive { from { --kobe-arrived: 0%; } to { --kobe-arrived: 100%; } }",
    );
    expect(source).toContain(
      "color: color-mix(in srgb, currentColor var(--kobe-arrived), var(--kobe-arrive-tint));",
    );
    const keyframes = must(source.match(/@keyframes kobe-arrive \{.*?\} \}/))[0];
    expect(keyframes).not.toMatch(/[{;] ?color:/);
  });

  it("tints only while the message list is pinned; otherwise words arrive plain", () => {
    const source = flat(CSS);
    expect(source).toContain('[data-kobe-scroll="messages"] { --kobe-arrive-tint: currentColor; }');
    expect(source).toMatch(
      /\[data-kobe-scroll="messages"\]\[data-kobe-follow="pinned"\] \{ --kobe-arrive-tint: var\(--admin-accent/,
    );
  });

  it("under reduced motion: no fade, a static inset bar in the block being written", () => {
    const reduced = flat(must(CSS.split("@media (prefers-reduced-motion: reduce)")[1]));
    expect(reduced).toMatch(/\[data-kobe-word\] \{ animation: none; \}/);
    expect(reduced).toContain(
      '[data-kobe-follow="pinned"] [data-kobe-arrive="running"] > :last-child { box-shadow: inset 2px 0 0 0 var(--kobe-arrive-tint); }',
    );
    expect(reduced).not.toContain("var(--background)");
  });
});

describe("in the conversation", () => {
  let kobe: FakeKobe;

  beforeEach(() => {
    sessionStorage.clear();
    kobe = new FakeKobe();
    vi.stubGlobal("fetch", kobe.fetch);
  });

  async function startRun(t: string) {
    await userEvent.setup().type(await composer(), "draw a chart{Enter}");
    const run = must(await waitFor(() => must(kobe.activeRun(t))));
    await streaming(kobe, run.run_id);
    return run.run_id;
  }

  const answerText = () =>
    [...document.querySelectorAll('[data-role="assistant"]')].map((m) => m.textContent).join(" ");

  const answer = () =>
    must(document.querySelector<HTMLElement>('[data-role="assistant"][aria-busy="true"]'));

  it("streaming answer and reasoning words arrive as spans; tool output does not (ac-1)", async () => {
    const t = kobe.addThread("Sales");
    openApp(kobe, t);
    const runId = await startRun(t);
    const think = (delta: string) =>
      kobe.emit(runId, "reasoning.delta", { message_id: "m1", content_index: 0, delta });
    act(() => think("Plan "));
    await waitFor(() => expect(answer().textContent).toContain("Plan"));
    act(() => think("it"));
    await waitFor(() => expect(words(answer())).toEqual(["it"]));
    act(() => kobe.agent.delta(runId, "m1", "Here", 1));
    await waitFor(() => expect(answer().textContent).toContain("Here"));
    act(() => kobe.agent.delta(runId, "m1", " is", 1));
    await waitFor(() => expect(words(answer())).toEqual(["it", "is"]));
    expect(answer().querySelectorAll('[data-kobe-arrive="running"]')).toHaveLength(1);

    act(() => kobe.agent.toolCall(runId, "tc1", "bash", { command: "ls" }, "m1"));
    act(() => kobe.agent.toolResult(runId, "tc1", "bash", "file-a file-b"));
    expect(await screen.findByText(/file-a file-b/)).toBeTruthy();
    expect(screen.getByText(/file-a file-b/).closest("[data-kobe-word]")).toBeNull();
    // The answer text is no longer being written: its words keep their spans, without the fade.
    const text = must(spanOf(answer(), "is").closest("[data-kobe-words]"));
    expect(text.hasAttribute("data-kobe-arrive")).toBe(false);
    expect(words(answer())).toEqual(["it", "is"]);
  });

  it("reopening mid-run shows what streamed so far plain; only new words fade (resume)", async () => {
    const t = kobe.addThread("Sales");
    const first = openApp(kobe, t);
    const runId = await startRun(t);
    kobe.agent.delta(runId, "m1", "one, ");
    kobe.agent.delta(runId, "m1", "two, ");
    expect(await screen.findByText(streamed("one, two,"))).toBeTruthy();

    first.unmount(); // the tab is refreshed while the run goes on
    kobe.agent.delta(runId, "m1", "three, ");
    openApp(kobe, t);
    expect(await screen.findByText(streamed("one, two, three,"))).toBeTruthy();
    expect(words(document)).toEqual([]);

    await streaming(kobe, runId);
    act(() => kobe.agent.delta(runId, "m1", "four"));
    await waitFor(() => expect(words(document)).toEqual(["four"]));
  });

  it("Stop ends the fade at once, before the server confirms the run ended (KOBE-269)", async () => {
    const t = kobe.addThread("Sales");
    // The server accepts the cancel but the run's end arrives later (the sandbox is stopping).
    const real = kobe.fetch;
    const delayed: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input), "http://kobe.test");
      if (init.method === "POST" && url.pathname.endsWith("/cancel")) {
        const res = await real(url.pathname.replace(/\/cancel$/, ""), { method: "GET" });
        return Response.json(await res.json(), { status: 202 });
      }
      return real(input, init);
    };
    Object.defineProperty(kobe, "fetch", { value: delayed });
    openApp(kobe, t);
    const runId = await startRun(t);
    act(() => kobe.agent.delta(runId, "m1", "Here is", 1));
    await waitFor(() =>
      expect(document.querySelector('[data-kobe-arrive="running"]')).toBeTruthy(),
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(document.querySelector("[data-kobe-arrive]")).toBeNull());
    // Words that still arrive before the run's end don't fade either.
    act(() => kobe.agent.delta(runId, "m1", " more", 1));
    await waitFor(() => expect(answerText()).toContain("more"));
    expect(document.querySelector("[data-kobe-arrive]")).toBeNull();
  });

  it("after Stop and the run's end, no part is left marked as being written (KOBE-269)", async () => {
    const t = kobe.addThread("Sales");
    openApp(kobe, t);
    const runId = await startRun(t);
    act(() => kobe.agent.delta(runId, "m1", "Here is", 1));
    await waitFor(() =>
      expect(document.querySelector('[data-kobe-arrive="running"]')).toBeTruthy(),
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(kobe.activeRun(t)).toBeUndefined());
    await waitFor(() => expect(document.querySelector("[data-kobe-arrive]")).toBeNull());
  });

  it("marks the message list with its follow state for the CSS (ac-3)", async () => {
    const t = kobe.addThread("Sales");
    openApp(kobe, t);
    await startRun(t);
    const list = must(document.querySelector<HTMLElement>('[data-kobe-scroll="messages"]'));
    await waitFor(() => expect(list.dataset.kobeFollow).toBe("pinned"));
  });
});
