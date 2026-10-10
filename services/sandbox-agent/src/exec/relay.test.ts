import { PassThrough, type Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { MAX_PENDING_REQUESTS, MAX_REQUEST_LINE_BYTES } from "../kobe-exec/protocol.js";
import { socketPair } from "../testing/socket-pair.js";
import { ExecRelay, type ExecutorHandle } from "./relay.js";

type Frame = Record<string, unknown>;

class FakeExecutor implements ExecutorHandle {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: Frame[] = [];
  killed = false;
  #exit!: (v: { code: number | null; signal: string | null }) => void;
  readonly exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    this.#exit = resolve;
  });

  constructor() {
    let buffer = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let lf = buffer.indexOf("\n"); lf !== -1; lf = buffer.indexOf("\n")) {
        this.received.push(JSON.parse(buffer.slice(0, lf)) as Frame);
        buffer = buffer.slice(lf + 1);
      }
    });
  }

  reply(frame: unknown): void {
    this.stdout.write(`${JSON.stringify(frame)}\n`);
  }

  die(code: number | null = 1, signal: string | null = null): void {
    this.#exit({ code, signal });
  }

  kill(): void {
    this.killed = true;
    this.die(null, "SIGKILL");
  }
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
  if (!check()) throw new Error("condition not met");
}

async function setup(options: { startFails?: boolean } = {}) {
  const [extensionEnd, agentEnd] = await socketPair();
  const executors: FakeExecutor[] = [];
  const diagnostics: string[] = [];
  const closed: string[] = [];
  const relay = new ExecRelay({
    channel: agentEnd as Duplex,
    startExecutor: async () => {
      if (options.startFails === true) throw new Error("no helper");
      const executor = new FakeExecutor();
      executors.push(executor);
      return executor;
    },
    onDiagnostic: (m) => diagnostics.push(m),
    onClosed: (r) => closed.push(r),
  });
  const frames: Frame[] = [];
  let buffer = "";
  extensionEnd.on("error", () => undefined);
  extensionEnd.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let lf = buffer.indexOf("\n"); lf !== -1; lf = buffer.indexOf("\n")) {
      frames.push(JSON.parse(buffer.slice(0, lf)) as Frame);
      buffer = buffer.slice(lf + 1);
    }
  });
  const send = (frame: unknown) => extensionEnd.write(`${JSON.stringify(frame)}\n`);
  return { relay, extensionEnd, executors, frames, diagnostics, closed, send };
}

const STAT = (id: string) => ({ id, op: "stat", path: "/workspace" });

describe("ExecRelay", () => {
  it("starts no executor until the first request, then relays both ways", async () => {
    const t = await setup();
    expect(t.executors).toHaveLength(0);
    t.send(STAT("ke_1"));
    await until(() => t.executors[0]?.received.length === 1);
    expect(t.executors[0]?.received[0]).toEqual(STAT("ke_1"));
    t.executors[0]?.reply({ id: "ke_1", ok: true, kind: "dir", size: 0 });
    await until(() => t.frames.length === 1);
    expect(t.frames[0]).toEqual({ id: "ke_1", ok: true, kind: "dir", size: 0 });
  });

  it("relays stream frames until the final one and then forgets the id", async () => {
    const t = await setup();
    t.send({ id: "ke_1", op: "exec", cwd: "/workspace", command: "x" });
    await until(() => t.executors[0]?.received.length === 1);
    t.executors[0]?.reply({ id: "ke_1", stream: "stdout", data: "aGk=" });
    t.executors[0]?.reply({ id: "ke_1", ok: true, exit_code: 0, signal: null });
    await until(() => t.frames.length === 2);
    // Late or invented replies are dropped.
    t.executors[0]?.reply({ id: "ke_1", stream: "stdout", data: "bGF0ZQ==" });
    t.executors[0]?.reply({ id: "never", ok: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(t.frames).toHaveLength(2);
    expect(t.diagnostics.filter((d) => d.includes("no open request"))).toHaveLength(2);
  });

  it("answers every open request with an error when the executor dies, and starts a new one next time", async () => {
    const t = await setup();
    t.send(STAT("ke_1"));
    t.send(STAT("ke_2"));
    await until(() => t.executors[0]?.received.length === 2);
    t.executors[0]?.stderr.write("boom\n");
    t.executors[0]?.die(1);
    await until(() => t.frames.length === 2);
    for (const frame of t.frames) {
      expect(frame).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect((frame.error as { message: string }).message).toContain("the tool executor exited");
    }
    t.send(STAT("ke_3"));
    await until(() => t.executors.length === 2 && t.executors[1]?.received.length === 1);
    t.executors[1]?.reply({ id: "ke_3", ok: true });
    await until(() => t.frames.length === 3);
    expect(t.closed).toEqual([]);
  });

  it("fails the request when no executor can be started", async () => {
    const t = await setup({ startFails: true });
    t.send(STAT("ke_1"));
    await until(() => t.frames.length === 1);
    expect(t.frames[0]).toMatchObject({
      id: "ke_1",
      ok: false,
      error: { code: "unavailable" },
    });
    expect((t.frames[0]?.error as { message: string }).message).toContain("no helper");
    // And again next time: it tries to start one each time, never anything else.
    t.send(STAT("ke_2"));
    await until(() => t.frames.length === 2);
    expect(t.frames[1]).toMatchObject({ id: "ke_2", ok: false });
  });

  it("forwards a cancel only when there is an executor", async () => {
    const t = await setup();
    t.send({ id: "ke_c0", op: "cancel", target: "ke_0" });
    await new Promise((r) => setTimeout(r, 30));
    expect(t.executors).toHaveLength(0);
    t.send({ id: "ke_1", op: "exec", cwd: "/workspace", command: "x" });
    await until(() => t.executors[0]?.received.length === 1);
    t.send({ id: "ke_c1", op: "cancel", target: "ke_1" });
    await until(() => t.executors[0]?.received.length === 2);
    expect(t.executors[0]?.received[1]).toMatchObject({ op: "cancel", target: "ke_1" });
  });

  it("refuses a duplicate id and too many open requests", async () => {
    const t = await setup();
    t.send(STAT("ke_1"));
    t.send(STAT("ke_1"));
    await until(() => t.frames.length === 1);
    expect(t.frames[0]).toMatchObject({ id: "ke_1", ok: false, error: { code: "invalid" } });
    for (let i = 2; i <= MAX_PENDING_REQUESTS + 1; i += 1) t.send(STAT(`ke_${i}`));
    t.send(STAT("ke_over"));
    await until(() => t.frames.some((f) => f.id === "ke_over"));
    expect(t.frames.find((f) => f.id === "ke_over")).toMatchObject({
      ok: false,
      error: { code: "unavailable", message: "too many requests in flight" },
    });
  });

  it("closes the channel on a malformed or oversize request, killing the executor", async () => {
    const t = await setup();
    t.send(STAT("ke_1"));
    await until(() => t.executors[0]?.received.length === 1);
    t.send({ id: "bad id", op: "stat" });
    await until(() => t.closed.length === 1);
    expect(t.closed[0]).toBe("malformed exec request");
    expect(t.executors[0]?.killed).toBe(true);

    const u = await setup();
    u.extensionEnd.write(`${"x".repeat(MAX_REQUEST_LINE_BYTES + 10)}\n`);
    await until(() => u.closed.length === 1);
    expect(u.closed[0]).toBe("oversize exec request");
  });

  it("kills a misbehaving executor (non-JSON or oversize output) and fails its requests", async () => {
    const t = await setup();
    t.send(STAT("ke_1"));
    await until(() => t.executors[0]?.received.length === 1);
    t.executors[0]?.stdout.write("not json\n");
    await until(() => t.frames.length === 1);
    expect(t.executors[0]?.killed).toBe(true);
    expect(t.frames[0]).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("kills the executor when Pi's end closes", async () => {
    const t = await setup();
    t.send(STAT("ke_1"));
    await until(() => t.executors[0]?.received.length === 1);
    t.extensionEnd.destroy();
    await until(() => t.executors[0]?.killed === true);
    expect(t.closed).toEqual(["exec channel closed"]);
  });

  it("does not start an executor after it was closed", async () => {
    const t = await setup();
    t.relay.close("test");
    t.send(STAT("ke_1"));
    await new Promise((r) => setTimeout(r, 30));
    expect(t.executors).toHaveLength(0);
  });
});
