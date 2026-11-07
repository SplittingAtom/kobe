// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true},"width":1280,"height":800}
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeDragEvent } from "../../lib/apps/host-bridge";
import { AppFrame } from "./app-frame";

/**
 * KOBE-553 ac-2: AppFrame turns the app's frame-relative drag points into page points with the
 * iframe's bounding rect, read again on every notification (the frame can move or scroll
 * between them), and hands each phase to `onDrag`.
 */
const APP = {
  appId: "a".repeat(64),
  connectorName: "Catalyst",
  title: "Lakehouse Picker",
  sha256: "b".repeat(64),
};
const TEAM = "11111111-1111-4111-8111-111111111111";
const ITEM = { kind: "table", identifier: "mlb.lahman.batting" };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function rectAt(left: number, top: number): DOMRect {
  return {
    left,
    top,
    right: left + 300,
    bottom: top + 400,
    width: 300,
    height: 400,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}

function mount(placement: "inline" | "rail" | "expanded" = "rail") {
  const events: BridgeDragEvent[] = [];
  render(
    <AppFrame
      app={APP}
      teamId={TEAM}
      cardKey="rail-picker"
      placement={placement}
      fetchFn={vi.fn()}
      onDrag={(e) => events.push(e)}
    />,
  );
  const iframe = screen.getByTitle("Lakehouse Picker (app from Catalyst)") as HTMLIFrameElement;
  const child = { postMessage: vi.fn() } as unknown as Window;
  Object.defineProperty(iframe, "contentWindow", { value: child, configurable: true });
  let rect = rectAt(0, 0);
  vi.spyOn(iframe, "getBoundingClientRect").mockImplementation(() => rect);
  const fromApp = (method: string, params: unknown) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { jsonrpc: "2.0", method: `kobe/notifications/${method}`, params },
          source: child,
          origin: "null",
        }),
      );
    });
  return { events, fromApp, moveFrame: (l: number, t: number) => (rect = rectAt(l, t)) };
}

describe("AppFrame drag notifications (KOBE-553 ac-2)", () => {
  it("maps each point to the page with the frame's offset", () => {
    const t = mount();
    t.moveFrame(70, 50);
    t.fromApp("drag-start", { item: ITEM, x: 10, y: 12 });
    t.fromApp("drag-move", { x: -30, y: 500 });
    t.fromApp("drag-end", { x: 353, y: 203 });
    expect(t.events).toEqual([
      { phase: "start", item: ITEM, x: 80, y: 62 },
      { phase: "move", x: 40, y: 550 },
      { phase: "end", x: 423, y: 253 },
    ]);
  });

  it("reads the rect on every notification: a frame scrolled or moved mid-drag", () => {
    const t = mount();
    t.moveFrame(1000, 100);
    t.fromApp("drag-start", { item: ITEM, x: 5, y: 5 });
    // The rail scrolled the frame up by 140 px, partly out of view.
    t.moveFrame(1000, -40);
    t.fromApp("drag-move", { x: -500, y: 300 });
    t.moveFrame(980, -40);
    t.fromApp("drag-end", { x: -500, y: 300 });
    expect(t.events.map((e) => ("x" in e ? [e.x, e.y] : null))).toEqual([
      [1005, 105],
      [500, 260],
      [480, 260],
    ]);
  });

  it("passes a cancel on", () => {
    const t = mount("inline");
    t.fromApp("drag-start", { item: ITEM, x: 5, y: 5 });
    t.fromApp("drag-cancel", {});
    expect(t.events.map((e) => e.phase)).toEqual(["start", "cancel"]);
  });

  it.each(["inline", "expanded"] as const)("works the same in the %s placement", (placement) => {
    const t = mount(placement);
    t.moveFrame(200, 300);
    t.fromApp("drag-start", { item: ITEM, x: 1, y: 2 });
    expect(t.events).toEqual([{ phase: "start", item: ITEM, x: 201, y: 302 }]);
  });

  it("cancels a live drag when the frame is removed", () => {
    const t = mount();
    t.fromApp("drag-start", { item: ITEM, x: 1, y: 2 });
    cleanup();
    expect(t.events.map((e) => e.phase)).toEqual(["start", "cancel"]);
  });
});
