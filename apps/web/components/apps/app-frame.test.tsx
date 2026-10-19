// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true},"width":1280,"height":800}
import { createRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppFrame, INLINE_HEIGHT, INLINE_MAX_HEIGHT, type AppFrameHandle } from "./app-frame";

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
    // The host header sits outside the frame (spec T9).
    expect(screen.getByText("App from Catalyst")).toBeTruthy();
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
