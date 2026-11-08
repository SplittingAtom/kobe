// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true},"width":1280,"height":800}
import { createRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppFrame,
  INLINE_HEIGHT,
  INLINE_MAX_HEIGHT,
  RAIL_SETTLE_MS,
  type AppFrameHandle,
} from "./app-frame";

/** KOBE-437: the app frame's isolation attributes, host header, sizing and host notifications. */
const APP = {
  appId: "a".repeat(64),
  connectorName: "Catalyst",
  title: "Lakehouse Explorer",
  sha256: "b".repeat(64),
};
const TEAM = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(props: Partial<Parameters<typeof AppFrame>[0]> = {}) {
  const fetchFn = vi.fn(
    async () =>
      new Response(JSON.stringify({ result: { content: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const view = render(
    <AppFrame
      app={APP}
      teamId={TEAM}
      cardKey="call-1"
      placement="inline"
      fetchFn={fetchFn}
      {...props}
    />,
  );
  const iframe = screen.getByTitle("Lakehouse Explorer (app from Catalyst)") as HTMLIFrameElement;
  const child = stubWindow(iframe);
  const fromApp = (data: unknown, source: Window = child) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, source, origin: "null" }));
    });
  const posted = () =>
    (child.postMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as unknown);
  return { iframe, child, fromApp, posted, fetchFn, view };
}

function stubWindow(iframe: HTMLIFrameElement): Window {
  const child = { postMessage: vi.fn() } as unknown as Window;
  Object.defineProperty(iframe, "contentWindow", { value: child, configurable: true });
  return child;
}

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

describe("AppFrame (KOBE-437)", () => {
  it("loads Kobe's member frame route in an opaque-origin sandbox with no permissions", () => {
    const { iframe } = mount();
    expect(iframe.getAttribute("src")).toBe(
      `/v1/team/apps/${APP.appId}/frame?team=${TEAM}&sha256=${APP.sha256}`,
    );
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("srcdoc")).toBeNull();
    expect(iframe.getAttribute("allow")).toBeNull();
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    // No host header line (Chris 2026-11-06, T9 amended): the region's name still says what it is.
    expect(screen.queryByText(/App from/)).toBeNull();
    expect(screen.queryByRole("banner")).toBeNull();
    expect(
      screen.getByRole("region", { name: "Lakehouse Explorer, an app from Catalyst" }),
    ).toBeTruthy();
  });

  it("starts at 360 px inline and grows to at most 720 px", async () => {
    const { iframe, fromApp } = mount();
    expect(iframe.style.height).toBe(`${INLINE_HEIGHT}px`);
    await fromApp({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: 500 },
    });
    expect(iframe.style.height).toBe("500px");
    await fromApp({
      jsonrpc: "2.0",
      method: "ui/notifications/size-changed",
      params: { height: 9000 },
    });
    expect(iframe.style.height).toBe(`${INLINE_MAX_HEIGHT}px`);
  });

  it("is display block, so no baseline gap under it in any placement (KOBE-575)", () => {
    for (const placement of ["inline", "expanded", "rail"] as const) {
      const { iframe } = mount({ placement });
      expect(iframe.classList).toContain("block");
      cleanup();
    }
  });

  it("sends the tool input and result once the app has initialized", async () => {
    const { fromApp, posted } = mount({
      toolInput: { table: "t" },
      toolResult: { content: [{ type: "text", text: "rows" }] },
    });
    expect(posted()).toEqual([]);
    await fromApp({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    expect(posted()).toEqual([
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-input",
        params: { arguments: { table: "t" } },
      },
      {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { content: [{ type: "text", text: "rows" }] },
      },
    ]);
  });

  it("routes the app's tools/call to the MA-4 endpoint only, and answers the frame", async () => {
    const { fromApp, posted, fetchFn } = mount();
    await fromApp({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "preview_table", arguments: { table: "t" } },
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect((fetchFn.mock.calls[0] as unknown[])[0]).toBe(`/v1/team/apps/${APP.appId}/calls`);
    expect(posted()).toContainEqual({ jsonrpc: "2.0", id: 7, result: { content: [] } });
  });

  it("reports each call's answer with the thread it was sent for, even after a switch (KOBE-460 LOW-3)", async () => {
    const A = "22222222-2222-4222-8222-222222222222";
    const B = "33333333-3333-4333-8333-333333333333";
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fetchFn = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ error: { code: "connector_off", message: "off" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    });
    const onCall = vi.fn();
    const { fromApp, view } = mount({ fetchFn, threadId: A, onCall });
    await fromApp({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "preview_table", arguments: {} },
    });
    await settle();
    const body = JSON.parse(
      String((fetchFn.mock.calls[0] as unknown[] as [string, RequestInit])[1].body),
    );
    expect(body).toMatchObject({ thread_id: A });
    view.rerender(
      <AppFrame
        app={APP}
        teamId={TEAM}
        cardKey="call-1"
        placement="inline"
        fetchFn={fetchFn}
        threadId={B}
        onCall={onCall}
      />,
    );
    release();
    await settle();
    await settle();
    expect(onCall).toHaveBeenCalledTimes(1);
    expect(onCall.mock.calls[0]?.[1]).toBe(A);
  });

  it("refuses ui/message without a composer, and stops answering once unmounted", async () => {
    const { fromApp, posted } = mount();
    await fromApp({
      jsonrpc: "2.0",
      id: 1,
      method: "ui/message",
      params: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(posted()).toContainEqual({ jsonrpc: "2.0", id: 1, result: { isError: true } });
    cleanup();
    const before = posted().length;
    await fromApp({ jsonrpc: "2.0", id: 2, method: "ui/initialize", params: {} });
    expect(posted()).toHaveLength(before);
  });

  it("gives each app, team, template and card a fresh frame; the old one gets nothing (review MEDIUM-1)", async () => {
    let finish: (r: Response) => void = () => undefined;
    const fetchFn = vi.fn(() => new Promise<Response>((resolve) => (finish = resolve)));
    const { iframe, child, fromApp, view } = mount({
      fetchFn,
      toolInput: { secret: "A" },
    });
    // App A asks for a call, then the card is reused for app B before the answer arrives.
    await fromApp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "t" } });
    const other = { ...APP, appId: "c".repeat(64) };
    view.rerender(
      <AppFrame
        app={other}
        teamId={TEAM}
        cardKey="call-2"
        placement="inline"
        fetchFn={fetchFn}
        toolInput={{ secret: "B" }}
      />,
    );
    const fresh = screen.getByTitle("Lakehouse Explorer (app from Catalyst)") as HTMLIFrameElement;
    expect(fresh).not.toBe(iframe);
    const freshChild = stubWindow(fresh);
    finish(new Response(JSON.stringify({ result: { rows: "A" } }), { status: 200 }));
    await settle();
    // The old document's messages are ignored, and it is sent nothing (not B's input either).
    await fromApp({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, child);
    await fromApp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "t" } }, child);
    await settle();
    // The old document is only told to tear down (review LOW-3), never sent B's data.
    expect(
      (child.postMessage as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => (c[0] as { method?: string }).method,
      ),
    ).toEqual(["ui/resource-teardown"]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // The new document gets its own card's input.
    await fromApp(
      { jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} },
      freshChild,
    );
    expect((freshChild.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { secret: "B" } },
    });
    // The same app in another card also gets a fresh frame.
    view.rerender(
      <AppFrame app={other} teamId={TEAM} cardKey="call-3" placement="inline" fetchFn={fetchFn} />,
    );
    expect(screen.getByTitle("Lakehouse Explorer (app from Catalyst)")).not.toBe(fresh);
  });

  it("lets its owner send ui/resource-teardown before removing it (review LOW-4)", async () => {
    const handle = createRef<AppFrameHandle>();
    const { child, fromApp, posted } = mount({ ref: handle });
    const done = handle.current?.teardown(1_000);
    const request = posted().find(
      (m) => (m as { method?: string }).method === "ui/resource-teardown",
    ) as { id: string };
    expect(request).toBeTruthy();
    await fromApp({ jsonrpc: "2.0", id: request.id, result: {} }, child);
    await expect(done).resolves.toBe(true);
  });

  it("tells the app to tear down whenever its frame is removed (review LOW-3)", () => {
    const { posted } = mount();
    cleanup();
    expect(posted()).toContainEqual({
      jsonrpc: "2.0",
      id: expect.any(String),
      method: "ui/resource-teardown",
      params: {},
    });
  });
});

describe("AppFrame in the rail (KOBE-575)", () => {
  /** One fake ResizeObserver per wrapper: `resize()` runs its callback as the browser would. */
  const observers: { target: Element | null; run: () => void }[] = [];
  class FakeResizeObserver {
    private readonly entry: { target: Element | null; run: () => void };
    constructor(callback: ResizeObserverCallback) {
      this.entry = { target: null, run: () => callback([], this as unknown as ResizeObserver) };
      observers.push(this.entry);
    }
    observe(target: Element) {
      this.entry.target = target;
    }
    unobserve() {}
    disconnect() {
      this.entry.target = null;
    }
  }

  afterEach(() => {
    observers.length = 0;
    vi.unstubAllGlobals();
  });

  const size = (height: number) => ({
    jsonrpc: "2.0",
    method: "ui/notifications/size-changed",
    params: { height },
  });

  /** A rail frame whose scrolling section is `clientHeight` px tall; `resize` changes it. */
  function mountRail(clientHeight: number) {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const mounted = mount({ placement: "rail" });
    const wrapper = mounted.iframe.parentElement as HTMLElement;
    expect(wrapper.hasAttribute("data-kobe-app-scroll")).toBe(true);
    let height = clientHeight;
    Object.defineProperty(wrapper, "clientHeight", { get: () => height, configurable: true });
    const resize = (next: number) =>
      act(() => {
        height = next;
        for (const o of observers) if (o.target === wrapper) o.run();
      });
    return { ...mounted, resize };
  }

  it("fills its section, and a report that fits (rounded up by the SDK) keeps it there", async () => {
    const { iframe, fromApp } = mountRail(656);
    expect(iframe.style.height).toBe("100%");
    await fromApp(size(656));
    expect(iframe.style.height).toBe("100%");
    await fromApp(size(657));
    expect(iframe.style.height).toBe("100%");
  });

  it("grows past its section when the app's content is taller, so the section scrolls", async () => {
    const { iframe, fromApp } = mountRail(656);
    await fromApp(size(658));
    expect(iframe.style.height).toBe("658px");
    await fromApp(size(1200));
    expect(iframe.style.height).toBe("1200px");
    // Content that fits again goes back to filling the section.
    await fromApp(size(400));
    expect(iframe.style.height).toBe("100%");
  });

  it("follows the section when it shrinks: a viewport-sized app re-reports and keeps filling it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { iframe, fromApp, resize } = mountRail(856);
      await fromApp(size(1000));
      expect(iframe.style.height).toBe("1000px");
      await resize(456);
      expect(iframe.style.height).toBe("100%");
      // A picker sized by its viewport (100vh) reports the section's height before the tick.
      await fromApp(size(456));
      act(() => vi.advanceTimersByTime(RAIL_SETTLE_MS));
      expect(iframe.style.height).toBe("100%");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a content-sized app's taller height after a section resize that sends no report", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { iframe, fromApp, resize } = mountRail(656);
      await fromApp(size(1200));
      expect(iframe.style.height).toBe("1200px");
      await resize(456);
      expect(iframe.style.height).toBe("100%");
      act(() => vi.advanceTimersByTime(RAIL_SETTLE_MS));
      expect(iframe.style.height).toBe("1200px");
      // A section taller than the content: the frame fills it.
      await resize(1300);
      act(() => vi.advanceTimersByTime(RAIL_SETTLE_MS));
      expect(iframe.style.height).toBe("100%");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a report while the section has no layout does not pin the frame; it applies once laid out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { iframe, fromApp, resize } = mountRail(0);
      await fromApp(size(600));
      expect(iframe.style.height).toBe("100%");
      await resize(400);
      act(() => vi.advanceTimersByTime(RAIL_SETTLE_MS));
      expect(iframe.style.height).toBe("600px");
    } finally {
      vi.useRealTimers();
    }
  });
});
