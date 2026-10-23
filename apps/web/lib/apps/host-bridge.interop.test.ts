// @vitest-environment happy-dom
import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachHostBridge, type HostBridgeHandlers } from "./host-bridge";

/**
 * KOBE-437 review LOW-5: the real ext-apps `App` (2.0.3, a devDependency only) against Kobe's
 * host bridge, in one window: the app's messages arrive with the frame's stand-in as `source`
 * and an opaque origin, and the bridge's replies come back with the host's stand-in as `source`.
 */
function wire() {
  const deliver = (data: unknown, source: object) =>
    setTimeout(() =>
      window.dispatchEvent(
        new MessageEvent("message", { data, source: source as Window, origin: "null" }),
      ),
    );
  const host = { postMessage: (data: unknown) => deliver(data, frame) };
  const frame = { postMessage: (data: unknown) => deliver(data, host) };
  return { host: host as unknown as Window, frame: frame as unknown as Window };
}

const handlers = (): HostBridgeHandlers => ({
  callTool: vi.fn(async (name: string) => ({
    ok: true as const,
    result: { content: [{ type: "text", text: `ran ${name}` }], structuredContent: { n: 1 } },
  })),
  listTools: vi.fn(async () => ({ ok: true as const, tools: [] })),
  message: vi.fn(() => true),
  updateModelContext: vi.fn(() => true),
  requestDisplayMode: vi.fn((mode: "inline" | "fullscreen") => mode),
  sizeChanged: vi.fn(),
  initialized: vi.fn(),
});

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
  vi.restoreAllMocks();
});

describe("ext-apps App against Kobe's bridge (review LOW-5)", () => {
  it("initializes, calls tools, sends a message and context, and is refused open-link", async () => {
    // The App and its transport log every message (one reason Kobe has its own bridge).
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const { host, frame } = wire();
    const h = handlers();
    const bridge = attachHostBridge(window, {
      frame: () => frame,
      handlers: h,
      hostContext: () => ({ theme: "dark", displayMode: "inline", locale: "en" }),
    });
    cleanup.push(bridge.detach);
    const app = new App({ name: "probe", version: "1" }, {}, { autoResize: false });
    const inputs: unknown[] = [];
    app.ontoolinput = (params) => inputs.push(params);
    let tornDown = false;
    app.onteardown = async () => {
      tornDown = true;
      return {};
    };
    await app.connect(new PostMessageTransport(host, host));
    cleanup.push(() => app.close());

    // Kobe's ui/initialize answer passes the App's own schema.
    expect(app.getHostVersion()).toEqual({ name: "kobe", version: "1" });
    expect(app.getHostContext()).toMatchObject({ theme: "dark", displayMode: "inline" });
    expect(app.getHostCapabilities()?.openLinks).toBeUndefined();
    await vi.waitFor(() => expect(h.initialized).toHaveBeenCalledTimes(1));
    bridge.notify("ui/notifications/tool-input", { arguments: { table: "t" } });
    await vi.waitFor(() => expect(inputs).toEqual([{ arguments: { table: "t" } }]));

    const result = await app.callServerTool({ name: "preview_table", arguments: { table: "t" } });
    expect(result.structuredContent).toEqual({ n: 1 });
    await app.sendMessage({ role: "user", content: [{ type: "text", text: "Use table t" }] });
    expect(h.message).toHaveBeenCalledWith({ text: "Use table t", items: [], dropped: 0 });
    await app.updateModelContext({ structuredContent: { table: "t" } });
    expect(h.updateModelContext).toHaveBeenCalledWith({ structuredContent: { table: "t" } });
    expect(await app.requestDisplayMode({ mode: "fullscreen" })).toMatchObject({
      mode: "fullscreen",
    });
    await expect(app.openLink({ url: "https://example.com" })).rejects.toThrow();
    await expect(app.readServerResource({ uri: "ui://x" })).rejects.toThrow();
    // A teardown request from Kobe is answered by the App.
    await expect(bridge.teardown(2_000)).resolves.toBe(true);
    expect(tornDown).toBe(true);
  });
});
