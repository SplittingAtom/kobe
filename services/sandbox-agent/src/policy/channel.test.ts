import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { LineSplitter } from "../jsonl.js";
import {
  POLICY_CHANNEL_BURST,
  POLICY_CHANNEL_MAX_WRITE_BUFFER,
  PolicyChannel,
  type PolicyChannelCheck,
} from "./channel.js";

/** A fake duplex: `toAgent` is what the extension writes, `fromAgent` what the agent writes. */
function setup(now: () => number = Date.now) {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const stream = Object.assign(toAgent, {
    write: fromAgent.write.bind(fromAgent),
  }) as unknown as PassThrough;
  Object.defineProperty(stream, "writableLength", { get: () => fromAgent.writableLength });
  const received: Record<string, unknown>[] = [];
  const splitter = new LineSplitter({
    maxLineBytes: 1 << 24,
    onLine: (l) => received.push(JSON.parse(l) as Record<string, unknown>),
  });
  fromAgent.on("data", (c: Buffer) => splitter.push(c));
  const checks: PolicyChannelCheck[] = [];
  const closed: string[] = [];
  const channel = new PolicyChannel(stream, {
    onCheck: (c) => checks.push(c),
    onClosed: (r) => closed.push(r),
    now,
  });
  const nonce = () => (received[0] as { nonce: string }).nonce;
  const send = (value: unknown) => toAgent.push(`${JSON.stringify(value)}\n`);
  const check = (id: string, extra: Record<string, unknown> = {}) => ({
    type: "policy.check",
    nonce: nonce(),
    request_id: id,
    tool_call_id: "call_1",
    tool: "bash",
    input: { command: "ls" },
    ...extra,
  });
  const tick = () => new Promise((r) => setImmediate(r));
  const ready = () =>
    send({ type: "channel.ready", nonce: nonce(), extension: "kobe-policy", version: 1 });
  return { channel, received, checks, closed, send, check, nonce, tick, ready, fromAgent };
}

/** A channel whose extension has completed the handshake (`channel.ready`). */
async function readySetup(now?: () => number) {
  const t = setup(now);
  await t.tick();
  t.ready();
  await t.tick();
  return t;
}

describe("PolicyChannel", () => {
  it("opens with a per-spawn nonce and accepts requests that carry it", async () => {
    const t = await readySetup();
    expect(t.received[0]).toMatchObject({ type: "channel.hello" });
    expect(t.nonce()).toMatch(/^[\w-]{32}$/);
    const other = setup();
    await other.tick();
    expect(other.nonce()).not.toBe(t.nonce());
    t.send(t.check("r1"));
    await t.tick();
    expect(t.checks.map((c) => c.request_id)).toEqual(["r1"]);
  });

  it("closes (fail closed) on a request without the right nonce", async () => {
    const t = await readySetup();
    t.send({ ...t.check("r1"), nonce: "forged" });
    await t.tick();
    expect(t.checks).toEqual([]);
    expect(t.closed).toEqual(["policy request without the channel nonce"]);
    expect(t.channel.closed).toBe(true);
  });

  it("never relays an approval token to the extension", async () => {
    const t = await readySetup();
    t.channel.reply({
      type: "policy.result",
      request_id: "r1",
      decision: "allow",
      reasons: [],
      approval: { mac: "secret" },
    });
    await t.tick();
    expect(t.received[1]).toEqual({
      type: "policy.result",
      request_id: "r1",
      decision: "allow",
      reasons: [],
    });
  });

  it("rate-limits requests and denies the excess", async () => {
    const t = await readySetup(() => 1000);
    for (let i = 0; i < POLICY_CHANNEL_BURST + 3; i++) t.send(t.check(`r${i}`));
    await t.tick();
    expect(t.checks).toHaveLength(POLICY_CHANNEL_BURST);
    const denied = t.received.filter((m) => m.decision === "deny");
    expect(denied).toHaveLength(3);
    expect(denied[0]).toMatchObject({ message: "policy requests rate-limited" });
  });

  it("closes when replies pile up unread", async () => {
    const t = await readySetup();
    t.fromAgent.removeAllListeners("data");
    t.fromAgent.pause();
    const big = "x".repeat(64 * 1024);
    for (let i = 0; i * big.length <= POLICY_CHANNEL_MAX_WRITE_BUFFER + big.length; i++) {
      t.channel.reply({ type: "policy.pending", request_id: `r${i}`, pad: big });
    }
    expect(t.closed).toEqual(["policy channel reader is not reading"]);
  });

  it("denies a malformed request it can identify", async () => {
    const t = await readySetup();
    t.send({ ...t.check("r9"), input: [] });
    await t.tick();
    expect(t.received.at(-1)).toMatchObject({ request_id: "r9", decision: "deny" });
  });

  it("reports ready on channel.ready with the nonce", async () => {
    const t = setup();
    await t.tick();
    const ready = t.channel.waitReady(1000);
    expect(t.channel.ready).toBe(false);
    t.ready();
    await expect(ready).resolves.toBeUndefined();
    expect(t.channel.ready).toBe(true);
    await expect(t.channel.waitReady(1)).resolves.toBeUndefined();
  });

  it("denies checks that arrive before channel.ready", async () => {
    const t = setup();
    await t.tick();
    t.send(t.check("early"));
    await t.tick();
    expect(t.checks).toEqual([]);
    expect(t.received.at(-1)).toMatchObject({
      request_id: "early",
      decision: "deny",
      message: "kobe-policy is not ready",
    });
  });

  it("closes and rejects the ready wait when kobe-policy refuses", async () => {
    const t = setup();
    await t.tick();
    const ready = t.channel.waitReady(1000);
    t.send({ type: "channel.refused", nonce: t.nonce(), reason: "not the last extension" });
    await expect(ready).rejects.toThrow("kobe-policy refused to start: not the last extension");
    expect(t.closed).toEqual(["kobe-policy refused to start: not the last extension"]);
  });

  it("rejects the ready wait on timeout and on close", async () => {
    const t = setup();
    await t.tick();
    await expect(t.channel.waitReady(20)).rejects.toThrow(/did not report ready/);
    const waiting = t.channel.waitReady(1000);
    t.channel.close("pi exited");
    await expect(waiting).rejects.toThrow("pi exited");
    await expect(t.channel.waitReady(1000)).rejects.toThrow("pi exited");
  });

  it.each([
    ["a wrong extension name", { extension: "other" }],
    ["a wrong version", { version: 2 }],
  ])("closes on channel.ready with %s", async (_name, patch) => {
    const t = setup();
    await t.tick();
    t.send({
      type: "channel.ready",
      nonce: t.nonce(),
      extension: "kobe-policy",
      version: 1,
      ...patch,
    });
    await t.tick();
    expect(t.channel.closed).toBe(true);
  });

  it("closes on a second channel.ready", async () => {
    const t = await readySetup();
    t.ready();
    await t.tick();
    expect(t.closed).toEqual(["unexpected policy channel message"]);
  });

  it("closes on a channel.ready without the nonce", async () => {
    const t = setup();
    await t.tick();
    t.send({ type: "channel.ready", nonce: "forged", extension: "kobe-policy", version: 1 });
    await t.tick();
    expect(t.closed).toEqual(["policy request without the channel nonce"]);
  });
});
