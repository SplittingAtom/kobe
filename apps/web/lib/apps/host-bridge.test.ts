// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_LIMITS,
  MESSAGE_TEXT_MAX,
  MODEL_CONTEXT_MAX,
  NOT_ALLOWED,
  attachHostBridge,
  type HostBridgeHandlers,
  type ToolCallAnswer,
} from "./host-bridge";

/**
 * KOBE-437 (MA-5): Kobe's own host bridge for MCP Apps (spec T4, §7): the source window and the
 * opaque origin are checked, every method is parsed with zod, the §7 table is followed, and each
 * frame is limited.
 */
type Posted = Record<string, unknown>;

function setup(overrides: Partial<HostBridgeHandlers> = {}) {
  const frame = { postMessage: vi.fn() } as unknown as Window;
  const handlers: HostBridgeHandlers = {
    callTool: vi.fn(async () => ({ ok: true as const, result: { content: [] } })),
    listTools: vi.fn(async () => ({ ok: true as const, tools: [{ name: "t" }] })),
    message: vi.fn(() => true),
    updateModelContext: vi.fn(() => true),
    requestDisplayMode: vi.fn((mode: "inline" | "fullscreen") => mode),
    sizeChanged: vi.fn(),
    initialized: vi.fn(),
    ...overrides,
  };
  let now = 1_000;
  const bridge = attachHostBridge(window, {
    frame: () => frame,
    handlers,
    hostContext: () => ({ theme: "light", displayMode: "inline" }),
    now: () => now,
  });
  const send = (data: unknown, opts: { source?: unknown; origin?: string } = {}) =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data,
        source: ("source" in opts ? opts.source : frame) as Window,
        origin: opts.origin ?? "null",
      }),
    );
  const replies = () =>
    (frame.postMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as Posted);
  const reply = (id: number) => replies().find((r) => r.id === id);
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    frame,
    handlers,
    bridge,
    send,
    replies,
    reply,
    flush,
    tick: (ms: number) => (now += ms),
  };
}

const rpc = (id: number, method: string, params: unknown = {}) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

let detach: (() => void) | undefined;
afterEach(() => {
  detach?.();
  detach = undefined;
  vi.restoreAllMocks();
});

describe("source and origin (spec T4, ac-2)", () => {
  it("ignores messages from any other window, a non-opaque origin, and junk", async () => {
    const t = setup();
    detach = t.bridge.detach;
    const other = { postMessage: vi.fn() } as unknown as Window;
    t.send(rpc(1, "tools/call", { name: "t" }), { source: other });
    t.send(rpc(2, "tools/call", { name: "t" }), { source: null });
    t.send(rpc(3, "tools/call", { name: "t" }), { origin: "https://kobe.example" });
    t.send(rpc(4, "tools/call", { name: "t" }), { source: window });
    await t.flush();
    expect(t.replies()).toEqual([]);
    expect(t.handlers.callTool).not.toHaveBeenCalled();
    expect(other.postMessage).not.toHaveBeenCalled();
  });

  it("answers malformed requests with a JSON-RPC error and drops notifications and junk", async () => {
    const t = setup();
    detach = t.bridge.detach;
    t.send("a string");
    t.send({ jsonrpc: "1.0", id: 1, method: "tools/call" });
    t.send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: "x" } });
    t.send(rpc(5, "tools/call", { name: 7 }));
    await t.flush();
    expect(t.replies()).toEqual([
      expect.objectContaining({ id: 5, error: expect.objectContaining({ code: -32602 }) }),
    ]);
    expect(t.handlers.sizeChanged).not.toHaveBeenCalled();
  });

  it("posts nothing after detach, not even a late answer (review MEDIUM-1)", async () => {
    let finish: (a: ToolCallAnswer) => void = () => undefined;
    const t = setup({
      callTool: vi.fn(() => new Promise<ToolCallAnswer>((resolve) => (finish = resolve))),
    });
    t.send(rpc(1, "tools/call", { name: "t" }));
    await t.flush();
    t.bridge.detach();
    finish({ ok: true, result: { secret: 1 } });
    await t.flush();
    t.bridge.notify("ui/notifications/tool-result", {});
    expect(t.replies()).toEqual([]);
  });

  it("stays bound to the first window; a different one later is neither heard nor answered", async () => {
    let window1 = { postMessage: vi.fn() } as unknown as Window;
    const window2 = { postMessage: vi.fn() } as unknown as Window;
    const base = setup();
    base.bridge.detach();
    const handlers = base.handlers;
    const bridge = attachHostBridge(window, {
      frame: () => window1,
      handlers,
      hostContext: () => ({}),
    });
    detach = bridge.detach;
    bridge.notify("ui/notifications/tool-input", { arguments: {} });
    expect(window1.postMessage).toHaveBeenCalledTimes(1);
    window1 = window2;
    window.dispatchEvent(
      new MessageEvent("message", {
        data: rpc(1, "ui/initialize"),
        source: window2,
        origin: "null",
      }),
    );
    bridge.notify("ui/notifications/tool-result", {});
    await new Promise((r) => setTimeout(r, 0));
    expect(window2.postMessage).not.toHaveBeenCalled();
  });

  it("stops listening once detached", async () => {
    const t = setup();
    t.bridge.detach();
    t.send(rpc(1, "ui/initialize"));
    await t.flush();
    expect(t.replies()).toEqual([]);
  });
});

describe("the §7 method table (ac-3)", () => {
  it("denies open-link, download-file, resources/*, sampling, elicitation and unknown methods", async () => {
    const t = setup();
    detach = t.bridge.detach;
    const denied = [
      "ui/open-link",
      "ui/download-file",
      "resources/read",
      "resources/list",
      "resources/templates/list",
      "sampling/createMessage",
      "elicitation/create",
      "prompts/list",
      "anything/else",
    ];
    denied.forEach((method, i) => t.send(rpc(i + 1, method, { url: "https://x", uri: "ui://x" })));
    await t.flush();
    expect(t.replies()).toHaveLength(denied.length);
    for (const r of t.replies()) {
      expect(r.error).toEqual({
        code: -32601,
        message: expect.any(String),
        data: { reason: NOT_ALLOWED },
      });
    }
    expect(t.handlers.callTool).not.toHaveBeenCalled();
  });

  it("answers ui/initialize without user or team identifiers, and no denied capability", async () => {
    const t = setup();
    detach = t.bridge.detach;
    t.send(rpc(1, "ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "a" } }));
    await t.flush();
    const result = t.reply(1)?.result as Record<string, Record<string, unknown>>;
    expect(result.hostInfo).toEqual({ name: "kobe", version: expect.any(String) });
    expect(result.hostCapabilities).toEqual({
      serverTools: {},
      logging: {},
      message: { text: {} },
      updateModelContext: { text: {}, structuredContent: {} },
    });
    expect(result.hostContext).toMatchObject({ theme: "light", displayMode: "inline" });
    expect(result.hostContext?.availableDisplayModes).toEqual(["inline", "fullscreen"]);
    expect(JSON.stringify(result)).not.toMatch(/user|team/i);
  });

  it("sends tools/call only to the handler (the MA-4 endpoint) and returns the result", async () => {
    const t = setup();
    detach = t.bridge.detach;
    t.send(rpc(1, "tools/call", { name: "preview_table", arguments: { table: "t" } }));
    t.send(rpc(2, "tools/list"));
    await t.flush();
    expect(t.handlers.callTool).toHaveBeenCalledWith("preview_table", { table: "t" });
    expect(t.reply(1)?.result).toEqual({ content: [] });
    expect(t.reply(2)?.result).toEqual({ tools: [{ name: "t" }] });
  });

  it("turns a refused call into a JSON-RPC error with Kobe's code", async () => {
    const t = setup({
      callTool: vi.fn(async () => ({
        ok: false as const,
        code: "tool_not_read_only",
        message: "Apps may call only read-only tools.",
      })),
    });
    detach = t.bridge.detach;
    t.send(rpc(1, "tools/call", { name: "drop_table", arguments: {} }));
    await t.flush();
    expect(t.reply(1)?.error).toEqual({
      code: -32000,
      message: "Apps may call only read-only tools.",
      data: { reason: "tool_not_read_only" },
    });
  });

  it("puts ui/message text into the composer (capped) and never anything else", async () => {
    const t = setup();
    detach = t.bridge.detach;
    t.send(
      rpc(1, "ui/message", {
        role: "user",
        content: [
          { type: "text", text: "Use table `c.n.t`" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
      }),
    );
    t.send(
      rpc(2, "ui/message", {
        role: "user",
        content: [{ type: "text", text: "x".repeat(MESSAGE_TEXT_MAX + 1) }],
      }),
    );
    t.send(rpc(3, "ui/message", { role: "assistant", content: [{ type: "text", text: "hi" }] }));
    // 4 KiB of UTF-8, not 4,096 UTF-16 units (review LOW-7).
    t.send(
      rpc(4, "ui/message", {
        role: "user",
        content: [{ type: "text", text: "\u00e9".repeat(2049) }],
      }),
    );
    await t.flush();
    expect(t.handlers.message).toHaveBeenCalledTimes(1);
    expect(t.handlers.message).toHaveBeenCalledWith({
      text: "Use table `c.n.t`",
      items: [],
      dropped: 0,
    });
    expect(t.reply(1)?.result).toEqual({});
    expect(t.reply(2)?.error).toMatchObject({ code: -32602 });
    expect(t.reply(3)?.error).toMatchObject({ code: -32602 });
    expect(t.reply(4)?.error).toMatchObject({ code: -32602 });
  });

  it("passes ui/message resource_links as items instead of the text (KOBE-490 ac-1, ac-4)", async () => {
    const t = setup();
    detach = t.bridge.detach;
    const orders = {
      type: "resource_link",
      uri: "catalyst://lakehouse/cat/ns/orders",
      name: "cat.ns.orders",
      _meta: { "io.kobe/item-kind": "table" },
    };
    t.send(
      rpc(1, "ui/message", {
        role: "user",
        content: [
          { type: "text", text: "`cat.ns.orders`" },
          orders,
          { ...orders, uri: "javascript:alert(1)" },
        ],
      }),
    );
    // Links that are all invalid: the text still goes in, as today.
    t.send(
      rpc(2, "ui/message", {
        role: "user",
        content: [
          { type: "text", text: "plain" },
          { ...orders, uri: "data:x" },
        ],
      }),
    );
    // Nothing usable: an error to the app, and the composer is told (a visible note).
    t.send(rpc(3, "ui/message", { role: "user", content: [{ ...orders, name: "" }] }));
    await t.flush();
    const calls = (t.handlers.message as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      {
        text: "",
        items: [
          {
            uri: "catalyst://lakehouse/cat/ns/orders",
            name: "cat.ns.orders",
            kind: "table",
          },
        ],
        dropped: 1,
      },
      { text: "plain", items: [], dropped: 1 },
      { text: "", items: [], dropped: 1 },
    ]);
    expect(t.reply(1)?.result).toEqual({});
    expect(t.reply(2)?.result).toEqual({});
    expect(t.reply(3)?.error).toMatchObject({ code: -32602 });
  });

  it("stores model context up to 8 KiB and refuses more", async () => {
    const t = setup();
    detach = t.bridge.detach;
    t.send(rpc(1, "ui/update-model-context", { structuredContent: { table: "c.n.t" } }));
    t.send(
      rpc(2, "ui/update-model-context", {
        structuredContent: { big: "x".repeat(MODEL_CONTEXT_MAX) },
      }),
    );
    await t.flush();
    expect(t.handlers.updateModelContext).toHaveBeenCalledWith({
      structuredContent: { table: "c.n.t" },
    });
    expect(t.reply(1)?.result).toEqual({});
    expect(t.reply(2)?.error).toMatchObject({ code: -32602 });
  });

  it("allows inline and fullscreen display modes and refuses pip", async () => {
    const t = setup();
    detach = t.bridge.detach;
    t.send(rpc(1, "ui/request-display-mode", { mode: "fullscreen" }));
    t.send(rpc(2, "ui/request-display-mode", { mode: "pip" }));
    await t.flush();
    expect(t.reply(1)?.result).toEqual({ mode: "fullscreen" });
    expect(t.reply(2)?.error).toMatchObject({ code: -32602 });
  });

  it("honours size-changed, drops logging, and reports initialized", async () => {
    const t = setup();
    detach = t.bridge.detach;
    t.send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 500 } });
    t.send({
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: "info", data: "x" },
    });
    t.send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    await t.flush();
    expect(t.handlers.sizeChanged).toHaveBeenCalledWith({ height: 500 });
    expect(t.handlers.initialized).toHaveBeenCalledTimes(1);
    expect(t.bridge.droppedLogs()).toBe(1);
    expect(t.replies()).toEqual([]);
  });

  it("sends host notifications and the teardown request to the frame only", async () => {
    const t = setup();
    detach = t.bridge.detach;
    t.bridge.notify("ui/notifications/tool-input", { arguments: {} });
    const done = t.bridge.teardown(50);
    const [, teardown] = t.replies();
    expect(teardown).toMatchObject({ jsonrpc: "2.0", method: "ui/resource-teardown", params: {} });
    t.send({ jsonrpc: "2.0", id: teardown?.id, result: {} });
    await expect(done).resolves.toBe(true);
    expect(t.replies()[0]).toEqual({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: {} },
    });
    // A frame that never answers is torn down anyway.
    await expect(t.bridge.teardown(10)).resolves.toBe(false);
  });
});

describe("per-frame limits (spec T4)", () => {
  it("refuses a message over 64 KiB", async () => {
    const t = setup();
    detach = t.bridge.detach;
    t.send(
      rpc(1, "tools/call", { name: "t", arguments: { x: "y".repeat(BRIDGE_LIMITS.messageBytes) } }),
    );
    await t.flush();
    expect(t.handlers.callTool).not.toHaveBeenCalled();
    expect(t.reply(1)?.error).toMatchObject({ code: -32600, data: { reason: "too_large" } });
  });

  it("allows 10 requests per second", async () => {
    const t = setup();
    detach = t.bridge.detach;
    for (let i = 1; i <= 12; i++) t.send(rpc(i, "ui/request-display-mode", { mode: "inline" }));
    await t.flush();
    expect(t.replies().filter((r) => r.result)).toHaveLength(BRIDGE_LIMITS.requestsPerSecond);
    expect(t.reply(11)?.error).toMatchObject({ code: -32000, data: { reason: "rate_limited" } });
    t.tick(1_001);
    t.send(rpc(13, "ui/request-display-mode", { mode: "inline" }));
    await t.flush();
    expect(t.reply(13)?.result).toEqual({ mode: "inline" });
  });

  it("runs calls one at a time and admits at most 4 (review LOW-3)", async () => {
    const pending: (() => void)[] = [];
    const t = setup({
      callTool: vi.fn(
        () =>
          new Promise<ToolCallAnswer>((resolve) => {
            pending.push(() => resolve({ ok: true as const, result: {} }));
          }),
      ),
    });
    detach = t.bridge.detach;
    for (let i = 1; i <= 5; i++) t.send(rpc(i, "tools/call", { name: "t" }));
    await t.flush();
    expect(t.handlers.callTool).toHaveBeenCalledTimes(1);
    expect(t.reply(5)?.error).toMatchObject({ data: { reason: "too_many_calls" } });
    for (let done = 1; done <= 4; done++) {
      pending.shift()?.();
      await t.flush();
      expect(t.reply(done)?.result).toEqual({});
    }
    expect(t.handlers.callTool).toHaveBeenCalledTimes(BRIDGE_LIMITS.callsInFlight);
  });

  it("retries a call once when the server's validator is busy", async () => {
    vi.useFakeTimers();
    try {
      const busy = { ok: false as const, code: "validation_busy", message: "busy" };
      const answers: ToolCallAnswer[] = [busy, { ok: true, result: { n: 1 } }, busy, busy];
      const t = setup({ callTool: vi.fn(async () => answers.shift() as ToolCallAnswer) });
      detach = t.bridge.detach;
      t.send(rpc(1, "tools/call", { name: "t" }));
      await vi.advanceTimersByTimeAsync(300);
      expect(t.reply(1)?.result).toEqual({ n: 1 });
      t.send(rpc(2, "tools/call", { name: "t" }));
      await vi.advanceTimersByTimeAsync(300);
      expect(t.reply(2)?.error).toMatchObject({ data: { reason: "validation_busy" } });
      expect(t.handlers.callTool).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops messages beyond 40 a second, notifications included, before measuring them", async () => {
    const t = setup();
    detach = t.bridge.detach;
    for (let i = 0; i < 60; i++) {
      t.send({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: i } });
    }
    t.send(rpc(1, "ui/request-display-mode", { mode: "inline" }));
    await t.flush();
    expect(t.handlers.sizeChanged).toHaveBeenCalledTimes(BRIDGE_LIMITS.messagesPerSecond);
    expect(t.replies()).toEqual([]);
    t.tick(1_001);
    t.send("x".repeat(BRIDGE_LIMITS.messageBytes + 1));
    t.send(rpc(2, "ui/request-display-mode", { mode: "inline" }));
    await t.flush();
    expect(t.reply(2)?.result).toEqual({ mode: "inline" });
  });

  it("honours initialized once per frame", async () => {
    const t = setup();
    detach = t.bridge.detach;
    for (let i = 0; i < 3; i++) {
      t.send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    }
    await t.flush();
    expect(t.handlers.initialized).toHaveBeenCalledTimes(1);
  });

  it("refuses a tool result over the size cap", async () => {
    const t = setup({
      callTool: vi.fn(async () => ({
        ok: true as const,
        result: { content: [{ type: "text", text: "x".repeat(BRIDGE_LIMITS.resultBytes) }] },
      })),
    });
    detach = t.bridge.detach;
    t.send(rpc(1, "tools/call", { name: "t" }));
    await t.flush();
    expect(t.reply(1)?.error).toMatchObject({ data: { reason: "result_too_large" } });
  });
});
