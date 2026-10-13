// @vitest-environment happy-dom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { composer, openApp, streaming } from "./testing";

/**
 * KOBE-205 (CE9): the message list follows the stream while pinned, shows Jump to latest when the
 * member scrolls up, and remembers each thread's position. happy-dom has no layout, so the message
 * list's geometry is faked: `content` is its scroll height, the box is 500 px tall.
 */
const VIEW = 500;
let content = 2000;
const tops = new WeakMap<Element, number>();
const isList = (el: Element) => el instanceof HTMLElement && el.dataset.kobeScroll === "messages";
const maxTop = () => Math.max(0, content - VIEW);

/** Resize observers fire when the test says the content grew. */
const observers = new Set<() => void>();
class FakeResizeObserver {
  private readonly run: () => void;
  constructor(callback: ResizeObserverCallback) {
    this.run = () => callback([], this as unknown as ResizeObserver);
  }
  observe() {
    observers.add(this.run);
  }
  unobserve() {}
  disconnect() {
    observers.delete(this.run);
  }
}

const saved = new Map<string, PropertyDescriptor | undefined>();
function fake(name: string, descriptor: PropertyDescriptor) {
  saved.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, ...descriptor });
}

function fakeGeometry() {
  const inherited = (name: string) => Object.getOwnPropertyDescriptor(Element.prototype, name);
  const scrollTop = inherited("scrollTop");
  fake("scrollHeight", {
    get(this: HTMLElement) {
      return isList(this) ? content : (inherited("scrollHeight")?.get?.call(this) ?? 0);
    },
  });
  fake("clientHeight", {
    get(this: HTMLElement) {
      return isList(this) ? VIEW : (inherited("clientHeight")?.get?.call(this) ?? 0);
    },
  });
  fake("scrollTop", {
    get(this: HTMLElement) {
      return isList(this) ? (tops.get(this) ?? 0) : (scrollTop?.get?.call(this) ?? 0);
    },
    set(this: HTMLElement, value: number) {
      if (isList(this)) tops.set(this, Math.min(Math.max(0, value), maxTop()));
      else scrollTop?.set?.call(this, value);
    },
  });
  fake("scrollTo", {
    value(this: HTMLElement, options?: ScrollToOptions) {
      if (!isList(this)) return;
      this.scrollTop = options?.top ?? 0;
      this.dispatchEvent(new Event("scroll"));
    },
  });
}

function restoreGeometry() {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, name);
  }
  saved.clear();
}

const list = () => must(document.querySelector<HTMLElement>('[data-kobe-scroll="messages"]'));

/** The member scrolls the message list: the wheel turn, then the scroll it causes. */
function scrollTo(top: number) {
  act(() => {
    const deltaY = top - list().scrollTop;
    list().dispatchEvent(new WheelEvent("wheel", { deltaY }));
    list().scrollTop = top;
    list().dispatchEvent(new Event("scroll"));
  });
}

/** Content below grows by `px` (a streaming answer, a tool card). */
function grow(px: number) {
  content += px;
  act(() => {
    for (const run of observers) run();
  });
}

const pill = () => screen.queryByRole("button", { name: /^Jump to latest/ });

let kobe: FakeKobe;

beforeEach(() => {
  sessionStorage.clear();
  content = 2000;
  observers.clear();
  fakeGeometry();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  kobe = new FakeKobe();
  vi.stubGlobal("fetch", kobe.fetch);
});

afterEach(() => {
  cleanup();
  restoreGeometry();
  vi.unstubAllGlobals();
});

function threadWithHistory(title: string) {
  const t = kobe.addThread(title);
  const u1 = kobe.addEntry(t, null, { role: "user", content: `${title} question` });
  kobe.addEntry(t, u1, { role: "assistant", content: [{ type: "text", text: `${title} answer` }] });
  return t;
}

async function openAtBottom(t: string, title: string) {
  openApp(kobe, t);
  expect(await screen.findByText(`${title} answer`)).toBeTruthy();
  await waitFor(() => expect(list().scrollTop).toBe(maxTop()));
}

async function send(text: string) {
  const user = userEvent.setup();
  await user.type(await composer(), `${text}{Enter}`);
  return user;
}

async function startRun(t: string, text: string) {
  await send(text);
  const run = must(await waitFor(() => must(kobe.activeRun(t))));
  await streaming(kobe, run.run_id);
  return run.run_id;
}

describe("following the stream (ac-5)", () => {
  it("keeps the newest content in view while pinned, through assistant-ui's resize observer", async () => {
    const t = threadWithHistory("Sales");
    await openAtBottom(t, "Sales");
    const runId = await startRun(t, "draw a chart");

    act(() => kobe.agent.delta(runId, "m1", "Here is "));
    grow(300);
    await waitFor(() => expect(list().scrollTop).toBe(maxTop()));
    grow(200);
    await waitFor(() => expect(list().scrollTop).toBe(maxTop()));
    expect(pill()).toBeNull();
  });

  it("scrolling back down to within 48 px of the bottom re-pins", async () => {
    const t = threadWithHistory("Sales");
    await openAtBottom(t, "Sales");
    await startRun(t, "draw a chart");
    scrollTo(200);
    expect(await screen.findByRole("button", { name: "Jump to latest" })).toBeTruthy();

    scrollTo(maxTop() - 30);
    await waitFor(() => expect(list().scrollTop).toBe(maxTop()));
    await waitFor(() => expect(pill()).toBeNull());
    grow(200);
    await waitFor(() => expect(list().scrollTop).toBe(maxTop()));
  });
});

describe("Jump to latest (ac-1)", () => {
  it("scrolling up during a stream holds the view and counts new messages; the pill re-pins", async () => {
    const t = threadWithHistory("Sales");
    await openAtBottom(t, "Sales");
    expect(pill()).toBeNull();
    const runId = await startRun(t, "draw a chart");

    scrollTo(200);
    expect(await screen.findByRole("button", { name: "Jump to latest" })).toBeTruthy();

    act(() => kobe.agent.delta(runId, "m1", "Here is the chart"));
    // Streaming words are spans (KOBE-207), so the text is split across elements.
    await waitFor(() => expect(list().textContent).toContain("Here is the chart"));
    grow(600);
    expect(list().scrollTop).toBe(200);
    const jump = await screen.findByRole("button", { name: "Jump to latest, 1 new message" });
    expect(within(jump).getByText("1")).toBeTruthy();

    await userEvent.setup().click(jump);
    await waitFor(() => expect(list().scrollTop).toBe(maxTop()));
    await waitFor(() => expect(pill()).toBeNull());
  });

  it("any scroll up unpins, even a few pixels, and the stream then leaves the view alone", async () => {
    const t = threadWithHistory("Sales");
    await openAtBottom(t, "Sales");
    const runId = await startRun(t, "draw a chart");

    scrollTo(maxTop() - 10);
    expect(await screen.findByRole("button", { name: "Jump to latest" })).toBeTruthy();
    const held = list().scrollTop;
    act(() => kobe.agent.delta(runId, "m1", "Here is the chart"));
    grow(400);
    grow(400);
    expect(list().scrollTop).toBe(held);
  });

  it("sending re-pins, also once the sent message has rendered", async () => {
    const t = threadWithHistory("Sales");
    await openAtBottom(t, "Sales");
    scrollTo(100);
    expect(await screen.findByRole("button", { name: "Jump to latest" })).toBeTruthy();

    await send("one more thing");
    expect(await screen.findByText("one more thing")).toBeTruthy();
    grow(300);
    await waitFor(() => expect(list().scrollTop).toBe(maxTop()));
    await waitFor(() => expect(pill()).toBeNull());
  });
});

describe("scroll position per thread (ac-2)", () => {
  const titles = () => within(screen.getByRole("list", { name: "Your threads" }));

  it("a thread opens at the bottom, and reopening one restores where it was left", async () => {
    const a = threadWithHistory("Alpha");
    threadWithHistory("Beta");
    await openAtBottom(a, "Alpha");
    scrollTo(300);
    await waitFor(() => expect(sessionStorage.getItem(`kobe.scroll:${a}`)).toBe("300"));

    const user = userEvent.setup();
    await user.click(titles().getByRole("button", { name: "Beta" }));
    expect(await screen.findByText("Beta answer")).toBeTruthy();
    await waitFor(() => expect(list().scrollTop).toBe(maxTop()));

    await user.click(titles().getByRole("button", { name: "Alpha" }));
    expect(await screen.findByText("Alpha answer")).toBeTruthy();
    await waitFor(() => expect(list().scrollTop).toBe(300));
    expect(await screen.findByRole("button", { name: "Jump to latest" })).toBeTruthy();
  });

  it("a restored position stays put while content grows", async () => {
    const a = threadWithHistory("Alpha");
    sessionStorage.setItem(`kobe.scroll:${a}`, "300");
    openApp(kobe, a);
    expect(await screen.findByText("Alpha answer")).toBeTruthy();
    await waitFor(() => expect(list().scrollTop).toBe(300));
    grow(400);
    grow(400);
    expect(list().scrollTop).toBe(300);
  });

  it("a thread left at the bottom reopens at the bottom", async () => {
    const a = threadWithHistory("Alpha");
    await openAtBottom(a, "Alpha");
    scrollTo(300);
    scrollTo(maxTop());
    await waitFor(() => expect(sessionStorage.getItem(`kobe.scroll:${a}`)).toBe("bottom"));
  });

  it("leaving a thread saves its position at once, under its own key only", async () => {
    const a = threadWithHistory("Alpha");
    const b = threadWithHistory("Beta");
    // Beta's history waits until the test lets them through, so the switch can be caught midway.
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const serve = kobe.fetch;
    Object.defineProperty(kobe, "fetch", {
      value: async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (url.includes(`/v1/threads/${b}?`) && url.includes("limit=500")) await gate;
        return serve(input, init);
      },
    });
    await openAtBottom(a, "Alpha");
    scrollTo(300);
    expect(sessionStorage.getItem(`kobe.scroll:${a}`)).toBeNull(); // not written yet: debounced

    await userEvent.setup().click(titles().getByRole("button", { name: "Beta" }));
    await waitFor(() => expect(pill()).toBeNull()); // Alpha left, Beta not restored yet
    expect(sessionStorage.getItem(`kobe.scroll:${a}`)).toBe("300");
    // A late scroll while Beta loads belongs to neither thread.
    act(() => {
      list().scrollTop = 900;
      list().dispatchEvent(new Event("scroll"));
    });
    await new Promise((resolve) => setTimeout(resolve, 300)); // past the save delay
    expect(sessionStorage.getItem(`kobe.scroll:${a}`)).toBe("300");
    expect(sessionStorage.getItem(`kobe.scroll:${b}`)).toBeNull();
    release();
    expect(await screen.findByText("Beta answer")).toBeTruthy();
    await waitFor(() => expect(list().scrollTop).toBe(maxTop()));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sessionStorage.getItem(`kobe.scroll:${a}`)).toBe("300");
    expect(sessionStorage.getItem(`kobe.scroll:${b}`) ?? "bottom").toBe("bottom");
  });

  it("the pill's count starts again in each thread", async () => {
    const a = threadWithHistory("Alpha");
    const b = threadWithHistory("Beta");
    sessionStorage.setItem(`kobe.scroll:${b}`, "100");
    await openAtBottom(a, "Alpha");
    const runId = await startRun(a, "draw a chart");
    scrollTo(200);
    act(() => kobe.agent.delta(runId, "m1", "Here is the chart"));
    expect(
      await screen.findByRole("button", { name: "Jump to latest, 1 new message" }),
    ).toBeTruthy();

    await userEvent.setup().click(titles().getByRole("button", { name: "Beta" }));
    expect(await screen.findByText("Beta answer")).toBeTruthy();
    await waitFor(() => expect(list().scrollTop).toBe(100));
    expect(await screen.findByRole("button", { name: "Jump to latest" })).toBeTruthy();
  });
});

describe("arrival fade follows the pin (KOBE-207 ac-3)", () => {
  it("the list says unpinned while the member has scrolled up, pinned again at the bottom", async () => {
    const t = threadWithHistory("Sales");
    await openAtBottom(t, "Sales");
    const runId = await startRun(t, "draw a chart");
    expect(list().dataset.kobeFollow).toBe("pinned");

    scrollTo(200);
    await waitFor(() => expect(list().dataset.kobeFollow).toBe("unpinned"));
    act(() => kobe.agent.delta(runId, "m1", "Here"));
    await waitFor(() => expect(list().textContent).toContain("Here"));
    act(() => kobe.agent.delta(runId, "m1", " is"));
    // New words still mount as spans; the CSS gives them no tint while unpinned.
    await waitFor(() => expect(list().querySelectorAll("[data-kobe-word]")).toHaveLength(1));

    await userEvent.setup().click(must(pill()));
    await waitFor(() => expect(list().dataset.kobeFollow).toBe("pinned"));
  });
});
