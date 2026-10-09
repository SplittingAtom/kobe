import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serveExecutor } from "./server.js";

type Frame = Record<string, unknown>;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kobe-executor-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(commandEnv: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" }) {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Frame[] = [];
  const logs: string[] = [];
  let buffer = "";
  output.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    for (let lf = buffer.indexOf("\n"); lf !== -1; lf = buffer.indexOf("\n")) {
      frames.push(JSON.parse(buffer.slice(0, lf)) as Frame);
      buffer = buffer.slice(lf + 1);
    }
  });
  const executor = serveExecutor({ input, output, commandEnv, log: (m) => logs.push(m) });
  const send = (frame: unknown) => input.write(`${JSON.stringify(frame)}\n`);
  const final = async (id: string): Promise<Frame> => {
    for (let i = 0; i < 400; i += 1) {
      const found = frames.find((f) => f.id === id && typeof f.ok === "boolean");
      if (found !== undefined) return found;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no final frame for ${id}: ${JSON.stringify(frames)}`);
  };
  const output_ = (id: string, stream: string) =>
    Buffer.concat(
      frames
        .filter((f) => f.id === id && f.stream === stream)
        .map((f) => Buffer.from(f.data as string, "base64")),
    ).toString();
  return { input, send, final, frames, logs, executor, output: output_ };
}

const b64 = (text: string) => Buffer.from(text).toString("base64");

describe("files", () => {
  it("reads a chunk of a file and reports its size and end", async () => {
    const file = path.join(dir, "a.txt");
    await writeFile(file, "hello world");
    const t = setup();
    t.send({ id: "r1", op: "read", path: file, offset: 6, length: 100 });
    expect(await t.final("r1")).toEqual({
      id: "r1",
      ok: true,
      data: b64("world"),
      size: 11,
      eof: true,
    });
    t.send({ id: "r2", op: "read", path: file, offset: 0, length: 5 });
    expect(await t.final("r2")).toMatchObject({ data: b64("hello"), eof: false });
  });

  it("refuses to read a directory or a missing file with the errno code", async () => {
    const t = setup();
    t.send({ id: "d", op: "read", path: dir, offset: 0, length: 10 });
    expect(await t.final("d")).toMatchObject({ ok: false, error: { code: "EISDIR" } });
    t.send({ id: "m", op: "read", path: path.join(dir, "missing"), offset: 0, length: 10 });
    expect(await t.final("m")).toMatchObject({ ok: false, error: { code: "ENOENT" } });
  });

  it("writes a file, truncating on the first chunk and appending on the next", async () => {
    const file = path.join(dir, "w.txt");
    await writeFile(file, "old old old old");
    const t = setup();
    t.send({ id: "w1", op: "write", path: file, data: b64("héllo ") });
    expect(await t.final("w1")).toEqual({ id: "w1", ok: true });
    t.send({ id: "w2", op: "write", path: file, data: b64("world"), append: true });
    await t.final("w2");
    expect(await readFile(file, "utf8")).toBe("héllo world");
  });

  it("creates directories recursively and checks access", async () => {
    const t = setup();
    const deep = path.join(dir, "a/b/c");
    t.send({ id: "m", op: "mkdir", path: deep });
    expect(await t.final("m")).toEqual({ id: "m", ok: true });
    t.send({ id: "a", op: "access", path: deep, write: true });
    expect(await t.final("a")).toEqual({ id: "a", ok: true });
    t.send({ id: "n", op: "access", path: path.join(dir, "nope") });
    expect(await t.final("n")).toMatchObject({ ok: false, error: { code: "ENOENT" } });
  });

  it("stats files, directories and follows links", async () => {
    await writeFile(path.join(dir, "f"), "abc");
    await symlink(dir, path.join(dir, "link"));
    const t = setup();
    t.send({ id: "1", op: "stat", path: path.join(dir, "f") });
    expect(await t.final("1")).toEqual({ id: "1", ok: true, kind: "file", size: 3 });
    t.send({ id: "2", op: "stat", path: path.join(dir, "link") });
    expect(await t.final("2")).toMatchObject({ kind: "dir" });
  });

  it("lists a directory sorted like Pi's ls, flagging directories and broken links", async () => {
    await mkdir(path.join(dir, "Beta"));
    await writeFile(path.join(dir, "alpha"), "");
    await writeFile(path.join(dir, ".hidden"), "");
    await symlink(path.join(dir, "gone"), path.join(dir, "broken"));
    const t = setup();
    t.send({ id: "l", op: "readdir", path: dir });
    expect(await t.final("l")).toEqual({
      id: "l",
      ok: true,
      entries: [
        { name: ".hidden", dir: false },
        { name: "alpha", dir: false },
        { name: "Beta", dir: true },
        { name: "broken", dir: null },
      ],
      truncated: false,
    });
  });
});

describe("exec", () => {
  it("streams stdout and stderr and reports the exit code", async () => {
    const t = setup();
    t.send({ id: "e", op: "exec", cwd: dir, command: "echo out; echo err >&2; exit 3" });
    expect(await t.final("e")).toEqual({ id: "e", ok: true, exit_code: 3, signal: null });
    expect(t.output("e", "stdout")).toBe("out\n");
    expect(t.output("e", "stderr")).toBe("err\n");
  });

  it("runs in the requested directory and gives the command only the executor's environment", async () => {
    const t = setup({ PATH: process.env.PATH ?? "", KOBE_BASE: "base" });
    t.send({
      id: "e",
      op: "exec",
      cwd: dir,
      command: 'pwd; echo "$KOBE_BASE|$PI_MODEL|$SECRET|$HOME_X"',
      env: { PI_MODEL: "m1", SECRET: "nope", PATH: "/evil" },
    });
    await t.final("e");
    const [pwd, vars] = t.output("e", "stdout").trim().split("\n");
    expect(await readFile(path.join(pwd as string, "."), "utf8").catch(() => "dir")).toBe("dir");
    expect(path.basename(pwd as string)).toBe(path.basename(dir));
    // Only the session variables a request may name get through; PATH stays the executor's.
    expect(vars).toBe("base|m1||");
  });

  it("reports a signal-killed shell as 128 + signal", async () => {
    const t = setup();
    t.send({ id: "e", op: "exec", cwd: dir, command: "kill -9 $$" });
    expect(await t.final("e")).toMatchObject({ ok: true, exit_code: 137, signal: "SIGKILL" });
  });

  it("fails a missing working directory as Pi does", async () => {
    const t = setup();
    const cwd = path.join(dir, "missing");
    t.send({ id: "e", op: "exec", cwd, command: "true" });
    expect(await t.final("e")).toMatchObject({
      ok: false,
      error: {
        code: "ENOENT",
        message: `Working directory does not exist: ${cwd}\nCannot execute bash commands.`,
      },
    });
  });

  it("kills the command's process group on timeout", async () => {
    const t = setup();
    t.send({ id: "e", op: "exec", cwd: dir, command: "sleep 30 & sleep 30", timeout_s: 0.2 });
    expect(await t.final("e")).toMatchObject({
      ok: false,
      error: { code: "timeout", message: "timeout:0.2" },
    });
  });

  it("cancels a running command", async () => {
    const t = setup();
    t.send({ id: "e", op: "exec", cwd: dir, command: "echo started; sleep 30" });
    for (let i = 0; i < 200 && t.output("e", "stdout") === ""; i += 1)
      await new Promise((r) => setTimeout(r, 10));
    t.send({ id: "c", op: "cancel", target: "e" });
    expect(await t.final("e")).toMatchObject({ ok: false, error: { code: "aborted" } });
  });

  it("does not hang on a background process that keeps the output open", async () => {
    const t = setup();
    t.send({ id: "e", op: "exec", cwd: dir, command: "(sleep 3; echo late) & echo now" });
    const started = Date.now();
    expect(await t.final("e")).toMatchObject({ ok: true, exit_code: 0 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(t.output("e", "stdout")).toBe("now\n");
  });

  it("runs only rg and fd by argv", async () => {
    const t = setup();
    t.send({ id: "bad", op: "exec", cwd: dir, argv: ["cat", "/etc/passwd"] });
    expect(await t.final("bad")).toMatchObject({ ok: false, error: { code: "invalid" } });
    t.send({ id: "both", op: "exec", cwd: dir, argv: ["rg", "x"], command: "true" });
    expect(await t.final("both")).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("answers a spawn failure instead of crashing", async () => {
    const t = setup({ PATH: "/nonexistent" });
    t.send({ id: "e", op: "exec", cwd: dir, argv: ["rg", "x"] });
    expect(await t.final("e")).toMatchObject({ ok: false, error: { code: "spawn_failed" } });
  });
});

describe("robustness", () => {
  it("rejects malformed requests with an error reply when the id is known", async () => {
    const t = setup();
    t.send({ id: "x", op: "read", path: "relative", offset: 0, length: 1 });
    expect(await t.final("x")).toMatchObject({ ok: false, error: { code: "invalid" } });
    t.send({ id: "y", op: "write", path: path.join(dir, "f"), data: "not base64!" });
    expect(await t.final("y")).toMatchObject({ ok: false, error: { code: "invalid" } });
    t.input.write("not json\n");
    t.send({ id: "z", op: "unknown" });
    t.send({ id: "ok", op: "stat", path: dir });
    expect(await t.final("ok")).toMatchObject({ ok: true });
    expect(t.logs.length).toBeGreaterThan(0);
  });

  it("refuses a duplicate id of a running command", async () => {
    const t = setup();
    t.send({ id: "e", op: "exec", cwd: dir, command: "sleep 30" });
    t.send({ id: "e", op: "exec", cwd: dir, command: "true" });
    expect(await t.final("e")).toMatchObject({ ok: false, error: { code: "invalid" } });
    t.input.end();
    await t.executor.done;
  });

  it("kills what it started when its input ends", async () => {
    const pidFile = path.join(dir, "pid");
    const t = setup();
    t.send({ id: "e", op: "exec", cwd: dir, command: `echo $$ > ${pidFile}; sleep 30` });
    for (let i = 0; i < 200; i += 1) {
      if ((await readFile(pidFile, "utf8").catch(() => "")).trim() !== "") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    t.input.end();
    await t.executor.done;
    await new Promise((r) => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
