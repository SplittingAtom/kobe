import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiIdentities, type HelperRunner } from "../pi/identities.js";
import { executorEnv, startExecutor } from "./spawn-executor.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kobe-spawn-executor-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("executorEnv", () => {
  it("keeps the tools' allow-list and the egress wiring, and nothing else of Pi's launch", () => {
    const env = executorEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/kobe",
        TMPDIR: "/tmp",
        LANG: "C",
        PI_CODING_AGENT_DIR: "/run/kobe-pi/pi-x/agent",
        KOBE_MODEL_FILE: "/run/kobe-pi/pi-x/model.json",
        KOBE_POLICY_FD: "3",
        KOBE_EXEC_FD: "5",
        PI_OFFLINE: "1",
      },
      { BASH_ENV: "/opt/kobe/egress-env.sh", KOBE_EGRESS_PROXY: "http://egress:80" },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/kobe",
      TMPDIR: "/tmp",
      LANG: "C",
      NODE_OPTIONS: "--disable-sigusr1",
      BASH_ENV: "/opt/kobe/egress-env.sh",
      KOBE_EGRESS_PROXY: "http://egress:80",
    });
  });
});

/** A program that echoes its stdin and records its argv/env. */
async function echoProgram(): Promise<string> {
  const file = path.join(dir, "echo.mjs");
  await writeFile(
    file,
    `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(path.join(dir, "seen.json"))}, JSON.stringify({ argv: process.argv.slice(2), env: process.env.KOBE_T ?? null }));
process.stdin.pipe(process.stdout);
process.stdin.on("end", () => process.exit(0));
`,
  );
  return file;
}

describe("startExecutor", () => {
  it("runs the program as a plain child with exactly the given environment", async () => {
    const entry = await echoProgram();
    const handle = await startExecutor({
      nodeBin: process.execPath,
      entry,
      env: { KOBE_T: "yes", PATH: process.env.PATH ?? "" },
      cwd: dir,
    });
    const out: Buffer[] = [];
    handle.stdout.on("data", (c: Buffer) => out.push(c));
    handle.stdin.write("ping\n");
    handle.kill(); // closes stdin; the program exits on its own
    await handle.exited;
    expect(Buffer.concat(out).toString()).toBe("ping\n");
    expect(JSON.parse(await readFile(path.join(dir, "seen.json"), "utf8"))).toEqual({
      argv: [],
      env: "yes",
    });
  });

  it("reports a program that cannot start as an exit, not a crash", async () => {
    const diagnostics: string[] = [];
    const handle = await startExecutor({
      nodeBin: "/nonexistent/node",
      entry: "x",
      env: {},
      cwd: dir,
      onDiagnostic: (m) => diagnostics.push(m),
    });
    handle.stdin.on("error", () => undefined);
    expect(await handle.exited).toEqual({ code: null, signal: null });
    expect(diagnostics[0]).toContain("failed to start");
  });

  it("under an identity clears the partner uid first, then runs through the helper as the partner", async () => {
    const entry = await echoProgram();
    // A stand-in helper: drops the uid (and the env TMPDIR shim) and execs the rest.
    const helper = path.join(dir, "runas.sh");
    await writeFile(
      helper,
      `#!/bin/sh
echo "$@" > ${JSON.stringify(path.join(dir, "helper-args"))}
shift
if [ "$1" = "/usr/bin/env" ]; then shift; shift; fi
exec "$@"
`,
    );
    await chmod(helper, 0o755);
    const calls: string[][] = [];
    const run: HelperRunner = async (_h, args) => {
      calls.push([...args]);
      return { code: 0, stderr: "" };
    };
    const identities = new PiIdentities(helper, [2001], run, "/reclaim", true);
    const handle = await startExecutor({
      nodeBin: process.execPath,
      entry,
      env: { KOBE_T: "yes", PATH: process.env.PATH ?? "", TMPDIR: "/tmp" },
      cwd: dir,
      runAs: { identities, identity: { uid: 2001, gid: 2001 } },
    });
    // The clearing ran before the start.
    expect(calls).toEqual([["3001", "--kill-all"]]);
    handle.stdin.write("hi\n");
    const out: Buffer[] = [];
    handle.stdout.on("data", (c: Buffer) => out.push(c));
    handle.kill();
    await handle.exited;
    expect(Buffer.concat(out).toString()).toBe("hi\n");
    expect((await readFile(path.join(dir, "helper-args"), "utf8")).startsWith("3001 ")).toBe(true);
    // Killing goes through the helper as well (the agent cannot signal another uid).
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([
      ["3001", "--kill-all"],
      ["3001", "--kill-all"],
    ]);
  });

  it("does not start when the partner uid cannot be cleared", async () => {
    const run: HelperRunner = async () => ({ code: 71, stderr: "busy" });
    const identities = new PiIdentities("/helper", [2001], run, "/reclaim", true);
    await expect(
      startExecutor({
        nodeBin: process.execPath,
        entry: "x",
        env: {},
        cwd: dir,
        runAs: { identities, identity: { uid: 2001, gid: 2001 } },
      }),
    ).rejects.toThrow(/kill-all as 3001 failed/);
  });
});
