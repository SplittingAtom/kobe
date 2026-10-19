// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAppCsp, APP_FRAME_CSP } from "./app-frame";
import { attachStubBridge, stubBridgeReply } from "./preview-bridge";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("template preview bridge (KOBE-434 ac-2)", () => {
  it("answers ui/initialize and refuses every call, reaching no network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const frame = { postMessage: vi.fn() } as unknown as Window;
    const detach = attachStubBridge(window, () => frame);
    const send = (data: unknown, source: unknown = frame) =>
      window.dispatchEvent(
        new MessageEvent("message", { data, source: source as Window, origin: "null" }),
      );
    send({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "preview_table" } });
    send({ jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "ui://x" } });
    send({ jsonrpc: "2.0", id: 4, method: "ui/open-link", params: { url: "https://evil" } });
    await Promise.resolve();
    const replies = (frame.postMessage as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(replies[0]).toMatchObject({ id: 1, result: { hostInfo: { name: "kobe-preview" } } });
    for (const reply of replies.slice(1)) expect(reply).toMatchObject({ error: { code: -32601 } });
    expect(fetchSpy).not.toHaveBeenCalled();
    detach();
  });

  it("ignores messages from any other window and junk", () => {
    const frame = { postMessage: vi.fn() } as unknown as Window;
    const other = { postMessage: vi.fn() } as unknown as Window;
    const detach = attachStubBridge(window, () => frame);
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { jsonrpc: "2.0", id: 1, method: "tools/call" },
        source: other,
      }),
    );
    expect(frame.postMessage).not.toHaveBeenCalled();
    expect(other.postMessage).not.toHaveBeenCalled();
    expect(stubBridgeReply("junk")).toBeUndefined();
    expect(stubBridgeReply({ jsonrpc: "2.0", method: "notifications/message" })).toBeUndefined();
    detach();
  });
});

describe("withAppCsp", () => {
  it("puts the restrictive CSP first in <head>, adding one when missing", () => {
    expect(withAppCsp("<html><head><title>x</title></head></html>")).toBe(
      `<html><head><meta http-equiv="Content-Security-Policy" content="${APP_FRAME_CSP}"><title>x</title></head></html>`,
    );
    expect(withAppCsp("<p>x</p>")).toMatch(/^<head><meta http-equiv="Content-Security-Policy"/);
    expect(withAppCsp('<html lang="en"><body/></html>')).toMatch(
      /^<html lang="en"><head><meta http-equiv/,
    );
    expect(APP_FRAME_CSP).toContain("connect-src 'none'");
  });
});
