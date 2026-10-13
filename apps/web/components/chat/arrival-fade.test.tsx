// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { Profiler } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { IconActionProvider } from "../shell/icon-action";
import { Markdown } from "./markdown";
import { composer, openApp, streaming } from "./testing";
import userEvent from "@testing-library/user-event";

/**
 * KOBE-207 (CE11): words arriving in a streaming answer fade from the accent tint, CSS only. The
 * words are spans that React mounts as text arrives (the CSS animation runs on mount), only while
 * the part streams; the fade's tint is set only while the message list is pinned.
 */
// A variable path: Vite rewrites `new URL("literal", import.meta.url)` into a served asset URL.
const css = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const CSS = css("../../app/chat-global.css");
const flat = (css: string) => css.replace(/\s+/g, " ");

const words = (root: ParentNode) =>
  [...root.querySelectorAll("[data-kobe-word]")].map((w) => w.textContent);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderMarkdown(text: string, arriving: boolean, onRender?: () => void) {
  const tree = (t: string) => (
    <IconActionProvider>
      <Profiler id="markdown" onRender={() => onRender?.()}>
        <Markdown text={t} arriving={arriving} />
      </Profiler>
    </IconActionProvider>
  );
  const view = render(tree(text));
  return { ...view, update: (t: string) => view.rerender(tree(t)) };
}

describe("arriving words (ac-1)", () => {
  it("wraps each word of a streaming part in a span, keeping the text and Markdown", () => {
    const { container } = renderMarkdown("Here is **the** chart\n\n- one", true);
    const root = must(container.querySelector("[data-kobe-arrive]"));
    expect(root.getAttribute("data-kobe-arrive")).toBe("running");
    expect(words(root)).toEqual(["Here ", "is ", "the", "chart", "one"]);
    expect(root.querySelector("strong [data-kobe-word]")?.textContent).toBe("the");
    expect(root.textContent?.replace(/\s+/g, " ")).toBe("Here is the chart one ");
  });

  it("renders a finished part as plain text, without spans", () => {
    const { container } = renderMarkdown("Here is the chart", false);
    expect(container.querySelector("[data-kobe-arrive]")).toBeNull();
    expect(words(container)).toEqual([]);
    expect(screen.getByText("Here is the chart")).toBeTruthy();
  });

  it("keeps arrived words' spans as text grows, so only new words mount (and fade)", () => {
    const { container, update } = renderMarkdown("Here is", true);
    const first = must(container.querySelector("[data-kobe-word]"));
    update("Here is the chart");
    expect(words(container)).toEqual(["Here ", "is ", "the ", "chart"]);
    expect(container.querySelector("[data-kobe-word]")).toBe(first);
  });
});

describe("render count (ac-2)", () => {
  it("costs no React renders per token over plain Markdown", () => {
    const tokens = ["Here", " is", " the", " chart", " you", " asked", " for."];
    const count = (arriving: boolean) => {
      let renders = 0;
      const { update } = renderMarkdown("", arriving, () => renders++);
      let text = "";
      for (const token of tokens) {
        text += token;
        update(text);
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
    const css = flat(CSS);
    expect(css).toMatch(
      /@keyframes kobe-arrive \{ from \{ color: var\(--kobe-arrive-tint\); \} \}/,
    );
    expect(css).toMatch(
      /\[data-kobe-arrive="running"\] \[data-kobe-word\] \{ animation: kobe-arrive 600ms/,
    );
  });

  it("tints only while the message list is pinned; otherwise words arrive plain", () => {
    const css = flat(CSS);
    expect(css).toContain('[data-kobe-scroll="messages"] { --kobe-arrive-tint: currentColor; }');
    expect(css).toMatch(
      /\[data-kobe-scroll="messages"\]\[data-kobe-follow="pinned"\] \{ --kobe-arrive-tint: var\(--admin-accent/,
    );
  });

  it("under reduced motion: no fade, a static bar beside the paragraph being written", () => {
    const reduced = flat(must(CSS.split("@media (prefers-reduced-motion: reduce)")[1]));
    expect(reduced).toMatch(/\[data-kobe-word\] \{ animation: none; \}/);
    expect(reduced).toMatch(
      /\[data-kobe-follow="pinned"\] \[data-kobe-arrive="running"\] > :last-child \{ box-shadow:/,
    );
  });
});

describe("in the conversation", () => {
  let kobe: FakeKobe;

  beforeEach(() => {
    sessionStorage.clear();
    kobe = new FakeKobe();
    vi.stubGlobal("fetch", kobe.fetch);
  });

  async function startRun() {
    const t = kobe.addThread("Sales");
    openApp(kobe, t);
    await userEvent.setup().type(await composer(), "draw a chart{Enter}");
    const run = must(await waitFor(() => must(kobe.activeRun(t))));
    await streaming(kobe, run.run_id);
    return run.run_id;
  }

  const answer = () =>
    must(document.querySelector<HTMLElement>('[data-role="assistant"][aria-busy="true"]'));

  it("streaming answer and reasoning words arrive as spans; tool output does not (ac-1)", async () => {
    const runId = await startRun();
    act(() =>
      kobe.emit(runId, "reasoning.delta", { message_id: "m1", content_index: 0, delta: "Plan it" }),
    );
    await waitFor(() => expect(words(answer())).toEqual(["Plan ", "it"]));
    // Only the part being written: once the answer starts, the reasoning's words are plain.
    act(() => kobe.agent.delta(runId, "m1", "Here is", 1));
    await waitFor(() => expect(words(answer())).toEqual(["Here ", "is"]));
    act(() => kobe.agent.toolCall(runId, "tc1", "bash", { command: "ls" }, "m1"));
    act(() => kobe.agent.toolResult(runId, "tc1", "bash", "file-a file-b"));
    expect(await screen.findByText(/file-a file-b/)).toBeTruthy();
    expect(screen.getByText(/file-a file-b/).closest("[data-kobe-word]")).toBeNull();
    // The answer part is no longer the one being written: its words are plain again.
    expect(words(answer())).toEqual([]);
  });

  it("marks the message list with its follow state for the CSS (ac-3)", async () => {
    await startRun();
    const list = must(document.querySelector<HTMLElement>('[data-kobe-scroll="messages"]'));
    await waitFor(() => expect(list.dataset.kobeFollow).toBe("pinned"));
  });
});
