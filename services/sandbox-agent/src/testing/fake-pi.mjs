#!/usr/bin/env node
// Scripted stand-in for `pi --mode rpc` (Pi 1.0.0 record shapes). Behaviour is chosen by the prompt
// text, because the agent gives Pi an allow-listed environment only:
//   "say:<text>"   stream <text> as two text_delta updates, then settle
//   "hang"         start a run and wait for abort
//   "steps"        emit turn_end every 50 ms until aborted
//   "late-steps"   answer the prompt, emit agent_start only 200 ms later, then as "steps"
//   "tool:<name>"  ask kobe-policy over fd 3 and report the decision as a custom event
//   "dialog"       open a confirm dialog and report the answer
//   "crash"        write to stderr and exit 3
//   "big"          emit one event larger than the wire frame cap
//   "dirty"        emit an event with U+0000 and a __proto__ key
//   "reject"       answer the prompt with success:false
//   "grandchild"   spawn a tool the way Pi's bash tool does and report what it can see of fd 3
//   "orphan"       spawn a detached long-running tool (its own process group), report its pid, hang
//   "handled"      answer the prompt with disposition "handled"
//   "drop-policy"  close its end of the policy channel (as a broken kobe-policy would), then settle
//   "sh:<command>" run `/bin/sh -c <command>` the way Pi's bash tool does (detached) and report its
//                  exit code, stdout and stderr as a kobe_test_shell event (KOBE-71 identity tests)
// Every command received is appended to <session file>.commands.jsonl for assertions.
// It also plays kobe-policy's side of the fd-3 handshake: on channel.hello it answers channel.ready,
// unless the last --extension path contains "refuse" (channel.refused) or "silent" (no answer).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import net from "node:net";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("1.0.0\n");
  process.exit(0);
}
const sessionFile = args[args.indexOf("--session") + 1];
const log = `${sessionFile}.commands.jsonl`;
const out = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const respond = (cmd, extra) => out({ id: cmd.id, type: "response", command: cmd.type, ...extra });
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { total: 0 },
};
appendFileSync(
  log,
  `${JSON.stringify({
    argv: args,
    env: Object.keys(process.env).sort(),
    // KOBE-41: where the agent put this process's config dir and model file (values, test-only).
    agentDir: process.env.PI_CODING_AGENT_DIR ?? null,
    modelFile: process.env.KOBE_MODEL_FILE ?? null,
    // KOBE-39: the egress wiring Pi's bash tool calls see (no token among these).
    egressTokenFile: process.env.KOBE_EGRESS_TOKEN_FILE ?? null,
    bashEnv: process.env.BASH_ENV ?? null,
    egressProxy: process.env.KOBE_EGRESS_PROXY ?? null,
    threadId: process.env.KOBE_THREAD_ID ?? null,
    // KOBE-71: who this Pi runs as, and its HOME/TMPDIR.
    pid: process.pid,
    uid: process.getuid?.() ?? null,
    gid: process.getgid?.() ?? null,
    groups: process.getgroups?.() ?? null,
    home: process.env.HOME ?? null,
    tmpdir: process.env.TMPDIR ?? null,
  })}\n`,
);

let streaming = false;
let aborted = false;
let timer;
const dialogs = new Map();
const policy = new Map();
let policySocket;
let policyNonce;
let nextPolicy = 1;

let policyFdIno = null;
if (process.env.KOBE_POLICY_FD) {
  policyFdIno = (await import("node:fs")).fstatSync(Number(process.env.KOBE_POLICY_FD)).ino;
  policySocket = new net.Socket({
    fd: Number(process.env.KOBE_POLICY_FD),
    readable: true,
    writable: true,
  });
  let buffer = "";
  policySocket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let lf;
    while ((lf = buffer.indexOf("\n")) !== -1) {
      const reply = JSON.parse(buffer.slice(0, lf));
      buffer = buffer.slice(lf + 1);
      if (reply.type === "channel.hello") {
        policyNonce = reply.nonce;
        answerHello();
        continue;
      }
      out({ type: "kobe_test_policy_reply", reply });
      if (reply.type === "policy.result") policy.get(reply.request_id)?.(reply);
    }
  });
  policySocket.on("error", () => undefined);
}

function answerHello() {
  const extensions = args.flatMap((a, i) => (a === "--extension" ? [args[i + 1]] : []));
  const policyPath = extensions.at(-1) ?? "";
  if (policyPath.includes("silent")) return;
  const message = policyPath.includes("refuse")
    ? { type: "channel.refused", nonce: policyNonce, reason: "fake refusal" }
    : { type: "channel.ready", nonce: policyNonce, extension: "kobe-policy", version: 1 };
  policySocket.write(`${JSON.stringify(message)}\n`);
}

function start() {
  streaming = true;
  aborted = false;
  out({ type: "agent_start" });
}
function settle() {
  clearInterval(timer);
  streaming = false;
  out({ type: "agent_end", messages: [] });
  out({ type: "agent_settled" });
}
function textDelta(delta) {
  out({
    type: "message_update",
    usage,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
  });
}

function runPrompt(message) {
  if (message.startsWith("say:")) {
    const text = message.slice(4).split("\n")[0];
    start();
    setTimeout(() => {
      textDelta(text.slice(0, 2));
      textDelta(text.slice(2));
      out({ type: "turn_end", message: { role: "assistant" } });
      settle();
    }, 10);
  } else if (message === "hang") {
    start();
  } else if (message === "steps" || message === "late-steps") {
    const steps = () => {
      start();
      timer = setInterval(() => {
        appendFileSync(log, `${JSON.stringify({ emitted: "turn_end" })}\n`);
        out({ type: "turn_end", message: { role: "assistant" } });
      }, 50);
    };
    if (message === "steps") steps();
    else setTimeout(steps, 200);
  } else if (message.startsWith("tool:")) {
    start();
    const requestId = `ext-${nextPolicy++}`;
    policy.set(requestId, (reply) => {
      out({ type: "kobe_test_policy_decision", decision: reply.decision });
      settle();
    });
    policySocket.write(
      `${JSON.stringify({ type: "policy.check", nonce: policyNonce, request_id: requestId, tool_call_id: "call_1", tool: message.slice(5), input: { command: "ls" } })}\n`,
    );
  } else if (message === "dialog") {
    start();
    dialogs.set("ui-1", (answer) => {
      out({ type: "kobe_test_dialog_answer", answer });
      settle();
    });
    out({
      type: "extension_ui_request",
      id: "ui-1",
      method: "confirm",
      title: "Sure?",
      message: "x",
    });
  } else if (message === "grandchild" || message === "grandchild-inherit") {
    start();
    // Like Pi's bash tool: spawn(..., { stdio: ["pipe","pipe","pipe"], detached: true }).
    const probe = `
      const fs = require("node:fs");
      const r = {};
      try { r.fd3Ino = fs.fstatSync(3).ino; } catch { r.fd3Ino = null; }
      try { fs.writeSync(3, '{"type":"policy.check","request_id":"forged"}\\n'); r.fd3Write = true; } catch { r.fd3Write = false; }
      try { fs.closeSync(fs.openSync("/proc/" + process.ppid + "/fd/3", "r+")); r.procOpen = true; } catch { r.procOpen = false; }
      r.env = Object.keys(process.env).filter((k) => k.startsWith("KOBE_")).sort();
      process.stdout.write(JSON.stringify(r));`;
    // Control: "grandchild-inherit" hands fd 3 over explicitly, proving the probe detects it.
    const stdio = message === "grandchild" ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", 3];
    const child = spawn(process.execPath, ["-e", probe], { stdio, detached: true });
    let text = "";
    child.stdout.on("data", (d) => (text += d));
    child.on("exit", () => {
      const probed = JSON.parse(text);
      out({ type: "kobe_test_grandchild", sameChannel: probed.fd3Ino === policyFdIno, ...probed });
      settle();
    });
  } else if (message.startsWith("sh:")) {
    start();
    const child = spawn("/bin/sh", ["-c", message.slice(3)], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      out({ type: "kobe_test_shell", code, stdout, stderr });
      settle();
    });
  } else if (message === "orphan") {
    start();
    const child = spawn("sleep", ["300"], { stdio: "ignore", detached: true });
    out({ type: "kobe_test_orphan", pid: child.pid });
  } else if (message === "drop-policy") {
    start();
    policySocket?.destroy();
    setTimeout(settle, 50);
  } else if (message === "crash") {
    process.stderr.write("fatal: something broke\n");
    process.exit(3);
  } else if (message === "big") {
    start();
    out({
      type: "tool_execution_update",
      toolCallId: "c",
      toolName: "bash",
      partial: "x".repeat(5 * 1024 * 1024),
    });
    settle();
  } else if (message === "dirty") {
    start();
    process.stdout.write(
      '{"type":"custom_dirty","text":"a\\u0000b","nested":{"__proto__":{"admin":true},"ok":1}}\n',
    );
    settle();
  } else {
    start();
    settle();
  }
}

function entries() {
  if (!existsSync(sessionFile)) return [];
  return readFileSync(sessionFile, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l))
    .filter((r) => r.type !== "session");
}

function handle(cmd) {
  switch (cmd.type) {
    case "prompt": {
      if (cmd.message === "reject")
        return respond(cmd, { success: false, error: "No API key found" });
      if (cmd.message === "handled")
        return respond(cmd, { success: true, data: { disposition: "handled" } });
      if (streaming && !cmd.streamingBehavior)
        return respond(cmd, { success: false, error: "streaming" });
      respond(cmd, { success: true, data: { disposition: "started" } });
      return runPrompt(cmd.message);
    }
    case "steer":
      return respond(cmd, { success: true, data: { disposition: "queued" } });
    case "clear_queue":
      return respond(cmd, { success: true, data: { steering: [], followUp: [] } });
    case "abort":
      if (streaming && !aborted) {
        aborted = true;
        settle();
      }
      return respond(cmd, { success: true });
    case "get_state":
      return respond(cmd, { success: true, data: { sessionFile, isStreaming: streaming } });
    case "get_entries": {
      const all = entries();
      const leafId = all.at(-1)?.id ?? null;
      if (cmd.since === undefined)
        return respond(cmd, { success: true, data: { entries: all, leafId } });
      const index = all.findIndex((e) => e.id === cmd.since);
      if (index === -1)
        return respond(cmd, { success: false, error: `Entry not found: ${cmd.since}` });
      return respond(cmd, { success: true, data: { entries: all.slice(index + 1), leafId } });
    }
    case "get_session_stats":
      process.stderr.write("idle crash\n");
      return process.exit(4);
    case "get_tree":
      return respond(cmd, { success: true, data: { tree: [], huge: "y".repeat(5 * 1024 * 1024) } });
    default:
      return respond(cmd, { success: false, error: `unsupported in fake: ${cmd.type}` });
  }
}

let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk.toString("utf8");
  let lf;
  while ((lf = input.indexOf("\n")) !== -1) {
    const line = input.slice(0, lf);
    input = input.slice(lf + 1);
    appendFileSync(log, `${line}\n`);
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      out({ type: "response", command: "parse", success: false, error: "parse" });
      continue;
    }
    if (record.type === "extension_ui_response") {
      dialogs.get(record.id)?.(record);
      dialogs.delete(record.id);
      continue;
    }
    handle(record);
  }
});
process.stdin.on("end", () => {
  policySocket?.destroy();
  process.exit(0);
});
