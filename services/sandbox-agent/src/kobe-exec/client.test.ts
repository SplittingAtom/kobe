import type { Duplex } from "node:stream";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { socketPair } from "../testing/socket-pair.js";
import { ExecClient, unavailableTransport } from "./client.js";
import { connect } from "./connect.js";
import { MAX_PENDING_REQUESTS, MAX_REPLY_LINE_BYTES } from "./protocol.js";
import { bashOperations } from "./remote-ops.js";

async function setup(options: ConstructorParameters<typeof ExecClient>[1] = {}) {
  const [extensionEnd, agentEnd] = await socketPair();
  const requests: Record<string, unknown>[] = [];
  let buffer = "";
  agentEnd.on("error", () => undefined);
  agentEnd.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let lf = buffer.indexOf("\n"); lf !== -1; lf = buffer.indexOf("\n")) {
      requests.push(JSON.parse(buffer.slice(0, lf)) as Record<string, unknown>);
      buffer = buffer.slice(lf + 1);
    }
  });
  const client = new ExecClient(extensionEnd, options);
  const reply = (v: unknown) => agentEnd.write(`${JSON.stringify(v)}\n`);
  const waitFor = async (n: number) => {
    for (let i = 0; i < 300 && requests.length < n; i += 1)
      await new Promise((r) => setTimeout(r, 5));
  };
  return { client, requests, reply, agentEnd: agentEnd as Duplex, waitFor };
}

describe("ExecClient", () => {
  it("sends a request with a fresh id and resolves with the final fields", async () => {
    const t = await setup();
    const result = t.client.request({ op: "stat", path: "/workspace" });
    await t.waitFor(1);
    expect(t.requests[0]).toEqual({ id: "ke_1", op: "stat", path: "/workspace" });
    t.reply({ id: "ke_1", ok: true, kind: "dir", size: 4096 });
    expect(await result).toEqual({ ok: true, fields: { kind: "dir", size: 4096 } });
  });

  it("hands stream frames to the caller as they arrive", async () => {
    const t = await setup();
    const chunks: string[] = [];
    const result = t.client.request(
      { op: "exec", cwd: "/workspace", command: "x" },
      { onStream: (stream, data) => chunks.push(`${stream}:${data.toString()}`) },
    );
    await t.waitFor(1);
    t.reply({ id: "ke_1", stream: "stdout", data: Buffer.from("a").toString("base64") });
    t.reply({ id: "ke_1", stream: "stderr", data: Buffer.from("b").toString("base64") });
    t.reply({ id: "ke_1", ok: true, exit_code: 0, signal: null });
    expect(await result).toMatchObject({ ok: true });
    expect(chunks).toEqual(["stdout:a", "stderr:b"]);
  });

  it("returns the error of a failed request", async () => {
    const t = await setup();
    const result = t.client.request({ op: "read", path: "/x", offset: 0, length: 1 });
    await t.waitFor(1);
    t.reply({ id: "ke_1", ok: false, error: { code: "ENOENT", message: "gone" } });
    expect(await result).toEqual({ ok: false, error: { code: "ENOENT", message: "gone" } });
  });

  it("sends a cancel on abort and ends with the executor's answer, or gives up after the grace", async () => {
    const t = await setup({ cancelGraceMs: 50 });
    const controller = new AbortController();
    const result = t.client.request(
      { op: "exec", cwd: "/workspace", command: "x" },
      { signal: controller.signal },
    );
    await t.waitFor(1);
    controller.abort();
    await t.waitFor(2);
    expect(t.requests[1]).toMatchObject({ op: "cancel", target: "ke_1" });
    // The executor never answers: the call still ends.
    expect(await result).toEqual({ ok: false, error: { code: "aborted", message: "aborted" } });
  });

  it("times a file operation out, but not a command", async () => {
    const t = await setup({ timeoutMs: 30 });
    expect(await t.client.request({ op: "stat", path: "/x" })).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
  });

  it("fails every open request when the channel closes, and all later ones", async () => {
    const t = await setup();
    const a = t.client.request({ op: "stat", path: "/a" });
    await t.waitFor(1);
    t.agentEnd.destroy();
    expect(await a).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await t.client.request({ op: "stat", path: "/b" })).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
    expect(t.client.closed).toBe(true);
  });

  it("closes on a malformed or oversize reply", async () => {
    const t = await setup();
    const a = t.client.request({ op: "stat", path: "/a" });
    await t.waitFor(1);
    t.reply({ id: "ke_1", ok: "yes" });
    expect(await a).toMatchObject({ ok: false, error: { code: "unavailable" } });

    const u = await setup();
    const b = u.client.request({ op: "stat", path: "/a" });
    await u.waitFor(1);
    u.agentEnd.write(`${"x".repeat(MAX_REPLY_LINE_BYTES + 5)}\n`);
    expect(await b).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("refuses more than the allowed number of open requests", async () => {
    const t = await setup();
    const open = Array.from({ length: MAX_PENDING_REQUESTS }, () =>
      t.client.request({ op: "stat", path: "/a" }),
    );
    expect(await t.client.request({ op: "stat", path: "/a" })).toMatchObject({
      ok: false,
      error: { message: "too many requests in flight" },
    });
    t.agentEnd.destroy();
    await Promise.all(open);
  });

  it("drops a late reply for a request that already ended", async () => {
    const t = await setup({ timeoutMs: 20 });
    await t.client.request({ op: "stat", path: "/a" });
    t.reply({ id: "ke_1", ok: true, kind: "dir", size: 0 });
    const next = t.client.request({ op: "stat", path: "/b" });
    await t.waitFor(2);
    t.reply({ id: "ke_2", ok: true, kind: "file", size: 1 });
    expect(await next).toMatchObject({ ok: true, fields: { kind: "file" } });
  });
});

describe("connect", () => {
  it("removes the fd variable from the environment and opens the channel", () => {
    const env: Record<string, string | undefined> = { KOBE_EXEC_FD: "5" };
    const warnings: string[] = [];
    const opened: number[] = [];
    const transport = connect(
      env,
      (m) => warnings.push(m),
      (fd) => {
        opened.push(fd);
        return new PassThrough() as unknown as Duplex;
      },
    );
    expect(env.KOBE_EXEC_FD).toBeUndefined();
    expect(opened).toEqual([5]);
    expect(transport).toBeInstanceOf(ExecClient);
    expect(warnings).toEqual([]);
  });

  it.each([undefined, "", "abc", "4", "99999"])(
    "fails every call, never falls back, when the fd variable is %j",
    async (value) => {
      const env: Record<string, string | undefined> = { KOBE_EXEC_FD: value };
      const warnings: string[] = [];
      const transport = connect(env, (m) => warnings.push(m));
      expect(warnings).toHaveLength(1);
      const ops = bashOperations(transport);
      await expect(ops.exec("echo hi", "/workspace", { onData: () => undefined })).rejects.toThrow(
        /tool executor is unavailable/,
      );
    },
  );

  it("fails every call when the fd cannot be opened", async () => {
    const warnings: string[] = [];
    const transport = connect(
      { KOBE_EXEC_FD: "5" },
      (m) => warnings.push(m),
      () => {
        throw new Error("EBADF");
      },
    );
    expect(warnings[0]).toContain("EBADF");
    expect(await transport.request({ op: "stat", path: "/x" })).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });
});

describe("unavailableTransport", () => {
  it("answers every request with the reason", async () => {
    expect(await unavailableTransport("because").request({ op: "stat" })).toEqual({
      ok: false,
      error: { code: "unavailable", message: "because" },
    });
  });
});
