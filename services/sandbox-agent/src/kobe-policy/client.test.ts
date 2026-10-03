import { duplexPair, type Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PolicyClient, type CheckRequest } from "./client.js";
import {
  FIRST_REPLY_TIMEOUT_MS,
  MAX_PENDING_CHECKS,
  MAX_REPLY_LINE_BYTES,
  MAX_REQUEST_LINE_BYTES,
} from "./protocol.js";

const NONCE = "n".repeat(32);

/** The agent's end of the channel: what the extension wrote, and a way to answer. */
function fakeAgent(agentEnd: Duplex) {
  const received: Record<string, unknown>[] = [];
  let buffer = "";
  agentEnd.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let lf = buffer.indexOf("\n");
    while (lf !== -1) {
      received.push(JSON.parse(buffer.slice(0, lf)) as Record<string, unknown>);
      buffer = buffer.slice(lf + 1);
      lf = buffer.indexOf("\n");
    }
  });
  return {
    received,
    send: (value: unknown) => agentEnd.write(`${JSON.stringify(value)}\n`),
    raw: (text: string) => agentEnd.write(text),
    checks: () => received.filter((m) => m.type === "policy.check"),
    end: () => agentEnd.end(),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function connected(options: { now?: () => number } = {}) {
  const [extensionEnd, agentEnd] = duplexPair();
  const agent = fakeAgent(agentEnd);
  const client = new PolicyClient(extensionEnd, options);
  agent.send({ type: "channel.hello", nonce: NONCE });
  await client.handshake();
  return { client, agent, extensionEnd };
}

const request = (overrides: Partial<CheckRequest> = {}): CheckRequest => ({
  toolCallId: "call_1",
  tool: "bash",
  input: { command: "ls" },
  ...overrides,
});

async function sent(agent: ReturnType<typeof fakeAgent>, count = 1) {
  for (let i = 0; i < 20 && agent.checks().length < count; i += 1) await flush();
  return agent.checks().at(count - 1) as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PolicyClient handshake", () => {
  it("reads channel.hello first and echoes the nonce in channel.ready", async () => {
    const { client, agent } = await connected();
    client.ready();
    await flush();
    expect(agent.received).toEqual([
      { type: "channel.ready", nonce: NONCE, extension: "kobe-policy", version: 1 },
    ]);
    expect(client.state).toBe("ready");
  });

  it("fails the handshake when the first line is not channel.hello", async () => {
    const [extensionEnd, agentEnd] = duplexPair();
    const agent = fakeAgent(agentEnd);
    const client = new PolicyClient(extensionEnd);
    agent.send({ type: "policy.result", request_id: "x", decision: "allow" });
    await expect(client.handshake()).rejects.toThrow(/channel.hello/);
    expect(client.state).toBe("closed");
  });

  it("fails the handshake on a missing nonce", async () => {
    const [extensionEnd, agentEnd] = duplexPair();
    const agent = fakeAgent(agentEnd);
    const client = new PolicyClient(extensionEnd);
    agent.send({ type: "channel.hello", nonce: "" });
    await expect(client.handshake()).rejects.toThrow(/nonce/);
  });

  it("fails the handshake when the agent never says hello", async () => {
    vi.useFakeTimers();
    const [extensionEnd] = duplexPair();
    const client = new PolicyClient(extensionEnd);
    const handshake = client.handshake();
    const settled = expect(handshake).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(10_001);
    await settled;
    expect(client.state).toBe("closed");
  });

  it("fails the handshake when the channel closes first", async () => {
    const [extensionEnd, agentEnd] = duplexPair();
    const client = new PolicyClient(extensionEnd);
    agentEnd.end();
    await expect(client.handshake()).rejects.toThrow(/closed/);
  });

  it("refuse() tells the agent why and closes the channel", async () => {
    const { client, agent } = await connected();
    client.refuse("not the last extension");
    await flush();
    expect(agent.received).toEqual([
      { type: "channel.refused", nonce: NONCE, reason: "not the last extension" },
    ]);
    expect(client.state).toBe("closed");
    expect(await client.check(request())).toMatchObject({ allow: false });
  });
});

describe("PolicyClient checks", () => {
  it("sends tool name, input, ids and the nonce, and allows on an allow result", async () => {
    const { client, agent } = await connected();
    client.ready();
    const verdict = client.check(request({ parentToolCallId: "cm1" }));
    const check = await sent(agent);
    expect(check).toEqual({
      type: "policy.check",
      nonce: NONCE,
      request_id: expect.stringMatching(/^kp_\d+$/),
      tool_call_id: "call_1",
      parent_tool_call_id: "cm1",
      tool: "bash",
      input: { command: "ls" },
    });
    agent.send({
      type: "policy.result",
      request_id: check.request_id,
      run_id: "r",
      tool_call_id: "call_1",
      decision: "allow",
      reasons: [{ code: "risk_class" }],
    });
    expect(await verdict).toEqual({ allow: true });
  });

  it("never sends annotations or risk, only what the server needs", async () => {
    const { client, agent } = await connected();
    client.ready();
    void client.check(request());
    const check = await sent(agent);
    expect(Object.keys(check).sort()).toEqual(
      ["input", "nonce", "request_id", "tool", "tool_call_id", "type"].sort(),
    );
  });

  it("blocks with the server's message on deny", async () => {
    const { client, agent } = await connected();
    client.ready();
    const verdict = client.check(request());
    const check = await sent(agent);
    agent.send({
      type: "policy.result",
      request_id: check.request_id,
      tool_call_id: "call_1",
      decision: "deny",
      reasons: [{ code: "team_deny_rule" }],
      message: "Denied by team rule",
    });
    expect(await verdict).toEqual({ allow: false, reason: "Denied by team rule" });
  });

  it("treats an allow for another tool call id as a deny", async () => {
    const { client, agent } = await connected();
    client.ready();
    const verdict = client.check(request());
    const check = await sent(agent);
    agent.send({
      type: "policy.result",
      request_id: check.request_id,
      tool_call_id: "call_OTHER",
      decision: "allow",
      reasons: [],
    });
    expect(await verdict).toMatchObject({ allow: false, reason: expect.stringMatching(/another/) });
  });

  it.each([
    ["no tool_call_id", { decision: "allow" }],
    ["unknown decision", { decision: "require_approval", tool_call_id: "call_1" }],
    ["decision not a string", { decision: true, tool_call_id: "call_1" }],
  ])("treats a malformed result (%s) as a deny", async (_name, body) => {
    const { client, agent } = await connected();
    client.ready();
    const verdict = client.check(request());
    const check = await sent(agent);
    agent.send({ type: "policy.result", request_id: check.request_id, ...body });
    expect(await verdict).toMatchObject({ allow: false });
  });

  it("answers parallel checks independently by request id", async () => {
    const { client, agent } = await connected();
    client.ready();
    const a = client.check(request({ toolCallId: "a" }));
    const b = client.check(request({ toolCallId: "b" }));
    const second = await sent(agent, 2);
    const first = agent.checks()[0] as Record<string, unknown>;
    agent.send({
      type: "policy.result",
      request_id: second.request_id,
      tool_call_id: "b",
      decision: "deny",
      reasons: [],
      message: "no",
    });
    agent.send({
      type: "policy.result",
      request_id: first.request_id,
      tool_call_id: "a",
      decision: "allow",
      reasons: [],
    });
    expect(await a).toEqual({ allow: true });
    expect(await b).toEqual({ allow: false, reason: "no" });
  });

  it("keeps waiting after policy.pending until the final result", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client, agent } = await connected();
    client.ready();
    let settled = false;
    const verdict = client.check(request()).then((v) => {
      settled = true;
      return v;
    });
    const check = await sent(agent);
    agent.send({
      type: "policy.pending",
      request_id: check.request_id,
      tool_call_id: "call_1",
      approval_id: "a",
      expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    // Well past the first-reply timeout: a pending approval is waited for.
    await vi.advanceTimersByTimeAsync(FIRST_REPLY_TIMEOUT_MS * 5);
    expect(settled).toBe(false);
    agent.send({
      type: "policy.result",
      request_id: check.request_id,
      tool_call_id: "call_1",
      decision: "allow",
      reasons: [],
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(await verdict).toEqual({ allow: true });
  });

  it("blocks when a pending approval outlives expires_at (plus grace)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client, agent } = await connected();
    client.ready();
    const verdict = client.check(request());
    const check = await sent(agent);
    agent.send({
      type: "policy.pending",
      request_id: check.request_id,
      tool_call_id: "call_1",
      approval_id: "a",
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 60_001);
    expect(await verdict).toMatchObject({ allow: false, reason: expect.stringMatching(/expired/) });
  });

  it("caps the pending wait at the approval TTL whatever expires_at claims", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client, agent } = await connected();
    client.ready();
    const verdict = client.check(request());
    const check = await sent(agent);
    agent.send({
      type: "policy.pending",
      request_id: check.request_id,
      tool_call_id: "call_1",
      approval_id: "a",
      expires_at: "2999-01-01T00:00:00Z",
    });
    await vi.advanceTimersByTimeAsync(61 * 60_000 + 1);
    expect(await verdict).toMatchObject({ allow: false });
  });

  it("cannot be kept waiting forever by repeated policy.pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client, agent } = await connected();
    client.ready();
    let settled = false;
    const verdict = client.check(request()).then((v) => {
      settled = true;
      return v;
    });
    const check = await sent(agent);
    const pending = () =>
      agent.send({
        type: "policy.pending",
        request_id: check.request_id,
        tool_call_id: "call_1",
        approval_id: "a",
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
      });
    for (let i = 0; i < 5 && !settled; i += 1) {
      pending();
      await vi.advanceTimersByTimeAsync(30 * 60_000);
    }
    expect(await verdict).toMatchObject({ allow: false, reason: expect.stringMatching(/expired/) });
  });

  it("blocks when no answer arrives in time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client, agent } = await connected();
    client.ready();
    const verdict = client.check(request());
    await sent(agent);
    await vi.advanceTimersByTimeAsync(FIRST_REPLY_TIMEOUT_MS + 1);
    expect(await verdict).toMatchObject({
      allow: false,
      reason: expect.stringMatching(/timed out/),
    });
  });

  it("blocks pending and later checks when the channel closes", async () => {
    const { client, agent } = await connected();
    client.ready();
    const verdict = client.check(request());
    await sent(agent);
    agent.end();
    expect(await verdict).toMatchObject({ allow: false, reason: expect.stringMatching(/closed/) });
    expect(client.state).toBe("closed");
    expect(await client.check(request())).toMatchObject({ allow: false });
  });

  it("closes (fail closed) on an unparsable reply line", async () => {
    const { client, agent } = await connected();
    client.ready();
    const verdict = client.check(request());
    await sent(agent);
    agent.raw("{not json\n");
    expect(await verdict).toMatchObject({ allow: false });
    expect(client.state).toBe("closed");
  });

  it("closes on a second channel.hello (someone else is talking)", async () => {
    const { client, agent } = await connected();
    client.ready();
    const verdict = client.check(request());
    await sent(agent);
    agent.send({ type: "channel.hello", nonce: "other" });
    expect(await verdict).toMatchObject({ allow: false });
    expect(client.state).toBe("closed");
  });

  it("closes on an oversize reply line", async () => {
    const { client, agent } = await connected();
    client.ready();
    const verdict = client.check(request());
    await sent(agent);
    agent.raw("x".repeat(MAX_REPLY_LINE_BYTES + 10));
    expect(await verdict).toMatchObject({ allow: false });
    expect(client.state).toBe("closed");
  });

  it("ignores answers to unknown request ids", async () => {
    const { client, agent } = await connected();
    client.ready();
    const verdict = client.check(request());
    const check = await sent(agent);
    agent.send({
      type: "policy.result",
      request_id: "kp_999",
      tool_call_id: "call_1",
      decision: "allow",
    });
    agent.send({
      type: "policy.result",
      request_id: check.request_id,
      tool_call_id: "call_1",
      decision: "deny",
      message: "no",
    });
    expect(await verdict).toEqual({ allow: false, reason: "no" });
    expect(client.state).toBe("ready");
  });

  it("blocks without asking before ready()", async () => {
    const { client, agent } = await connected();
    expect(await client.check(request())).toMatchObject({ allow: false });
    await flush();
    expect(agent.checks()).toHaveLength(0);
  });

  it("blocks when the run is aborted while waiting, and ignores the late answer", async () => {
    const { client, agent } = await connected();
    client.ready();
    const abort = new AbortController();
    const verdict = client.check(request({ signal: abort.signal }));
    const check = await sent(agent);
    abort.abort();
    expect(await verdict).toMatchObject({ allow: false, reason: expect.stringMatching(/stopped/) });
    agent.send({
      type: "policy.result",
      request_id: check.request_id,
      tool_call_id: "call_1",
      decision: "allow",
    });
    await flush();
    expect(client.state).toBe("ready");
  });

  it("blocks at once when the signal is already aborted", async () => {
    const { client, agent } = await connected();
    client.ready();
    const abort = new AbortController();
    abort.abort();
    expect(await client.check(request({ signal: abort.signal }))).toMatchObject({ allow: false });
    await flush();
    expect(agent.checks()).toHaveLength(0);
  });

  it("caps checks in flight", async () => {
    const { client } = await connected();
    client.ready();
    for (let i = 0; i < MAX_PENDING_CHECKS; i += 1)
      void client.check(request({ toolCallId: `c${i}` }));
    expect(await client.check(request({ toolCallId: "over" }))).toMatchObject({
      allow: false,
      reason: expect.stringMatching(/too many/),
    });
  });

  it("blocks a check whose request line would exceed the agent's limit", async () => {
    const { client, agent } = await connected();
    client.ready();
    const verdict = await client.check(
      request({ input: { content: "x".repeat(4 * 1024 * 1024) } }),
    );
    expect(verdict).toMatchObject({ allow: false, reason: expect.stringMatching(/too large/) });
    await flush();
    expect(agent.checks()).toHaveLength(0);
  });

  it("keeps request lines within the server's 1 MiB policy.check frame limit", () => {
    expect(MAX_REQUEST_LINE_BYTES).toBeLessThanOrEqual(1024 * 1024 - 2048);
  });

  it("blocks a second check with a tool call id already in flight", async () => {
    const { client, agent } = await connected();
    client.ready();
    void client.check(request({ toolCallId: "same" }));
    expect(await client.check(request({ toolCallId: "same" }))).toMatchObject({
      allow: false,
      reason: expect.stringMatching(/already/),
    });
    await flush();
    expect(agent.checks()).toHaveLength(1);
  });

  it("blocks a check with a tool call id decided before (allowed or not)", async () => {
    const { client, agent } = await connected();
    client.ready();
    const first = client.check(request({ toolCallId: "cm1/1" }));
    const check = await sent(agent);
    agent.send({
      type: "policy.result",
      request_id: check.request_id,
      tool_call_id: "cm1/1",
      decision: "allow",
    });
    expect(await first).toEqual({ allow: true });
    // e.g. a top-level call whose provider id collides with a codemode nested id
    expect(await client.check(request({ toolCallId: "cm1/1" }))).toMatchObject({ allow: false });
    await flush();
    expect(agent.checks()).toHaveLength(1);
  });

  it("does not let a locally refused call free its id for reuse", async () => {
    const { client } = await connected();
    client.ready();
    const abort = new AbortController();
    abort.abort();
    expect(await client.check(request({ toolCallId: "x", signal: abort.signal }))).toMatchObject({
      allow: false,
    });
    expect(await client.check(request({ toolCallId: "x" }))).toMatchObject({
      allow: false,
      reason: expect.stringMatching(/already/),
    });
  });

  it("tells the agent to drop a check it gave up on (timeout)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client, agent } = await connected();
    client.ready();
    const verdict = client.check(request());
    const check = await sent(agent);
    await vi.advanceTimersByTimeAsync(FIRST_REPLY_TIMEOUT_MS + 1);
    await verdict;
    await vi.advanceTimersByTimeAsync(1);
    expect(agent.received.at(-1)).toEqual({
      type: "policy.cancel",
      nonce: NONCE,
      request_id: check.request_id,
    });
  });

  it("tells the agent to drop a check it gave up on (run stopped)", async () => {
    const { client, agent } = await connected();
    client.ready();
    const abort = new AbortController();
    const verdict = client.check(request({ signal: abort.signal }));
    const check = await sent(agent);
    abort.abort();
    await verdict;
    await flush();
    expect(agent.received.at(-1)).toMatchObject({
      type: "policy.cancel",
      request_id: check.request_id,
    });
  });

  it("serialises the request without toJSON (what is sent is the own data)", async () => {
    const { client, agent } = await connected();
    client.ready();
    const proto = Object.prototype as { toJSON?: () => unknown };
    proto.toJSON = () => ({ command: "harmless" });
    try {
      void client.check(request({ input: { command: "rm -rf /" } }));
      const check = await sent(agent);
      expect(check.input).toEqual({ command: "rm -rf /" });
      expect(check.tool).toBe("bash");
    } finally {
      delete proto.toJSON;
    }
  });
});
