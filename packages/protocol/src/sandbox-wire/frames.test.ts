import { describe, expect, it } from "vitest";
import {
  SANDBOX_MAX_FRAME_BYTES,
  decodeSandboxFrame,
  decodeServerFrame,
  encodeFrame,
  type ApprovalToken,
  type PolicyReason,
  type SandboxToServerFrame,
  type ServerToSandboxFrame,
} from "../index.js";

const reasons: PolicyReason[] = [{ code: "risk_write", stage: "risk_class", message: "write" }];
const token: ApprovalToken = {
  v: 1,
  alg: "HS256",
  kid: "k1",
  approval_id: "apr_31",
  run_id: "run_7f",
  tool_call_id: "tc_9",
  mac: "EeUcBxYfh-SRKr2AObnPe6oYfXEpKLxZMlgtpnuLOiU",
};

const sandboxFrames = {
  hello: {
    v: 1,
    type: "hello",
    sandbox_id: "sbx_1",
    agent_version: "0.1.0",
    pi_version: "1.0.0",
    runs: [{ run_id: "run_7f", thread_id: "th1", last_seq: 12 }],
  },
  "pi.event": {
    v: 1,
    type: "pi.event",
    run_id: "run_7f",
    thread_id: "th1",
    seq: 13,
    event: {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" },
    },
  },
  "pi.ui_request": {
    v: 1,
    type: "pi.ui_request",
    thread_id: "th1",
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
    run_id: "run_7f",
    thread_id: "th1",
    tool_call_id: "tc_9",
    tool: { name: "mcp__jira__create_issue", source: "mcp", annotations: { readOnlyHint: false } },
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
    thread_id: "th1",
    exit_code: 1,
    signal: null,
    stderr_tail: "boom",
  },
  ping: { v: 1, type: "ping", nonce: "n1" },
  error: { v: 1, type: "error", code: "unknown_run", message: "?", ref: "c1" },
} satisfies Record<string, SandboxToServerFrame>;

const serverFrames = {
  "hello.ack": {
    v: 1,
    type: "hello.ack",
    connection_id: "conn_1",
    server_time: "2026-10-01T22:00:00Z",
    heartbeat_interval_ms: 15000,
    runs: [{ run_id: "run_7f", thread_id: "th1", durable_seq: 10 }],
  },
  "run.start": {
    v: 1,
    type: "run.start",
    command_id: "c1",
    run_id: "run_7f",
    thread_id: "th1",
    message: "Chart this CSV",
    attachments: [{ path: "/workspace/uploads/th1/sales.csv", mime_type: "text/csv" }],
    config: { model: { provider: "bifrost", model_id: "smart" }, approval_mode: "ask-on-write" },
  },
  "run.steer": {
    v: 1,
    type: "run.steer",
    command_id: "c2",
    run_id: "run_7f",
    thread_id: "th1",
    message: "bar chart",
  },
  "run.stop": {
    v: 1,
    type: "run.stop",
    command_id: "c3",
    run_id: "run_7f",
    thread_id: "th1",
    mode: "after_step",
    reason: "budget_exhausted",
  },
  "pi.command": {
    v: 1,
    type: "pi.command",
    command_id: "c4",
    thread_id: "th1",
    command: { id: "c4", type: "get_entries", since: "a1b2c3d4" },
  },
  "pi.ui_response": {
    v: 1,
    type: "pi.ui_response",
    thread_id: "th1",
    response: { type: "extension_ui_response", id: "u1", cancelled: true },
  },
  "policy.pending": {
    v: 1,
    type: "policy.pending",
    request_id: "pc_1",
    run_id: "run_7f",
    tool_call_id: "tc_9",
    approval_id: "apr_31",
    expires_at: "2026-10-01T23:00:00Z",
  },
  "policy.result allow": {
    v: 1,
    type: "policy.result",
    request_id: "pc_1",
    run_id: "run_7f",
    tool_call_id: "tc_9",
    decision: "allow",
    reasons,
    approval: token,
  },
  "policy.result deny": {
    v: 1,
    type: "policy.result",
    request_id: "pc_1",
    run_id: "run_7f",
    tool_call_id: "tc_9",
    decision: "deny",
    reasons,
    message: "Denied by team policy",
  },
  "session.restore": {
    v: 1,
    type: "session.restore",
    command_id: "c5",
    thread_id: "th1",
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
  ack: { v: 1, type: "ack", run_id: "run_7f", seq: 13 },
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
    ["array tool input", { ...sandboxFrames["policy.check"], input: [] }],
    [
      "unknown tool source",
      { ...sandboxFrames["policy.check"], tool: { name: "x", source: "shell" } },
    ],
    ["server-only frame", serverFrames["policy.result allow"]],
  ])("rejects %s", (_name, frame) => {
    expect(decodeSandboxFrame(JSON.stringify(frame))).toMatchObject({
      ok: false,
      code: "malformed_frame",
    });
  });

  it("rejects malformed JSON and oversize frames", () => {
    expect(decodeSandboxFrame("{nope")).toMatchObject({ ok: false, code: "malformed_frame" });
    const big = JSON.stringify({
      ...sandboxFrames.error,
      message: "x".repeat(SANDBOX_MAX_FRAME_BYTES),
    });
    expect(decodeSandboxFrame(big)).toMatchObject({ ok: false, code: "frame_too_large" });
  });
});

describe("server → sandbox frames", () => {
  it.each(Object.entries(serverFrames))("accepts %s", (_name, frame) => {
    expect(decodeServerFrame(encodeFrame(frame))).toEqual({ ok: true, frame });
  });

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
      "non-URL MCP server",
      { ...serverFrames["run.start"], config: { mcp_servers: [{ name: "jira", url: "jira" }] } },
    ],
  ])("rejects %s", (_name, frame) => {
    expect(decodeServerFrame(JSON.stringify(frame))).toMatchObject({
      ok: false,
      code: "malformed_frame",
    });
  });

  it("passes unknown fields inside bridged Pi records through", () => {
    const frame = {
      ...sandboxFrames["pi.event"],
      event: { type: "future_event", extra: { a: 1 } },
    };
    expect(decodeSandboxFrame(JSON.stringify(frame))).toEqual({ ok: true, frame });
  });
});
