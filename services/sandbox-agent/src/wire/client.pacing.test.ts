import type { AddressInfo } from "node:net";
import { SANDBOX_WS_SUBPROTOCOL } from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { WireClient } from "./client.js";
import type { PaceLimits } from "./pacer.js";

/**
 * KOBE-429: a reconnect replays the whole un-acked backlog at once. The fake server enforces the
 * server's per-connection token bucket (connection.ts #rateOk) and closes on the first frame over
 * it, as the real server does ("frame rate exceeded", 4006).
 */
// The agent's pace sits well under the server's limit, as SANDBOX_SEND_PACE does, so frames that
// arrive bunched (a busy event loop) still fit the server's burst.
const SERVER = { framesPerSec: 400, frameBurst: 100, bytesPerSec: 64 * 1024, byteBurst: 64 * 1024 };
const AGENT: PaceLimits = {
  framesPerSec: 300,
  frameBurst: 20,
  bytesPerSec: 48 * 1024,
  byteBurst: 32 * 1024,
};

let wss: WebSocketServer | undefined;
let client: WireClient | undefined;
afterEach(async () => {
  await client?.stop();
  await new Promise((r) => (wss ? wss.close(() => r(undefined)) : r(undefined)));
});

function rateLimitedServer() {
  const received: string[] = [];
  const closes: string[] = [];
  wss = new WebSocketServer({ port: 0, handleProtocols: () => SANDBOX_WS_SUBPROTOCOL });
  wss.on("connection", (ws: WebSocket) => {
    let frames = SERVER.frameBurst;
    let bytes = SERVER.byteBurst;
    let at = Date.now();
    ws.on("message", (data: Buffer) => {
      const now = Date.now();
      frames = Math.min(SERVER.frameBurst, frames + ((now - at) / 1000) * SERVER.framesPerSec);
      bytes = Math.min(SERVER.byteBurst, bytes + ((now - at) / 1000) * SERVER.bytesPerSec);
      at = now;
      if (frames < 1 || bytes < data.length) {
        closes.push("rate");
        ws.close(4006, "frame rate exceeded");
        return;
      }
      frames -= 1;
      bytes -= data.length;
      const frame = JSON.parse(data.toString()) as { type: string; seq?: number };
      if (frame.type === "hello") {
        ws.send(
          JSON.stringify({
            v: 1,
            type: "hello.ack",
            connection_id: "conn_1",
            server_time: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
            heartbeat_interval_ms: 15_000,
            runs: [],
          }),
        );
        return;
      }
      received.push(data.toString());
    });
  });
  const port = (wss.address() as AddressInfo).port;
  return { url: `ws://127.0.0.1:${port}/v1/sandbox/connect`, received, closes };
}

describe("WireClient send pacing (KOBE-429)", () => {
  it("replays a backlog far larger than one burst without tripping the server's rate limit, in order", async () => {
    const server = rateLimitedServer();
    const backlog = Array.from({ length: 300 }, (_, i) =>
      JSON.stringify({ v: 1, type: "pi.event", seq: i + 1, pad: "p".repeat(200) }),
    );
    let disconnected = 0;
    const ready = new Promise<void>((resolve) => {
      client = new WireClient({
        url: server.url,
        readToken: () => Promise.resolve("t"),
        hello: () =>
          ({
            v: 1,
            type: "hello",
            sandbox_id: "6f1c2b9e-3a4d-4e5f-8a7b-1c2d3e4f5a6b",
            agent_version: "0.0.0-test",
            pi_version: "1.0.0",
            runs: [],
          }) as never,
        onReady: () => {
          for (const text of backlog) expect(client?.sendText(text)).toBe(true);
          resolve();
        },
        onFrame: () => undefined,
        onDisconnected: () => (disconnected += 1),
        onFatal: () => undefined,
        logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
        pace: AGENT,
      });
      client.start();
    });
    await ready;
    const deadline = Date.now() + 5_000;
    while (
      server.received.length < backlog.length &&
      server.closes.length === 0 &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(server.closes).toEqual([]);
    expect(disconnected).toBe(0);
    expect(server.received).toEqual(backlog);
  }, 15_000);
});
