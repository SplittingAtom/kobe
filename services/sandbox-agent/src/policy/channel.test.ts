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
  return { channel, received, checks, closed, send, check, nonce, tick, fromAgent };
}

describe("PolicyChannel", () => {
  it("opens with a per-spawn nonce and accepts requests that carry it", async () => {
    const t = setup();
    await t.tick();
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
    const t = setup();
    await t.tick();
    t.send({ ...t.check("r1"), nonce: "forged" });
    await t.tick();
    expect(t.checks).toEqual([]);
    expect(t.closed).toEqual(["policy request without the channel nonce"]);
    expect(t.channel.closed).toBe(true);
  });

  it("never relays an approval token to the extension", async () => {
    const t = setup();
    await t.tick();
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
    const t = setup(() => 1000);
    await t.tick();
    for (let i = 0; i < POLICY_CHANNEL_BURST + 3; i++) t.send(t.check(`r${i}`));
    await t.tick();
    expect(t.checks).toHaveLength(POLICY_CHANNEL_BURST);
    const denied = t.received.filter((m) => m.decision === "deny");
    expect(denied).toHaveLength(3);
    expect(denied[0]).toMatchObject({ message: "policy requests rate-limited" });
  });

  it("closes when replies pile up unread", async () => {
    const t = setup();
    await t.tick();
    t.fromAgent.removeAllListeners("data");
    t.fromAgent.pause();
    const big = "x".repeat(64 * 1024);
    for (let i = 0; i * big.length <= POLICY_CHANNEL_MAX_WRITE_BUFFER + big.length; i++) {
      t.channel.reply({ type: "policy.pending", request_id: `r${i}`, pad: big });
    }
    expect(t.closed).toEqual(["policy channel reader is not reading"]);
  });

  it("denies a malformed request it can identify", async () => {
    const t = setup();
    await t.tick();
    t.send({ ...t.check("r9"), input: [] });
    await t.tick();
    expect(t.received.at(-1)).toMatchObject({ request_id: "r9", decision: "deny" });
  });
});
