import type { AddressInfo } from "node:net";
import { SANDBOX_CLOSE_CODES, SANDBOX_WS_SUBPROTOCOL } from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { SessionClient } from "../session/exchange.js";
import { until } from "../testing/harness.js";
import { WireClient } from "./client.js";

/**
 * KOBE-522: after a signing-key change the server refuses the cached wire token (401 on the
 * upgrade, or 4001 on a live connection). The client reports the refused token, and the next dial
 * carries whatever `readToken` hands out then: with the session client, a freshly traded one.
 */
const SANDBOX = "af1a2b3c-4d5e-4f60-9182-93a4b5c6d7e8";
const TEAM = "0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e";
const USER = "2d7a0b3e-4f5c-4d7e-8fa0-2b3c4d5e6f70";
const FAST = { baseMs: 10, maxMs: 20, floorMs: 5 };
const tok = (aud: string, n: number) => `${aud}.${"x".repeat(30)}.${n}`;

let wss: WebSocketServer | undefined;
let client: WireClient | undefined;
afterEach(async () => {
  await client?.stop();
  client = undefined;
  await new Promise((r) => (wss ? wss.close(() => r(undefined)) : r(undefined)));
});

/** Accepts only `accepted()` (unless `refuse()` names a status first). */
function server(accepted: () => string, refuse: () => number | undefined = () => undefined) {
  const upgrades: (string | undefined)[] = [];
  const sockets: WebSocket[] = [];
  wss = new WebSocketServer({
    port: 0,
    handleProtocols: () => SANDBOX_WS_SUBPROTOCOL,
    verifyClient: (info, done) => {
      upgrades.push(info.req.headers.authorization);
      const status = refuse();
      if (status !== undefined) {
        done(false, status);
        return;
      }
      const ok = info.req.headers.authorization === `Bearer ${accepted()}`;
      done(ok, ok ? undefined : 401);
    },
  });
  wss.on("connection", (ws: WebSocket) => {
    sockets.push(ws);
    ws.on("message", (data: Buffer) => {
      if ((JSON.parse(data.toString()) as { type: string }).type !== "hello") return;
      ws.send(
        JSON.stringify({
          v: 1,
          type: "hello.ack",
          connection_id: `conn_${sockets.length}`,
          server_time: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
          heartbeat_interval_ms: 15_000,
          runs: [],
        }),
      );
    });
  });
  const port = (wss.address() as AddressInfo).port;
  return { url: `ws://127.0.0.1:${port}/v1/sandbox/connect`, upgrades, sockets };
}

function wire(
  url: string,
  readToken: () => Promise<string>,
  onTokenRejected: (token: string, reason: string) => void,
) {
  let ready = 0;
  let resolveReady: () => void = () => undefined;
  const nextReady = () => new Promise<void>((r) => (resolveReady = r));
  let waiting = nextReady();
  client = new WireClient({
    url,
    readToken,
    hello: () =>
      ({
        v: 1,
        type: "hello",
        sandbox_id: SANDBOX,
        agent_version: "0",
        pi_version: "1.0.0",
        runs: [],
      }) as never,
    onReady: () => {
      ready += 1;
      resolveReady();
    },
    onFrame: () => undefined,
    onDisconnected: () => {
      waiting = nextReady();
    },
    onFatal: () => undefined,
    onTokenRejected,
    logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
    backoff: FAST,
  });
  client.start();
  return { ready: () => waiting, count: () => ready };
}

describe("WireClient with a refused session token (KOBE-522)", () => {
  it("reports a 401 on the upgrade with the refused token, then dials with the next token", async () => {
    const s = server(() => "fresh");
    const tokens = ["stale", "fresh"];
    const rejected: [string, string][] = [];
    const w = wire(
      s.url,
      async () => tokens[0] as string,
      (token, reason) => {
        rejected.push([token, reason]);
        tokens.shift();
      },
    );
    await w.ready();
    expect(rejected).toEqual([["stale", "wire upgrade refused: HTTP 401"]]);
    expect(s.upgrades).toEqual(["Bearer stale", "Bearer fresh"]);
  });

  it("reports a 4001 close of a live connection and reconnects with the next token", async () => {
    let accepted = "t1";
    const s = server(() => accepted);
    const rejected: string[] = [];
    let current = "t1";
    const w = wire(
      s.url,
      async () => current,
      (token) => {
        rejected.push(token);
        current = "t2";
      },
    );
    await w.ready();
    accepted = "t2";
    s.sockets[0]?.close(SANDBOX_CLOSE_CODES.unauthorized, "token");
    await until(() => w.count() === 2);
    expect(rejected).toEqual(["t1"]);
    expect(s.upgrades.at(-1)).toBe("Bearer t2");
    expect(w.count()).toBe(2);
  });

  it("recovers through the session client's bootstrap re-trade, without a restart", async () => {
    let trades = 0;
    const session = new SessionClient({
      serverUrl: "ws://server.kobe.internal:8081",
      bootstrapTokenFile: "/var/run/secrets/kobe/bootstrap-token",
      readFile: async () => "bootstrap",
      fetch: (async () => {
        trades += 1;
        return new Response(
          JSON.stringify({
            sandbox_id: SANDBOX,
            team_id: TEAM,
            user_id: USER,
            expires_at: new Date(Date.now() + 900_000).toISOString(),
            tokens: {
              "kobe.sandbox-wire": tok("wire", trades),
              "kobe.model-gateway": tok("gw", trades),
              "kobe.mcp-proxy": tok("mcp", trades),
              "kobe.egress-proxy": tok("egress", trades),
            },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
      logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
    });
    await session.grant(); // the pre-upgrade grant, signed with the old key
    const gateway: string[] = [];
    session.onGrant((g) => gateway.push(g.tokens["kobe.model-gateway"]));
    const s = server(() => tok("wire", 2)); // the upgraded server knows only the new key
    const w = wire(
      s.url,
      () => session.wireToken(),
      (token, reason) => void session.rejected("kobe.sandbox-wire", reason, token),
    );
    await w.ready();
    expect(trades).toBe(2);
    expect(s.upgrades).toEqual([`Bearer ${tok("wire", 1)}`, `Bearer ${tok("wire", 2)}`]);
    expect(gateway).toEqual([tok("gw", 2)]);
  });

  it("does not report a network drop (1006) or a 503 upgrade answer as a refused token", async () => {
    let refusals = 1; // the first upgrade gets 503 (capacity), later ones are accepted
    const s = server(
      () => "t1",
      () => (refusals-- > 0 ? 503 : undefined),
    );
    const rejected: string[] = [];
    const w = wire(
      s.url,
      async () => "t1",
      (token) => rejected.push(token),
    );
    await w.ready();
    s.sockets[0]?.terminate(); // 1006 on the agent's side
    await until(() => w.count() === 2);
    expect(s.upgrades).toHaveLength(3);
    expect(rejected).toEqual([]);
  });
});
