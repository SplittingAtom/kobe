// @vitest-environment happy-dom
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeKobe } from "../../lib/chat/testing/fake-kobe";
import { must } from "../../lib/testing/must";
import { composer, openApp, streaming, threadGroup } from "./testing";

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

/**
 * Content shrinks by `px` (at a run's end the "Working…" line goes and the steering panel folds,
 * which grows the list's box): like a browser, a position past the new bottom is clamped to it.
 */
function shrink(px: number) {
  content -= px;
  if (list().scrollTop > maxTop()) {
    list().scrollTop = maxTop();
    list().dispatchEvent(new Event("scroll"));
  }
  for (const run of observers) run();
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

describe("a scroll up in the last frames of a stream (KOBE-288)", () => {
  it("a message queued during a run re-pins once, not again when its run starts later", async () => {
    const t = threadWithHistory("Sales");
    await openAtBottom(t, "Sales");
    const runId = await startRun(t, "draw a chart");
    act(() => kobe.agent.delta(runId, "m1", "Here is the chart"));
    grow(300);
    // Sent while the run holds the thread: it queues (the panel shows it, the list doesn't).
    await send("and a table");
    await waitFor(() => expect(document.querySelectorAll("li[data-queued]")).toHaveLength(1));
    await waitFor(() => expect(list().scrollTop).toBe(maxTop()));
    scrollTo(200);
    await waitFor(() => expect(list().dataset.kobeFollow).toBe("unpinned"));

    // The run ends and the queued one starts: its prompt joins the list (the message count
    // changes for the first time since the send).
    act(() => {
      kobe.agent.commitPrompt(runId);
      kobe.agent.commit(runId, { role: "assistant", content: [{ type: "text", text: "Done" }] });
      kobe.agent.complete(runId);
    });
    expect(await screen.findByText("and a table")).toBeTruthy();
    await waitFor(() => expect(document.querySelectorAll("li[data-queued]")).toHaveLength(0));
    expect(list().dataset.kobeFollow).toBe("unpinned");
    expect(list().scrollTop).toBe(200);
  });

  it("a send that fails before it renders re-pins nothing later (a Retry starting)", async () => {
    const t = threadWithHistory("Sales");
    // An upload that never finishes holds the send back (it fails with "Wait for the files…").
    openApp(kobe, t, () => new Promise(() => {}));
    expect(await screen.findByText("Sales answer")).toBeTruthy();
    await waitFor(() => expect(list().scrollTop).toBe(maxTop()));
    const runId = await startRun(t, "draw a chart");
    act(() => kobe.agent.loseSandbox(runId));
    const retry = await screen.findByRole("button", { name: "Retry from last entry" });

    // Not running, so the send waits for its message to render; it never does.
    const user = userEvent.setup();
    await user.upload(await screen.findByLabelText("Choose files to attach"), [
      new File(["abc"], "notes.txt", { type: "text/plain" }),
    ]);
    await send("with the file");
    expect((await screen.findAllByText(/Wait for the files to finish/)).length).toBeGreaterThan(0);

    scrollTo(200);
    await waitFor(() => expect(list().dataset.kobeFollow).toBe("unpinned"));
    // Retry is not a send: its run's prompt joins the list without asking for the bottom.
    await user.click(retry);
    await waitFor(() => expect(kobe.latestRun(t).retry_of_run_id).toBe(runId));
    await streaming(kobe, kobe.latestRun(t).run_id);
    act(() => kobe.agent.delta(kobe.latestRun(t).run_id, "m1", "Second attempt"));
    await waitFor(() => expect(list().textContent).toContain("Second attempt"));
    expect(list().dataset.kobeFollow).toBe("unpinned");
    expect(list().scrollTop).toBe(200);
  });

  it("still unpins when the run's end shrinks the list onto the member's position", async () => {
    const t = threadWithHistory("Sales");
    await openAtBottom(t, "Sales");
    const runId = await startRun(t, "draw a chart");
    act(() => kobe.agent.delta(runId, "m1", "Here is the chart"));
    grow(300);
    await waitFor(() => expect(list().scrollTop).toBe(maxTop()));

    scrollTo(maxTop() - 30);
    await waitFor(() => expect(list().dataset.kobeFollow).toBe("unpinned"));
    act(() => {
      kobe.agent.commit(runId, { role: "assistant", content: [{ type: "text", text: "Done" }] });
      kobe.agent.complete(runId);
      shrink(60);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeTruthy());
    expect(list().dataset.kobeFollow).toBe("unpinned");
    expect(pill()).toBeTruthy();
    const held = list().scrollTop;
    grow(400);
    expect(list().scrollTop).toBe(held);
  });

  it("still unpins when new content lands in the same frame, before the list re-renders", async () => {
    const t = threadWithHistory("Sales");
    await openAtBottom(t, "Sales");
    const runId = await startRun(t, "draw a chart");
    act(() => kobe.agent.delta(runId, "m1", "Here is the chart"));
    grow(300);
    await waitFor(() => expect(list().scrollTop).toBe(maxTop()));

    // One frame: the last words grow the list, the member's wheel turn scrolls it up, then the
    // resize observer runs. React has not re-rendered in between (one act), so assistant-ui still
    // follows and scrolls to the bottom once more; that scroll is not the member's.
    act(() => {
      content += 80;
      list().dispatchEvent(new WheelEvent("wheel", { deltaY: -120 }));
      list().scrollTop = list().scrollTop - 120;
      list().dispatchEvent(new Event("scroll"));
      for (const run of observers) run();
    });
    act(() => kobe.agent.complete(runId));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeTruthy());
    expect(list().dataset.kobeFollow).toBe("unpinned");
    expect(pill()).toBeTruthy();
    const held = list().scrollTop;
    grow(400);
    expect(list().scrollTop).toBe(held);
  });

  it("re-pins when the member scrolls down to the bottom while the list grows", async () => {
    const t = threadWithHistory("Sales");
    await openAtBottom(t, "Sales");
    const runId = await startRun(t, "draw a chart");
    scrollTo(200);
    await waitFor(() => expect(list().dataset.kobeFollow).toBe("unpinned"));
    act(() => kobe.agent.delta(runId, "m1", "Here is the chart"));
    grow(300);
    expect(list().scrollTop).toBe(200);

    act(() => {
      content += 50; // still growing as the member reaches the bottom
      list().dispatchEvent(new WheelEvent("wheel", { deltaY: maxTop() - 200 }));
      list().scrollTop = maxTop();
      list().dispatchEvent(new Event("scroll"));
    });
    await waitFor(() => expect(list().dataset.kobeFollow).toBe("pinned"));
    grow(200);
    await waitFor(() => expect(list().scrollTop).toBe(maxTop()));
  });
});

describe("scroll position per thread (ac-2)", () => {
  const titles = async () => within(await threadGroup("Your threads"));

  it("a thread opens at the bottom, and reopening one restores where it was left", async () => {
    const a = threadWithHistory("Alpha");
    threadWithHistory("Beta");
    await openAtBottom(a, "Alpha");
    scrollTo(300);
    await waitFor(() => expect(sessionStorage.getItem(`kobe.scroll:${a}`)).toBe("300"));

    const user = userEvent.setup();
    await user.click((await titles()).getByRole("button", { name: "Beta" }));
    expect(await screen.findByText("Beta answer")).toBeTruthy();
    await waitFor(() => expect(list().scrollTop).toBe(maxTop()));

    await user.click((await titles()).getByRole("button", { name: "Alpha" }));
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

    await userEvent.setup().click((await titles()).getByRole("button", { name: "Beta" }));
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

    await userEvent.setup().click((await titles()).getByRole("button", { name: "Beta" }));
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
