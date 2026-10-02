import { writeFile } from "node:fs/promises";
import path from "node:path";
import { SANDBOX_CLOSE_CODES, type SandboxToServerFrame } from "@kobe/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  RUN,
  SANDBOX_ID,
  THREAD,
  TOKEN,
  runStart,
  startHarness,
  type Harness,
} from "./testing/harness.js";

let h: Harness;
afterEach(async () => {
  expect(h.server.violations).toEqual([]);
  await h.close();
});

const settledOn = (connection: number) => (f: SandboxToServerFrame) =>
  f.type === "pi.event" &&
  f.event.type === "agent_settled" &&
  h.server.received.at(-1)?.connection === connection;
const helloOn = (connection: number) => () =>
  h.server.received.some((r) => r.connection === connection && r.frame.type === "hello");
const until = async (check: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("dial-out connection", () => {
  it("dials the contract path with the token in Authorization and says hello", async () => {
    h = await startHarness();
    expect(h.server.upgrades[0]).toEqual({
      authorization: `Bearer ${TOKEN}`,
      path: "/v1/sandbox/connect",
    });
    expect(h.server.frames("hello")[0]).toEqual({
      v: 1,
      type: "hello",
      sandbox_id: SANDBOX_ID,
      agent_version: "0.0.0-test",
      pi_version: "1.0.0",
      runs: [],
    });
  });

  it("keeps retrying with backoff while the token is refused, and picks up a rotated token", async () => {
    h = await startHarness();
    await writeFile(path.join(h.dir, "token"), "stale-token");
    h.server.terminate();
    await until(() => h.server.upgrades.length >= 3);
    expect(h.server.connections).toBe(1);
    await writeFile(path.join(h.dir, "token"), TOKEN);
    await until(helloOn(2));
  });

  it("answers server pings and reports malformed server frames without disconnecting", async () => {
    h = await startHarness();
    h.server.send({ v: 1, type: "ping", nonce: "n1" });
    await h.server.waitFor((f) => f.type === "pong" && f.nonce === "n1");
    h.server.sendRaw('{"v":1,"type":"run.start","command_id":"x","command_id":"y"}');
    await h.server.waitFor((f) => f.type === "error" && f.code === "malformed_frame");
    h.server.sendRaw(JSON.stringify({ v: 1, type: "pi.raw", line: "{}" }));
    await h.server.waitFor(
      (f) =>
        f.type === "error" && f.code === "malformed_frame" && h.server.frames("error").length === 2,
    );
    expect(h.server.connections).toBe(1);
  });

  it("drops a connection whose server stops answering heartbeats and dials again", async () => {
    h = await startHarness({
      server: { heartbeatIntervalMs: 1000, respondPings: false },
      heartbeatTimeoutMs: 100,
    });
    await until(helloOn(2), 8000);
  }, 15_000);

  it.each([
    ["hibernating", SANDBOX_CLOSE_CODES.hibernating, 0],
    ["sandbox_destroyed", SANDBOX_CLOSE_CODES.sandbox_destroyed, 0],
    ["replaced", SANDBOX_CLOSE_CODES.replaced, 0],
    ["unsupported_version", SANDBOX_CLOSE_CODES.unsupported_version, 1],
  ])("stops for good on %s", async (_name, code, exit) => {
    h = await startHarness();
    h.server.close(code);
    await until(() => h.exits.length > 0);
    expect(h.exits).toEqual([exit]);
    await new Promise((r) => setTimeout(r, 200));
    expect(h.server.connections).toBe(1);
  });

  it("drains on a shutdown frame: waits for the active run, then exits", async () => {
    h = await startHarness();
    await h.server.command(runStart("hang"));
    h.server.send({ v: 1, type: "shutdown", reason: "hibernate", deadline_ms: 300 });
    await until(() => h.exits.length > 0);
    expect(h.exits).toEqual([0]);
    const types = (await h.commandsLog()).map((c) => c.type);
    expect(types).toContain("abort");
  });
});

describe("delivery and resume", () => {
  it("re-sends un-acked events after a reconnect, from the server's durable seq", async () => {
    let durable = 0;
    h = await startHarness({
      server: {
        autoAck: false,
        ackRuns: (hello) =>
          hello.runs.map((r) => ({
            run_id: r.run_id,
            thread_id: r.thread_id,
            durable_seq: durable,
          })),
      },
    });
    await h.server.command(runStart("say:Hello"));
    await h.server.waitFor((f) => f.type === "pi.event" && f.event.type === "agent_settled");
    const first = h.server.frames("pi.event").map((f) => f.seq);
    expect(first).toEqual([1, 2, 3, 4, 5, 6]);
    durable = 2;
    h.server.terminate();
    await until(helloOn(2));
    const hello = h.server.frames("hello")[1];
    expect(hello?.runs).toEqual([{ run_id: RUN, thread_id: THREAD, last_seq: 6 }]);
    await h.server.waitFor(settledOn(2));
    const resent = h.server.received
      .filter((r) => r.connection === 2 && r.frame.type === "pi.event")
      .map((r) => (r.frame as { seq: number }).seq);
    expect(resent).toEqual([3, 4, 5, 6]);
  });

  it("forgets a finished run once everything is acked (not listed in the next hello)", async () => {
    h = await startHarness();
    await h.server.command(runStart("say:Hi"));
    await h.server.waitFor((f) => f.type === "pi.event" && f.event.type === "agent_settled");
    await new Promise((r) => setTimeout(r, 50));
    h.server.terminate();
    await until(helloOn(2));
    expect(h.server.frames("hello")[1]?.runs).toEqual([]);
  });

  it("serves resend on a live socket once and ignores its duplicates", async () => {
    h = await startHarness({ server: { autoAck: false } });
    await h.server.command(runStart("say:Hello"));
    await h.server.waitFor((f) => f.type === "pi.event" && f.event.type === "agent_settled");
    const before = h.server.frames("pi.event").length;
    h.server.send({ v: 1, type: "resend", run_id: RUN, from_seq: 4 });
    h.server.send({ v: 1, type: "resend", run_id: RUN, from_seq: 4 });
    h.server.send({ v: 1, type: "ack", run_id: RUN, seq: 6 });
    await until(() => h.server.frames("pi.event").length >= before + 3);
    await new Promise((r) => setTimeout(r, 100));
    expect(
      h.server
        .frames("pi.event")
        .slice(before)
        .map((f) => f.seq),
    ).toEqual([4, 5, 6]);
  });

  it("aborts runs the server no longer lists after a reconnect", async () => {
    h = await startHarness({ server: { ackRuns: () => [] } });
    await h.server.command(runStart("hang"));
    h.server.terminate();
    await until(helloOn(2));
    await new Promise((r) => setTimeout(r, 200));
    const types = (await h.commandsLog()).map((c) => c.type);
    expect(types).toContain("abort");
    h.server.terminate();
    await until(helloOn(3));
    expect(h.server.frames("hello")[2]?.runs).toEqual([]);
  });

  it("gives up a run whose un-acked events exceed the outbox limit", async () => {
    h = await startHarness({
      server: { autoAck: false, ackRuns: () => [] },
      env: { KOBE_OUTBOX_MAX_BYTES: "600" },
    });
    await h.server.command(runStart("say:Hello"));
    await until(helloOn(2));
    expect(h.server.frames("hello")[1]?.runs).toEqual([]);
  });
});
