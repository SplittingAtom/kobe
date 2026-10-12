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

/** The member scrolls the message list (wheel gesture, then the scroll it causes). */
function scrollTo(top: number) {
  act(() => {
    list().dispatchEvent(new Event("wheel"));
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

describe("following the stream (ac-5)", () => {
  it("keeps the newest content in view while pinned, also from within 48 px of the bottom", async () => {
    const t = threadWithHistory("Sales");
    await openAtBottom(t, "Sales");
    await send("draw a chart");
    const run = must(await waitFor(() => must(kobe.activeRun(t))));
    await streaming(kobe, run.run_id);

    act(() => kobe.agent.delta(run.run_id, "m1", "Here is "));
    grow(300);
    await waitFor(() => expect(list().scrollTop).toBe(maxTop()));

    // 30 px above the bottom still counts as at the bottom.
    scrollTo(maxTop() - 30);
    grow(200);
    await waitFor(() => expect(list().scrollTop).toBe(maxTop()));
    expect(pill()).toBeNull();
  });
});

describe("Jump to latest (ac-1)", () => {
  it("scrolling up during a stream holds the view and counts new messages; the pill re-pins", async () => {
    const t = threadWithHistory("Sales");
    await openAtBottom(t, "Sales");
    expect(pill()).toBeNull();
    await send("draw a chart");
    const run = must(await waitFor(() => must(kobe.activeRun(t))));
    await streaming(kobe, run.run_id);

    scrollTo(200);
    expect(await screen.findByRole("button", { name: "Jump to latest" })).toBeTruthy();

    act(() => kobe.agent.delta(run.run_id, "m1", "Here is the chart"));
    expect(await screen.findByText("Here is the chart")).toBeTruthy();
    grow(600);
    expect(list().scrollTop).toBe(200);
    const jump = await screen.findByRole("button", { name: "Jump to latest, 1 new message" });
    expect(within(jump).getByText("1")).toBeTruthy();

    await userEvent.setup().click(jump);
    await waitFor(() => expect(list().scrollTop).toBe(maxTop()));
    await waitFor(() => expect(pill()).toBeNull());
  });

  it("sending re-pins", async () => {
    const t = threadWithHistory("Sales");
    await openAtBottom(t, "Sales");
    scrollTo(100);
    expect(await screen.findByRole("button", { name: "Jump to latest" })).toBeTruthy();

    await send("one more thing");
    await waitFor(() => expect(list().scrollTop).toBe(maxTop()));
    await waitFor(() => expect(pill()).toBeNull());
  });
});

describe("scroll position per thread (ac-2)", () => {
  it("a thread opens at the bottom, and reopening one restores where it was left", async () => {
    const a = threadWithHistory("Alpha");
    threadWithHistory("Beta");
    await openAtBottom(a, "Alpha");
    scrollTo(300);
    expect(sessionStorage.getItem(`kobe.scroll:${a}`)).toBe("300");

    const user = userEvent.setup();
    const threads = within(await screen.findByRole("list", { name: "Your conversations" }));
    await user.click(threads.getByRole("button", { name: "Beta" }));
    expect(await screen.findByText("Beta answer")).toBeTruthy();
    await waitFor(() => expect(list().scrollTop).toBe(maxTop()));

    await user.click(threads.getByRole("button", { name: "Alpha" }));
    expect(await screen.findByText("Alpha answer")).toBeTruthy();
    await waitFor(() => expect(list().scrollTop).toBe(300));
    expect(await screen.findByRole("button", { name: "Jump to latest" })).toBeTruthy();
  });

  it("a thread left at the bottom reopens at the bottom", async () => {
    const a = threadWithHistory("Alpha");
    await openAtBottom(a, "Alpha");
    scrollTo(maxTop() - 10);
    expect(sessionStorage.getItem(`kobe.scroll:${a}`)).toBe("bottom");
  });
});
