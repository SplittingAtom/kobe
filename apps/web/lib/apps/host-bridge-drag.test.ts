// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_LIMITS,
  attachHostBridge,
  type BridgeDragEvent,
  type HostBridgeHandlers,
} from "./host-bridge";

/**
 * KOBE-553 ac-1: the bridge-mediated pointer drag (DRAG-CONTRACT.md). The four
 * `kobe/notifications/drag-*` notifications are taken only from the bound frame with the opaque
 * origin, their params parsed with zod (item a plain object of at most 8 KiB, x and y finite);
 * anything else is dropped, and a move, end or cancel without a live start is ignored.
 */
const ITEM = {
  kind: "table",
  catalog: "mlb",
  namespace: "lahman",
  name: "batting",
  identifier: "mlb.lahman.batting",
  uri: "catalyst://lakehouse/mlb/lahman/batting",
};
const START = "kobe/notifications/drag-start";
const MOVE = "kobe/notifications/drag-move";
const END = "kobe/notifications/drag-end";
const CANCEL = "kobe/notifications/drag-cancel";
const note = (method: string, params?: unknown) => ({
  jsonrpc: "2.0",
  method,
  ...(params === undefined ? {} : { params }),
});

let detach: (() => void) | undefined;
afterEach(() => {
  detach?.();
  detach = undefined;
});

function setup(withDrag = true) {
  const frame = { postMessage: vi.fn() } as unknown as Window;
  const events: BridgeDragEvent[] = [];
  const handlers: HostBridgeHandlers = {
    callTool: vi.fn(async () => ({ ok: true as const, result: {} })),
    listTools: vi.fn(async () => ({ ok: true as const, tools: [] })),
    message: vi.fn(() => true),
    updateModelContext: vi.fn(() => true),
    requestDisplayMode: vi.fn((mode: "inline" | "fullscreen") => mode),
    sizeChanged: vi.fn(),
    initialized: vi.fn(),
    ...(withDrag ? { drag: (event: BridgeDragEvent) => events.push(event) } : {}),
  };
  let now = 1_000;
  const bridge = attachHostBridge(window, {
    frame: () => frame,
    handlers,
    hostContext: () => ({}),
    now: () => now,
  });
  detach = () => bridge.detach();
  const send = (data: unknown, opts: { source?: unknown; origin?: string } = {}) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data,
        source: ("source" in opts ? opts.source : frame) as Window,
        origin: opts.origin ?? "null",
      }),
    );
  return { frame, events, bridge, send, tick: (ms: number) => (now += ms) };
}

describe("pointer drags from an app frame (KOBE-553 ac-1)", () => {
  it("forwards start, moves and end from the bound frame, frame-relative", () => {
    const t = setup();
    t.send(note(START, { item: ITEM, x: 10, y: 20 }));
    t.send(note(MOVE, { x: -40.5, y: 900 }));
    t.send(note(END, { x: 353, y: 203 }));
    expect(t.events).toEqual([
      { phase: "start", item: ITEM, x: 10, y: 20 },
      { phase: "move", x: -40.5, y: 900 },
      { phase: "end", x: 353, y: 203 },
    ]);
    // Notifications: the app is never answered.
    expect(t.frame.postMessage).not.toHaveBeenCalled();
  });

  it("forwards a cancel, with or without empty params", () => {
    const t = setup();
    t.send(note(START, { item: ITEM, x: 1, y: 1 }));
    t.send(note(CANCEL, {}));
    t.send(note(START, { item: ITEM, x: 1, y: 1 }));
    t.send(note(CANCEL));
    expect(t.events.map((e) => e.phase)).toEqual(["start", "cancel", "start", "cancel"]);
  });

  it("ignores another window, another origin and a request with the same method", () => {
    const t = setup();
    const other = { postMessage: vi.fn() } as unknown as Window;
    t.send(note(START, { item: ITEM, x: 1, y: 1 }), { source: other });
    t.send(note(START, { item: ITEM, x: 1, y: 1 }), { source: null });
    t.send(note(START, { item: ITEM, x: 1, y: 1 }), { origin: "https://evil.example" });
    t.send({ ...note(START, { item: ITEM, x: 1, y: 1 }), id: 4 });
    expect(t.events).toEqual([]);
  });

  it.each([
    ["no item", { x: 1, y: 1 }],
    ["an array item", { item: [ITEM], x: 1, y: 1 }],
    ["a string item", { item: "mlb.lahman.batting", x: 1, y: 1 }],
    ["a null item", { item: null, x: 1, y: 1 }],
    ["an oversized item", { item: { ...ITEM, pad: "a".repeat(9 * 1024) }, x: 1, y: 1 }],
    ["a string coordinate", { item: ITEM, x: "1", y: 1 }],
    ["a missing coordinate", { item: ITEM, x: 1 }],
    ["no params", undefined],
  ])("drops a start with %s", (_label, params) => {
    const t = setup();
    t.send(note(START, params));
    t.send(note(END, { x: 1, y: 1 }));
    expect(t.events).toEqual([]);
  });

  it("drops non-finite or malformed moves and ends; the drag stays live", () => {
    const t = setup();
    t.send(note(START, { item: ITEM, x: 1, y: 1 }));
    // JSON cannot carry Infinity or NaN, but a structured clone can.
    t.send(note(MOVE, { x: Number.POSITIVE_INFINITY, y: 1 }));
    t.send(note(MOVE, { x: Number.NaN, y: 1 }));
    t.send(note(MOVE, { x: 1 }));
    t.send(note(END, { x: "2", y: 2 }));
    t.send(note(CANCEL, "now"));
    t.send(note(END, { x: 2, y: 2 }));
    expect(t.events).toEqual([
      { phase: "start", item: ITEM, x: 1, y: 1 },
      { phase: "end", x: 2, y: 2 },
    ]);
  });

  it("ignores a move, end or cancel without a live start", () => {
    const t = setup();
    t.send(note(MOVE, { x: 1, y: 1 }));
    t.send(note(END, { x: 1, y: 1 }));
    t.send(note(CANCEL, {}));
    t.send(note(START, { item: ITEM, x: 1, y: 1 }));
    t.send(note(END, { x: 2, y: 2 }));
    // Over: the next end is not part of any drag.
    t.send(note(END, { x: 3, y: 3 }));
    t.send(note(MOVE, { x: 3, y: 3 }));
    expect(t.events.map((e) => e.phase)).toEqual(["start", "end"]);
  });

  it("a second start replaces the live one", () => {
    const t = setup();
    const other = { ...ITEM, name: "pitching", identifier: "mlb.lahman.pitching" };
    t.send(note(START, { item: ITEM, x: 1, y: 1 }));
    t.send(note(START, { item: other, x: 5, y: 5 }));
    t.send(note(END, { x: 6, y: 6 }));
    expect(t.events).toEqual([
      { phase: "start", item: ITEM, x: 1, y: 1 },
      { phase: "start", item: other, x: 5, y: 5 },
      { phase: "end", x: 6, y: 6 },
    ]);
  });

  it("cancels a live drag when the bridge detaches (the frame went away)", () => {
    const t = setup();
    t.send(note(START, { item: ITEM, x: 1, y: 1 }));
    t.bridge.detach();
    t.send(note(END, { x: 2, y: 2 }));
    expect(t.events.map((e) => e.phase)).toEqual(["start", "cancel"]);
  });

  it("detaching without a live drag says nothing", () => {
    const t = setup();
    t.bridge.detach();
    expect(t.events).toEqual([]);
  });

  it("counts drag notifications in the per-frame message budget", () => {
    const t = setup();
    t.send(note(START, { item: ITEM, x: 0, y: 0 }));
    for (let i = 1; i < BRIDGE_LIMITS.messagesPerSecond + 10; i++) {
      t.send(note(MOVE, { x: i, y: i }));
    }
    expect(t.events).toHaveLength(BRIDGE_LIMITS.messagesPerSecond);
    t.tick(1_001);
    t.send(note(END, { x: 1, y: 1 }));
    expect(t.events.at(-1)).toEqual({ phase: "end", x: 1, y: 1 });
  });

  it("a host without a drag handler drops them", () => {
    const t = setup(false);
    t.send(note(START, { item: ITEM, x: 1, y: 1 }));
    expect(t.events).toEqual([]);
  });

  it("drops other kobe/ notifications", () => {
    const t = setup();
    t.send(note("kobe/notifications/drag-drop", { item: ITEM, x: 1, y: 1 }));
    t.send(note("kobe/notifications/drag-startx", { item: ITEM, x: 1, y: 1 }));
    expect(t.events).toEqual([]);
  });
});
