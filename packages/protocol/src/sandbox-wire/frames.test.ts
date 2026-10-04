import { describe, expect, it } from "vitest";
import {
  KOBE_EVENT_DROPPED_TYPE,
  SANDBOX_FRAME_MAX_BYTES_BY_TYPE,
  SANDBOX_MAX_FRAME_BYTES,
  SANDBOX_SMALL_FRAME_MAX_BYTES,
  decodeSandboxFrame,
  decodeServerFrame,
  encodeFrame,
  kobeEventDroppedSchema,
  parseTranslatedPiEvent,
  piGetEntriesDataSchema,
  type ApprovalToken,
  type PolicyReason,
  type SandboxToServerFrame,
  type ServerToSandboxFrame,
} from "../index.js";
import { EXAMPLE_IDS } from "../testing/index.js";

const RUN = EXAMPLE_IDS.run;
const THREAD = EXAMPLE_IDS.thread;
const reasons: PolicyReason[] = [{ code: "risk_write", stage: "risk_class", message: "write" }];
const token: ApprovalToken = {
  v: 1,
  alg: "HS256",
  kid: "k1",
  approval_id: EXAMPLE_IDS.approval,
  team_id: EXAMPLE_IDS.team,
  run_id: RUN,
  tool_call_id: "tc_9",
  tool: "mcp__jira__create_issue",
  expires_at: "2026-10-01T22:25:00.000Z",
  mac: "qbWYpNoF2pEa4o3Xx7zSNtttC4MrsCzeOkAPq2gKO0w",
};

const sandboxFrames = {
  hello: {
    v: 1,
    type: "hello",
    sandbox_id: EXAMPLE_IDS.sandbox,
    agent_version: "0.1.0",
    pi_version: "1.0.0",
    runs: [{ run_id: RUN, thread_id: THREAD, last_seq: 12 }],
  },
  "pi.event": {
    v: 1,
    type: "pi.event",
    run_id: RUN,
    thread_id: THREAD,
    seq: 13,
    event: {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" },
    },
  },
  "pi.ui_request": {
    v: 1,
    type: "pi.ui_request",
    thread_id: THREAD,
    request: {
      type: "extension_ui_request",
      id: "u1",
      method: "confirm",
      title: "Sure?",
      message: "x",
    },
  },
  "policy.check": {
    v: 1,
    type: "policy.check",
    request_id: "pc_1",
    run_id: RUN,
    thread_id: THREAD,
    tool_call_id: "tc_9",
    tool: "mcp__jira__create_issue",
    input: { project: "OPS" },
  },
  "command.result ok": {
    v: 1,
    type: "command.result",
    command_id: "c1",
    ok: true,
    data: { entries: [], leafId: null },
  },
  "command.result error": {
    v: 1,
    type: "command.result",
    command_id: "c1",
    ok: false,
    error: { code: "pi_rejected", message: "no" },
  },
  "pi.exited": {
    v: 1,
    type: "pi.exited",
    thread_id: THREAD,
    exit_code: 1,
    signal: null,
    stderr_tail: "boom",
  },
  ping: { v: 1, type: "ping", nonce: "n1" },
  error: { v: 1, type: "error", code: "unknown_run", message: "?", ref: "c1" },
  "error run_not_active": { v: 1, type: "error", code: "run_not_active", message: "run ended" },
} satisfies Record<string, SandboxToServerFrame>;

const serverFrames = {
  "hello.ack": {
    v: 1,
    type: "hello.ack",
    connection_id: "conn_1",
    server_time: "2026-10-01T22:00:00Z",
    heartbeat_interval_ms: 15000,
    runs: [{ run_id: RUN, thread_id: THREAD, durable_seq: 10 }],
  },
  "run.start": {
    v: 1,
    type: "run.start",
    command_id: "c1",
    run_id: RUN,
    thread_id: THREAD,
    message: "Chart this CSV",
    attachments: [{ path: "/workspace/uploads/th1/sales.csv", mime_type: "text/csv" }],
    config: {
      model: {
        alias: "smart",
        gateway_model: "anthropic/claude-sonnet-4-5",
        api: "anthropic-messages",
      },
      agent: null,
      mcp_servers: [{ name: "jira", connector_id: EXAMPLE_IDS.connector }],
      approval_mode: "ask-on-write",
    },
  },
  "run.steer": {
    v: 1,
    type: "run.steer",
    command_id: "c2",
    run_id: RUN,
    thread_id: THREAD,
    message: "bar chart",
  },
  "run.stop": {
    v: 1,
    type: "run.stop",
    command_id: "c3",
    run_id: RUN,
    thread_id: THREAD,
    mode: "after_step",
    reason: "budget_exhausted",
  },
  "pi.command": {
    v: 1,
    type: "pi.command",
    command_id: "c4",
    thread_id: THREAD,
    command: { id: "c4", type: "get_entries", since: "a1b2c3d4" },
  },
  "pi.ui_response": {
    v: 1,
    type: "pi.ui_response",
    thread_id: THREAD,
    response: { type: "extension_ui_response", id: "u1", cancelled: true },
  },
  "policy.pending": {
    v: 1,
    type: "policy.pending",
    request_id: "pc_1",
    run_id: RUN,
    tool_call_id: "tc_9",
    approval_id: EXAMPLE_IDS.approval,
    expires_at: "2026-10-01T23:00:00Z",
  },
  "policy.result allow": {
    v: 1,
    type: "policy.result",
    request_id: "pc_1",
    run_id: RUN,
    tool_call_id: "tc_9",
    decision: "allow",
    reasons,
    approval: token,
  },
  "policy.result deny": {
    v: 1,
    type: "policy.result",
    request_id: "pc_1",
    run_id: RUN,
    tool_call_id: "tc_9",
    decision: "deny",
    reasons,
    message: "Denied by team policy",
  },
  "session.restore": {
    v: 1,
    type: "session.restore",
    command_id: "c5",
    thread_id: THREAD,
    part: 0,
    final: true,
    header: {
      type: "session",
      version: 3,
      id: "uuid",
      timestamp: "2026-10-01T22:00:00Z",
      cwd: "/workspace",
    },
    entries: [
      {
        type: "message",
        id: "a1b2c3d4",
        parentId: null,
        timestamp: "2026-10-01T22:00:00Z",
        message: { role: "user" },
      },
    ],
  },
  ack: { v: 1, type: "ack", run_id: RUN, seq: 13 },
  resend: { v: 1, type: "resend", run_id: RUN, from_seq: 11 },
  shutdown: { v: 1, type: "shutdown", reason: "hibernate", deadline_ms: 5000 },
  pong: { v: 1, type: "pong", nonce: "n1" },
} satisfies Record<string, ServerToSandboxFrame>;

describe("sandbox → server frames", () => {
  it.each(Object.entries(sandboxFrames))("accepts %s", (_name, frame) => {
    expect(decodeSandboxFrame(encodeFrame(frame))).toEqual({ ok: true, frame });
  });

  it.each([
    ["wrong version", { ...sandboxFrames.ping, v: 2 }],
    ["unknown type", { v: 1, type: "pi.raw", line: "{}" }],
    ["extra key", { ...sandboxFrames.ping, token: "secret" }],
    ["seq 0", { ...sandboxFrames["pi.event"], seq: 0 }],
    ["non-uuid run id", { ...sandboxFrames["pi.event"], run_id: "run_7f" }],
    ["array tool input", { ...sandboxFrames["policy.check"], input: [] }],
    [
      "sandbox-claimed tool annotations",
      {
        ...sandboxFrames["policy.check"],
        tool: { name: "bash", source: "pi", annotations: { readOnlyHint: true } },
      },
    ],
    ["server-only frame", serverFrames["policy.result allow"]],
  ])("rejects %s", (_name, frame) => {
    expect(decodeSandboxFrame(JSON.stringify(frame))).toMatchObject({
      ok: false,
      code: "malformed_frame",
    });
  });

  it("rejects duplicate keys, U+0000 and __proto__ keys anywhere in the text", () => {
    const check = JSON.stringify(sandboxFrames["policy.check"]);
    const duplicate = check.replace(
      '"input":{"project":"OPS"}',
      '"input":{"project":"OPS","project":"PROD"}',
    );
    const nul = check.replace('"OPS"', '"O\\u0000PS"');
    const proto = check.replace('{"project":"OPS"}', '{"__proto__":{"admin":true}}');
    for (const [text, issue] of [
      [duplicate, "duplicate_key"],
      [nul, "nul_character"],
      [proto, "proto_key"],
    ] as const) {
      expect(decodeSandboxFrame(text)).toEqual({
        ok: false,
        code: "malformed_frame",
        message: `frame rejected: ${issue}`,
      });
    }
  });

  it("never throws on hostile shapes under the size cap (flat or deeply nested)", () => {
    const check = JSON.stringify(sandboxFrames["policy.check"]);
    const flat = check.replace('{"project":"OPS"}', `{"a":[${"0,".repeat(1_500_000)}0]}`);
    const deep = check.replace(
      '{"project":"OPS"}',
      `{"a":${"[".repeat(200_000)}${"]".repeat(200_000)}}`,
    );
    const deepObject = check.replace(
      '{"project":"OPS"}',
      `${'{"a":'.repeat(150)}1${"}".repeat(150)}`,
    );
    expect(new TextEncoder().encode(flat).byteLength).toBeLessThan(SANDBOX_MAX_FRAME_BYTES);
    expect(decodeSandboxFrame(flat)).toMatchObject({ ok: true });
    expect(decodeSandboxFrame(deep)).toEqual({
      ok: false,
      code: "malformed_frame",
      message: "frame rejected: too_deep",
    });
    expect(decodeSandboxFrame(deepObject)).toMatchObject({ ok: false, code: "malformed_frame" });
    expect(decodeServerFrame(deep)).toMatchObject({ ok: false, code: "malformed_frame" });
  });

  it("rejects malformed JSON and oversize frames", () => {
    expect(decodeSandboxFrame("{nope")).toMatchObject({ ok: false, code: "malformed_frame" });
    const big = JSON.stringify({
      ...sandboxFrames.error,
      message: "x".repeat(SANDBOX_MAX_FRAME_BYTES),
    });
    expect(decodeSandboxFrame(big)).toMatchObject({ ok: false, code: "frame_too_large" });
  });

  it("passes unknown fields inside bridged Pi records through", () => {
    const frame = {
      ...sandboxFrames["pi.event"],
      event: { type: "future_event", extra: { a: 1 } },
    };
    expect(decodeSandboxFrame(JSON.stringify(frame))).toEqual({ ok: true, frame });
  });
});

describe("server → sandbox frames", () => {
  it.each(Object.entries(serverFrames))("accepts %s", (_name, frame) => {
    expect(decodeServerFrame(encodeFrame(frame))).toEqual({ ok: true, frame });
  });

  const config = serverFrames["run.start"].config;
  it.each([
    [
      "bash through pi.command",
      { ...serverFrames["pi.command"], command: { id: "c4", type: "bash", command: "id" } },
    ],
    [
      "prompt through pi.command",
      { ...serverFrames["pi.command"], command: { id: "c4", type: "prompt", message: "x" } },
    ],
    [
      "switch_session",
      {
        ...serverFrames["pi.command"],
        command: { id: "c4", type: "switch_session", sessionPath: "/etc" },
      },
    ],
    [
      "require_approval reaching the sandbox",
      { ...serverFrames["policy.result deny"], decision: "require_approval" },
    ],
    [
      "allow with a bad token",
      { ...serverFrames["policy.result allow"], approval: { ...token, mac: "x" } },
    ],
    ["deny without a message", { ...serverFrames["policy.result deny"], message: undefined }],
    ["unknown stop mode", { ...serverFrames["run.stop"], mode: "kill" }],
    [
      "session entry without id",
      {
        ...serverFrames["session.restore"],
        entries: [{ type: "message", parentId: null, timestamp: "x" }],
      },
    ],
    [
      "an MCP server URL",
      {
        ...serverFrames["run.start"],
        config: { ...config, mcp_servers: [{ name: "jira", url: "https://evil.example" }] },
      },
    ],
    [
      "a model provider/base URL",
      {
        ...serverFrames["run.start"],
        config: { ...config, model: { alias: "smart", base_url: "https://x" } },
      },
    ],
    [
      "a gateway model without its gateway provider",
      {
        ...serverFrames["run.start"],
        config: {
          ...config,
          model: { alias: "smart", gateway_model: "claude", api: "anthropic-messages" },
        },
      },
    ],
    [
      "a model API style Pi does not have",
      {
        ...serverFrames["run.start"],
        config: { ...config, model: { alias: "smart", gateway_model: "x/y", api: "custom" } },
      },
    ],
    [
      "unknown config keys",
      { ...serverFrames["run.start"], config: { ...config, env: { KEY: "v" } } },
    ],
    [
      "an oversize system prompt",
      { ...serverFrames["run.start"], config: { ...config, system_prompt: "x".repeat(100_001) } },
    ],
    [
      "an ambiguous connector name",
      {
        ...serverFrames["run.start"],
        config: { ...config, mcp_servers: [{ name: "a__b", connector_id: EXAMPLE_IDS.connector }] },
      },
    ],
    [
      "a path-like skill name",
      { ...serverFrames["run.start"], config: { ...config, skills: ["../etc"] } },
    ],
  ])("rejects %s", (_name, frame) => {
    expect(decodeServerFrame(JSON.stringify(frame))).toMatchObject({
      ok: false,
      code: "malformed_frame",
    });
  });
});

describe("translated Pi events", () => {
  it.each([
    [{ type: "agent_settled" }],
    [{ type: "message_start", message: { role: "assistant", content: [] } }],
    [
      {
        type: "message_update",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { total: 0 },
        },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" },
      },
    ],
    [
      {
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "bash",
        args: { command: "ls" },
      },
    ],
    [
      {
        type: "tool_execution_end",
        toolCallId: "call_1",
        toolName: "bash",
        result: {},
        isError: false,
      },
    ],
    [
      {
        type: "entry_appended",
        entry: { type: "custom", id: "abcd1234", parentId: null, timestamp: "t" },
      },
    ],
  ])("accepts %j", (event) => {
    expect(parseTranslatedPiEvent(event).kind).toBe("translated");
  });

  it.each([
    [
      {
        type: "message_update",
        usage: {},
        assistantMessageEvent: { type: "text_delta", contentIndex: 0 },
      },
    ],
    [
      {
        type: "message_update",
        usage: { input: 1 },
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
      },
    ],
    [{ type: "tool_execution_end", toolCallId: "", toolName: "bash", isError: false }],
    [
      {
        type: "entry_appended",
        entry: { type: "custom", id: "x".repeat(129), parentId: null, timestamp: "t" },
      },
    ],
  ])("flags %j as invalid", (event) => {
    expect(parseTranslatedPiEvent(event).kind).toBe("invalid");
  });

  it("ignores event types the server does not translate", () => {
    expect(parseTranslatedPiEvent({ type: "queue_update" })).toEqual({ kind: "ignored" });
  });

  it("validates get_entries data before mirroring", () => {
    const entry = { type: "message", id: "a1b2c3d4", parentId: null, timestamp: "t", message: {} };
    expect(piGetEntriesDataSchema.safeParse({ entries: [entry], leafId: "a1b2c3d4" }).success).toBe(
      true,
    );
    expect(
      piGetEntriesDataSchema.safeParse({ entries: [{ ...entry, id: "" }], leafId: null }).success,
    ).toBe(false);
    expect(piGetEntriesDataSchema.safeParse({ entries: [entry] }).success).toBe(false);
  });
});

describe("contracts cleanup (agent-reported gaps)", () => {
  it("does not admit fork in pi.command (it moves Pi off the thread's session file)", () => {
    const frame = {
      v: 1,
      type: "pi.command",
      command_id: "c1",
      thread_id: THREAD,
      command: { id: "x", type: "fork", entryId: "a1" },
    };
    expect(decodeServerFrame(JSON.stringify(frame))).toMatchObject({ ok: false });
    expect(
      decodeServerFrame(
        JSON.stringify({ ...frame, command: { id: "x", type: "get_fork_messages" } }),
      ),
    ).toMatchObject({ ok: true });
  });

  it("describes the kobe.event_dropped placeholder, which the translator ignores", () => {
    const placeholder = {
      type: KOBE_EVENT_DROPPED_TYPE,
      original_type: "message_update",
      reason: "frame_too_large",
    };
    expect(kobeEventDroppedSchema.parse(placeholder)).toEqual(placeholder);
    expect(parseTranslatedPiEvent(placeholder)).toEqual({ kind: "ignored" });
    expect(
      decodeSandboxFrame(
        JSON.stringify({
          v: 1,
          type: "pi.event",
          run_id: RUN,
          thread_id: THREAD,
          seq: 1,
          event: placeholder,
        }),
      ),
    ).toMatchObject({ ok: true });
  });

  it("states the per-type frame caps (only pi.event, command.result and policy.check are large)", () => {
    expect(SANDBOX_SMALL_FRAME_MAX_BYTES).toBe(256 * 1024);
    expect(SANDBOX_FRAME_MAX_BYTES_BY_TYPE).toEqual({
      "pi.event": SANDBOX_MAX_FRAME_BYTES,
      "command.result": SANDBOX_MAX_FRAME_BYTES,
      "policy.check": 1024 * 1024,
    });
  });
});

describe("forward compatibility (server → sandbox)", () => {
  const result = (extra: Record<string, unknown>) =>
    JSON.stringify({
      v: 1,
      type: "policy.result",
      request_id: "r1",
      run_id: RUN,
      tool_call_id: "tc_1",
      decision: "allow",
      reasons: [{ code: "a_code_from_the_future", stage: "a_future_stage", message: "m" }],
      ...extra,
    });

  it("decodes informational enums it does not know (reason codes and stages, extra reason keys)", () => {
    const decoded = decodeServerFrame(result({}));
    expect(decoded).toMatchObject({ ok: true, frame: { decision: "allow" } });
    expect(
      decodeServerFrame(
        result({ reasons: [{ code: "new_code", stage: "risk_class", message: "m", hint: "x" }] }),
      ),
    ).toMatchObject({ ok: true });
    for (const frame of [
      { v: 1, type: "error", code: "a_new_error", message: "m" },
      { v: 1, type: "shutdown", reason: "a_new_reason", deadline_ms: 0 },
      {
        v: 1,
        type: "run.stop",
        command_id: "c",
        run_id: RUN,
        thread_id: THREAD,
        mode: "abort",
        reason: "a_new_reason",
      },
    ]) {
      expect(decodeServerFrame(JSON.stringify(frame)), frame.type).toMatchObject({ ok: true });
    }
  });

  it("keeps decisions, modes and code shapes closed", () => {
    expect(decodeServerFrame(result({ decision: "maybe" }))).toMatchObject({ ok: false });
    expect(
      decodeServerFrame(
        result({ reasons: [{ code: "Not A Code!", stage: "risk_class", message: "m" }] }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      decodeServerFrame(
        JSON.stringify({
          v: 1,
          type: "run.stop",
          command_id: "c",
          run_id: RUN,
          thread_id: THREAD,
          mode: "later",
          reason: "user_cancelled",
        }),
      ),
    ).toMatchObject({ ok: false });
  });

  it("keeps sandbox → server frames strict (the server is never older than its sandboxes' contract)", () => {
    expect(
      decodeSandboxFrame(
        JSON.stringify({ v: 1, type: "error", code: "a_new_error", message: "m" }),
      ),
    ).toMatchObject({ ok: false });
  });
});
