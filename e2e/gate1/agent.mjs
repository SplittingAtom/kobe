// Gate 1 (KOBE-1) scripted sandbox agent. No model answers in a sandbox yet (Bifrost and Pi's
// model wiring are KOBE-40/41), so real Pi cannot stream an answer. This stands in for the
// sandbox side only: it holds real sandbox identities (live claims + wire tokens signed with the
// install's keys, e2e/gate1.sh), speaks the real wire frames from a gVisor pod in the team's
// namespace, and streams an answer for each run.start as Pi would (deltas, then the entries the
// server mirrors). Everything from the wire inwards (routing, translation, batching, the event
// log, the stream, resume) is the real server.
//
// Env: KOBE_WIRE_URL, GATE1_IDENTITIES (JSON [{key, token, sandboxId}]), GATE1_WORDS (answer
// length), GATE1_DELTA_MS (pace), GATE1_SETTLE ("false": stop after the first turn and never
// settle, so the run stays running until the pod is killed).
const { default: WebSocket } = await import("/app/node_modules/ws/wrapper.mjs");
const { randomBytes } = await import("node:crypto");

const url = process.env.KOBE_WIRE_URL;
const identities = JSON.parse(process.env.GATE1_IDENTITIES ?? "[]");
const words = Number(process.env.GATE1_WORDS ?? "40");
const deltaMs = Number(process.env.GATE1_DELTA_MS ?? "100");
const settle = process.env.GATE1_SETTLE !== "false";
const log = (line) => console.log(line);
const hex = () => randomBytes(4).toString("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { total: 0 },
};

/** Must match expectedReply in client.mjs. */
const reply = (prompt) =>
  [`Reply to ${prompt}:`, ...Array.from({ length: words }, (_, i) => `w${i + 1}`)].join(" ");

const open = (identity) =>
  new Promise((resolve) => {
    const ws = new WebSocket(url, ["kobe.sandbox.v1"], {
      headers: { Authorization: "Bearer " + identity.token },
      perMessageDeflate: false,
    });
    ws.once("open", () => resolve(ws));
    ws.once("unexpected-response", (_req, res) => {
      log(`${identity.key} refused=${res.statusCode}`);
      resolve(undefined);
    });
    ws.once("error", () => resolve(undefined));
  });
async function serve(identity) {
  let ws;
  for (let i = 0; i < 180 && !ws; i += 1) {
    ws = await open(identity); // the CNI admits a new pod after a delay
    if (!ws) await sleep(1000);
  }
  if (!ws) {
    log(`${identity.key} connect=failed`);
    return;
  }
  const sessions = new Map();
  const seqs = new Map();
  const send = (frame) => ws.send(JSON.stringify({ v: 1, ...frame }));
  const ok = (commandId, data) =>
    send({
      type: "command.result",
      command_id: commandId,
      ok: true,
      ...(data === undefined ? {} : { data }),
    });
  const event = (start, ev) => {
    const seq = (seqs.get(start.run_id) ?? 0) + 1;
    seqs.set(start.run_id, seq);
    send({ type: "pi.event", run_id: start.run_id, thread_id: start.thread_id, seq, event: ev });
  };
  async function runStart(f) {
    ok(f.command_id);
    const now = new Date().toISOString();
    const s = sessions.get(f.thread_id) ?? [];
    if (s.length === 0) {
      s.push({
        type: "thinking_level_change",
        id: hex(),
        parentId: null,
        timestamp: now,
        thinkingLevel: "off",
      });
    }
    const text = reply(f.message);
    const user = {
      type: "message",
      id: hex(),
      parentId: f.parent_entry_id ?? s.at(-1).id,
      timestamp: now,
      message: { role: "user", content: f.message },
    };
    const answer = {
      type: "message",
      id: hex(),
      parentId: user.id,
      timestamp: now,
      message: { role: "assistant", content: [{ type: "text", text }] },
    };
    sessions.set(f.thread_id, [...s, user, answer]);
    event(f, { type: "agent_start" });
    event(f, { type: "message_start", message: { role: "assistant" } });
    const parts = text.split(/(?= )/);
    for (const [i, delta] of parts.entries()) {
      event(f, {
        type: "message_update",
        usage,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
      });
      // Without settling: the first turn is mirrored early, then the answer keeps streaming.
      if (!settle && i === 2) event(f, { type: "turn_end", message: { role: "assistant" } });
      await sleep(deltaMs);
    }
    if (!settle) {
      log(`${identity.key} streamed=${f.run_id}`);
      return;
    }
    event(f, { type: "message_end", message: { role: "assistant" } });
    event(f, { type: "turn_end", message: { role: "assistant" } });
    event(f, { type: "agent_settled" });
    log(`${identity.key} settled=${f.run_id}`);
  }
  ws.on("close", (code) => log(`${identity.key} closed=${code}`));
  ws.on("message", (raw) => {
    const f = JSON.parse(raw.toString());
    if (f.type === "hello.ack") log(`${identity.key} ready`);
    else if (f.type === "ping") send({ type: "pong", nonce: f.nonce });
    else if (f.type === "pi.command" && f.command.type === "get_entries") {
      const s = sessions.get(f.thread_id) ?? [];
      const since = f.command.since;
      const at = since === undefined ? -1 : s.findIndex((e) => e.id === since);
      if (since !== undefined && at < 0) {
        send({
          type: "command.result",
          command_id: f.command_id,
          ok: false,
          error: { code: "pi_rejected", message: "Entry not found" },
        });
      } else ok(f.command_id, { entries: s.slice(at + 1), leafId: s.at(-1)?.id ?? null });
    } else if (f.type === "run.start") {
      log(`${identity.key} started=${f.run_id}`);
      void runStart(f);
    } else if (typeof f.command_id === "string") ok(f.command_id);
  });
  send({
    type: "hello",
    sandbox_id: identity.sandboxId,
    agent_version: "gate1-scripted",
    pi_version: "1.0.0",
    runs: [],
  });
}

for (const identity of identities) await serve(identity);
// Stay up: the pod is deleted by the suite (or killed mid-run on purpose).
setInterval(() => {}, 60_000);
