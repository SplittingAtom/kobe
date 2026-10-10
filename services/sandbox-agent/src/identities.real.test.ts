import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ModelTokenSource } from "./models/types.js";
import { loadPiIdentities, PI_UID_MIN, PiIdentities } from "./pi/identities.js";
import { EXECUTOR_ENTRY } from "./testing/real-pi.js";
import {
  FAKE_PI,
  RUN,
  RUN_2,
  THREAD,
  THREAD_2,
  runStart,
  startHarness,
  until,
  type Harness,
} from "./testing/harness.js";

/**
 * Privilege separation with the real helper (KOBE-71). Needs Linux, a `kobe-runas` built for this
 * user (KOBE_TEST_PI_RUNAS: root-owned, cap_setuid/cap_setgid, executable by one of our groups)
 * and the Pi identity groups among this process's supplementary groups — CI sets that up
 * (services/sandbox-agent/scripts/test-identities.sh). Skipped elsewhere.
 *
 * Every "tool" below is a real child of the scripted Pi, started the way Pi's bash tool starts
 * one, so it runs as that Pi's identity.
 */
const HELPER = process.env.KOBE_TEST_PI_RUNAS;
const MODELS_EXTENSION = "/opt/kobe/pi-extensions/kobe-models/index.js";
const MODEL = {
  alias: "fast",
  gateway_model: "openai/gpt-fake",
  api: "openai-completions" as const,
};
const TOKEN_FILE_CONTENT = "test-wire-token-0123456789";

const tokens: ModelTokenSource = {
  current: async () => "model-token-".padEnd(40, "x"),
  onChange: () => () => undefined,
};

interface Launch {
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
  readonly groups: number[];
  readonly agentDir: string;
  readonly modelFile: string;
  readonly home: string;
  readonly tmpdir: string;
  readonly env: string[];
}

/** A command result that must be ok (the error, if any, in the failure message). */
function ok(result: { ok: boolean }): void {
  if (!result.ok) throw new Error(`command failed: ${JSON.stringify(result)}`);
}

describe.runIf(HELPER !== undefined)("Pi identities with the real helper (KOBE-71)", () => {
  let identities: PiIdentities;
  let scratch: string;
  let shm: string;
  let piBin: string;
  let h: Harness;

  let umask: number;
  beforeAll(async () => {
    // As in the image: the agent's own files are private unless it shares them explicitly.
    umask = process.umask(0o077);
    identities = await loadPiIdentities(HELPER as string, 2);
    // The scripted Pi must be readable by the identities (the checkout may not be).
    scratch = await mkdtemp(path.join(tmpdir(), "kobe-identities-"));
    // Runtime dirs on another filesystem than the workspace (as /tmp and the PVC are in a pod).
    shm = await mkdtemp(path.join("/dev/shm", "kobe-identities-"));
    piBin = path.join(scratch, "fake-pi.mjs");
    await copyFile(FAKE_PI, piBin);
    await chmod(scratch, 0o755);
    await chmod(shm, 0o755);
    await chmod(piBin, 0o755);
  });
  afterAll(async () => {
    process.umask(umask);
    await rm(scratch, { recursive: true, force: true });
    await rm(shm, { recursive: true, force: true });
  });
  afterEach(async () => {
    expect(h.server.violations).toEqual([]);
    await h.close();
  });

  async function start(
    env: Record<string, string> = {},
    extra: Partial<Parameters<typeof startHarness>[0]> = {},
  ): Promise<Harness> {
    h = await startHarness({
      piBin,
      env,
      ...extra,
      identities,
      runtimeDir: path.join(shm, "pi-runtime"),
      models: {
        gatewayUrl: "http://model-gateway.kobe.internal:80",
        extension: MODELS_EXTENSION,
        tokens,
      },
    });
    return h;
  }

  async function launch(threadId: string): Promise<Launch> {
    const [first] = await h.commandsLog(threadId);
    return first as unknown as Launch;
  }

  /** Run a shell command as a tool of `threadId`'s Pi (a new run on that thread). */
  async function tool(
    threadId: string,
    runId: string,
    command: string,
    config: Record<string, unknown> = { model: MODEL },
  ) {
    const result = await h.server.command({
      ...runStart(`sh:${command}`, { config }),
      thread_id: threadId,
      run_id: runId,
    });
    ok(result);
    const event = await h.server.waitFor(
      (f) =>
        f.type === "pi.event" &&
        f.run_id === runId &&
        (f.event as { type?: string }).type === "kobe_test_shell",
    );
    await h.server.waitFor(
      (f) =>
        f.type === "pi.event" &&
        f.run_id === runId &&
        (f.event as { type?: string }).type === "agent_settled",
    );
    return (event as unknown as { event: { code: number; stdout: string; stderr: string } }).event;
  }

  /** Two threads, each with a live Pi under its own identity. */
  async function twoThreads(): Promise<[Launch, Launch]> {
    await start();
    ok(await h.server.command(runStart("say:a", { config: { model: MODEL } })));
    ok(
      await h.server.command({
        ...runStart("say:b", { config: { model: MODEL } }),
        thread_id: THREAD_2,
        run_id: RUN_2,
      }),
    );
    await until(async () => (await h.commandsLog(THREAD_2).catch(() => [])).length > 0);
    return [await launch(THREAD), await launch(THREAD_2)];
  }

  it("with the executor, Pi's HOME and TMPDIR are private (KOBE-196): its group, not the partner's, gone with the Pi; flag off, the shared ones", async () => {
    await start(
      {},
      {
        tmpRoot: shm,
        exec: {
          extension: MODELS_EXTENSION,
          wiring: { executorEntry: EXECUTOR_ENTRY, nodeBin: process.execPath },
        },
      },
    );
    ok(await h.server.command(runStart("say:a", { config: { model: MODEL } })));
    const pi = await launch(THREAD);
    const root = path.dirname(pi.home);
    expect(root.startsWith(path.join(shm, "kobe-pi-"))).toBe(true);
    expect(pi.tmpdir).toBe(path.join(root, "tmp"));
    const modes = async (dir: string) => {
      const info = await stat(dir);
      return [info.uid, info.gid, info.mode & 0o7777];
    };
    const me = process.getuid?.() ?? 0;
    // Agent-owned, the Pi's group: home reaches nobody else, tmp is readable (not writable) to all.
    expect(await modes(root)).toEqual([me, pi.gid, 0o2755]);
    expect(await modes(pi.home)).toEqual([me, pi.gid, 0o2770]);
    expect(await modes(pi.tmpdir)).toEqual([me, pi.gid, 0o2775]);
    // The jiti and compile caches are off for it, and it is told where the tools' home is.
    expect(pi.env).toEqual(expect.arrayContaining(["JITI_FS_CACHE", "NODE_DISABLE_COMPILE_CACHE"]));
    expect(pi.env).toContain("KOBE_EXEC_TOOL_HOME");
    // Gone once the Pi is (its files, which the reclaim would otherwise open to the group).
    await h.close();
    await until(() => !existsSync(root), 30_000);
  }, 60_000);

  it("without the executor Pi's HOME and TMPDIR are private too (KOBE-228); the tools are told the shared ones", async () => {
    await start({}, { tmpRoot: shm });
    ok(await h.server.command(runStart("say:a", { config: { model: MODEL } })));
    const pi = await launch(THREAD);
    const root = path.dirname(pi.home);
    expect(root.startsWith(path.join(shm, "kobe-pi-"))).toBe(true);
    expect(pi.home).not.toBe(path.join(h.dir, "home"));
    expect(pi.tmpdir).toBe(path.join(root, "tmp"));
    const me = process.getuid?.() ?? 0;
    for (const dir of [root, pi.home, pi.tmpdir]) {
      const info = await stat(dir);
      expect([info.uid, info.gid, info.mode & 0o7777]).toEqual([me, pi.gid, 0o2770]);
    }
    expect(pi.env).toEqual(expect.arrayContaining(["KOBE_TOOL_HOME", "KOBE_TOOL_TMPDIR"]));
    expect(pi.env).not.toContain("KOBE_EXEC_TOOL_HOME");
  }, 60_000);

  it("a tool of thread A cannot plant ~/.node_modules in thread B's Pi HOME, and B's Pi HOME is not the shared one (KOBE-228)", async () => {
    await start({}, { tmpRoot: shm });
    ok(await h.server.command(runStart("say:a", { config: { model: MODEL } })));
    ok(
      await h.server.command({
        ...runStart("say:b", { config: { model: MODEL } }),
        thread_id: THREAD_2,
        run_id: RUN_2,
      }),
    );
    await until(async () => (await h.commandsLog(THREAD_2).catch(() => [])).length > 0);
    const b = await launch(THREAD_2);
    const shared = path.join(h.dir, "home");
    expect(b.home).not.toBe(shared);
    const plant = (home: string) =>
      `mkdir -p ${home}/.node_modules/pkg && echo "require('fs').writeFileSync('${home}/pwned','x')" > ${home}/.node_modules/pkg/index.js`;
    const toB = await tool(THREAD, "6a7b8c9d-0e1f-4a2b-8c3d-4e5f6a7b8c9d", plant(b.home));
    expect(toB.code).not.toBe(0);
    expect(toB.stderr).toMatch(/Permission denied/);
    expect(existsSync(path.join(b.home, ".node_modules"))).toBe(false);
    // The shared home is where the tools plant (and keep their files): no Pi loads from it.
    const toShared = await tool(THREAD, "7b8c9d0e-1f2a-4b3c-9d4e-5f6a7b8c9d0e", plant(shared));
    expect(toShared.code).toBe(0);
    expect(existsSync(path.join(b.home, "pwned"))).toBe(false);
  }, 60_000);

  it("runs every Pi under its own identity, never the agent's uid", async () => {
    const [a, b] = await twoThreads();
    expect(a.uid).not.toBe(b.uid);
    for (const pi of [a, b]) {
      expect(pi.uid).toBeGreaterThanOrEqual(PI_UID_MIN);
      expect(pi.uid).not.toBe(process.getuid?.());
      expect(pi.gid).toBe(pi.uid);
      expect(pi.groups.sort()).toEqual([process.getgid?.(), pi.uid].sort());
      // HOME is Pi's own and private (KOBE-228); the shared one is the tools' (KOBE_TOOL_HOME).
      expect(pi.home).not.toBe(path.join(h.dir, "home"));
    }
    const dir = await stat(path.dirname(a.agentDir));
    expect(dir.uid).toBe(process.getuid?.());
    expect(dir.gid).toBe(a.gid);
    expect(dir.mode & 0o7777).toBe(0o2750);
    expect((await stat(a.modelFile)).mode & 0o777).toBe(0o640);
  });

  it("a tool cannot plant a file in another thread's runtime directory (EACCES)", async () => {
    const [, b] = await twoThreads();
    const planted = path.join(b.agentDir, "SYSTEM.md");
    const out = await tool(
      THREAD,
      "4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c",
      `echo '{}' > ${planted}`,
    );
    expect(out.code).not.toBe(0);
    expect(out.stderr).toMatch(/Permission denied/);
    await expect(stat(planted)).rejects.toThrow();
    // Nor read anything of it: the model file (token, run id), or list the directory.
    const read = await tool(
      THREAD,
      "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
      `cat ${b.modelFile}; ls ${path.dirname(b.agentDir)}`,
    );
    expect(read.code).not.toBe(0);
    expect(read.stdout).toBe("");
    expect(read.stderr).toMatch(/Permission denied/);
  });

  it("a tool cannot rewrite its own Pi's model file (token, run id) either", async () => {
    const [a] = await twoThreads();
    const out = await tool(
      THREAD,
      "4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c",
      `echo x > ${a.modelFile} || mv ${a.modelFile} ${a.modelFile}.x`,
    );
    expect(out.code).not.toBe(0);
    expect(JSON.parse(await readFile(a.modelFile, "utf8"))).toMatchObject({ v: 1 });
  });

  it("the system prompt file is agent-owned and read-only to the Pi uid (KOBE-123)", async () => {
    await start();
    ok(
      await h.server.command(runStart("say:a", { config: { model: MODEL, system_prompt: "P1" } })),
    );
    await h.server.waitFor(
      (f) =>
        f.type === "pi.event" &&
        f.run_id === RUN &&
        (f.event as { type?: string }).type === "agent_settled",
    );
    const a = await launch(THREAD);
    const file = (a as unknown as { appendSystemPromptFile: string }).appendSystemPromptFile;
    expect((a as unknown as { appendSystemPromptText: string }).appendSystemPromptText).toBe("P1");
    const info = await stat(file);
    expect(info.uid).toBe(process.getuid?.());
    expect(info.mode & 0o777).toBe(0o640);
    const out = await tool(
      THREAD,
      "4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c",
      `echo x >> ${file}; echo append=$?; mv ${file} ${file}.x; echo move=$?; rm -f ${file}; echo remove=$?`,
      // The same config as the first run: a different one would restart Pi with a fresh directory.
      { model: MODEL, system_prompt: "P1" },
    );
    expect(out.stdout).toMatch(/append=[1-9]/);
    expect(out.stdout).toMatch(/move=[1-9]/);
    expect(out.stdout).toMatch(/remove=[1-9]/);
    expect(await readFile(file, "utf8")).toBe("P1");
  });

  it("a tool cannot read the agent's token file", async () => {
    await twoThreads();
    const tokenFile = path.join(h.dir, "token");
    expect((await readFile(tokenFile, "utf8")).trim()).toBe(TOKEN_FILE_CONTENT);
    const out = await tool(THREAD, "4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c", `cat ${tokenFile}`);
    expect(out.code).not.toBe(0);
    expect(out.stdout).not.toContain(TOKEN_FILE_CONTENT);
    expect(out.stderr).toMatch(/Permission denied/);
  });

  it("a tool cannot signal the agent or another thread's Pi", async () => {
    const [, b] = await twoThreads();
    const out = await tool(
      THREAD,
      "4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c",
      `kill -0 ${process.pid}; echo agent=$?; kill -9 ${b.pid}; echo sibling=$?; cat /proc/${b.pid}/environ >/dev/null; echo environ=$?`,
    );
    expect(out.stdout).toMatch(/agent=1/);
    expect(out.stdout).toMatch(/sibling=1/);
    expect(out.stdout).toMatch(/environ=1/);
    // Thread B's Pi is still alive and serves its next run.
    ok(
      await h.server.command({
        ...runStart("say:again", { config: { model: MODEL } }),
        thread_id: THREAD_2,
        run_id: "6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e",
      }),
    );
  });

  it("shares the workspace between threads: one thread's files are writable by the other", async () => {
    await twoThreads();
    const a = await tool(
      THREAD,
      "4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c",
      "mkdir -p shared && echo one > shared/f",
    );
    expect(a.code).toBe(0);
    const b = await tool(
      THREAD_2,
      "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d",
      "echo two >> shared/f && echo x > shared/g",
    );
    expect(b).toMatchObject({ code: 0, stderr: "" });
    expect(await readFile(path.join(h.workspace, "shared/f"), "utf8")).toBe("one\ntwo\n");
    // ...and by the agent (workspace sync), which shares the workspace group.
    await writeFile(path.join(h.workspace, "shared/f"), "agent\n");
  });

  it("kills everything a Pi left running and empties its directory before the identity is reused", async () => {
    await start({ KOBE_PI_IDLE_MS: "200" });
    ok(await h.server.command(runStart("orphan", { config: { model: MODEL } })));
    const orphan = await h.server.waitFor(
      (f) => f.type === "pi.event" && (f.event as { type?: string }).type === "kobe_test_orphan",
    );
    const pid = (orphan as unknown as { event: { pid: number } }).event.pid;
    const first = await launch(THREAD);
    const runtime = path.dirname(first.agentDir);
    expect(identities.available).toBe(identities.size - 1);
    await h.server.command({
      type: "run.stop",
      run_id: RUN,
      thread_id: THREAD,
      mode: "abort",
      reason: "user_cancelled",
    });
    // Idle reaping stops the thread's Pi; the identity comes back only after the reclaim.
    await until(() => identities.available === identities.size, 15_000);
    const state = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "gone");
    expect(state === "gone" || / [ZX] /.test(state)).toBe(true);
    await expect(stat(runtime)).rejects.toThrow();
    expect(await readdir(path.dirname(runtime))).toEqual([]);
  });

  it("a Pi's own tools cannot write, replace or delete the guarded config (KOBE-169)", async () => {
    const [a] = await twoThreads();
    const dir = a.agentDir;
    const attempts = (target: string) => [
      `echo '{}' > ${target}`,
      `rm -f ${target}`,
      // A file of the tool's own moved over it; the stray file is cleaned up either way.
      `echo '{}' > ${dir}/mine.json; mv -f ${dir}/mine.json ${target}; rc=$?; rm -f ${dir}/mine.json; exit $rc`,
    ];
    for (const file of ["models.json", "settings.json"]) {
      for (const command of attempts(`${dir}/${file}`)) {
        const out = await tool(THREAD, randomUUID(), command);
        expect(out.code, command).not.toBe(0);
      }
    }
    expect((await stat(dir)).mode & 0o7777).toBe(0o3770);
    expect(await readFile(`${dir}/models.json`, "utf8")).toBe('{"providers":{}}\n');
  });

  it("keeps the tripwire: a Pi's own tools planting config into its runtime dir fail the next run", async () => {
    const [a] = await twoThreads();
    const out = await tool(
      THREAD,
      "4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c",
      `echo '{}' > ${a.agentDir}/SYSTEM.md`,
    );
    expect(out.code).toBe(0);
    const result = await h.server.command(
      runStart("say:after", {
        config: { model: MODEL },
        run_id: "7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
      }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: "runtime_tampered" } });
  });

  it("proves at start-up that a process cannot ptrace or read its parent as an identity", async () => {
    await expect(identities.probe()).resolves.toBeUndefined();
  });

  it("SIGUSR1 from a tool opens no inspector in its Pi (control: a Node without the flag does)", async () => {
    await start();
    const check = `node -e 'require("net").connect(9229,"127.0.0.1").on("connect",()=>{console.log("open");process.exit(0)}).on("error",()=>console.log("closed"))'`;
    const out = await tool(
      THREAD,
      RUN,
      [
        "env -u NODE_OPTIONS node -e 'setInterval(()=>{},1000)' & c=$!; sleep 0.5",
        `kill -USR1 $c; sleep 1; echo control=$(${check}); kill -9 $c; sleep 0.5`,
        `kill -USR1 $PPID; sleep 1; echo pi=$(${check})`,
        "kill -0 $PPID && echo pi_alive",
      ].join("\n"),
    );
    expect(out.stdout).toMatch(/control=open/);
    expect(out.stdout).toMatch(/pi=closed/);
    expect(out.stdout).toMatch(/pi_alive/);
  });

  it("a tool cannot reopen its Pi's stdin or stdout through /proc (sockets: ENXIO)", async () => {
    await start();
    const out = await tool(
      THREAD,
      RUN,
      "for n in 0 1; do ( : > /proc/$PPID/fd/$n ) 2>&1; ls -l /proc/$PPID/fd/$n; done",
    );
    expect(out.stdout.match(/No such device or address/g)).toHaveLength(2);
    expect(out.stdout).toMatch(/socket:/);
  });

  it("caps the processes of an identity (RLIMIT_NPROC)", async () => {
    await start();
    const out = await tool(THREAD, RUN, "grep 'Max processes' /proc/self/limits");
    expect(out.stdout).toMatch(/Max processes\s+1024\s+1024/);
  });

  it("leaves nothing private to a recycled uid: owner-only files go to the workspace group, IPC objects go", async () => {
    await start({ KOBE_PI_IDLE_MS: "200" });
    const out = await tool(
      THREAD,
      RUN,
      [
        "umask 077",
        'echo s > "$KOBE_TOOL_HOME/k71-secret-$$"; echo s > /tmp/k71-secret-$$; echo s > k71-ws-secret-$$',
        "echo \"pid=$$ uid=$(id -u) shm=$(ipcmk -M 4096 | awk '{print $NF}')\"",
      ].join("\n"),
    );
    const pid = /pid=(\d+)/.exec(out.stdout)?.[1];
    const shm = /shm=(\d+)/.exec(out.stdout)?.[1];
    expect(pid).toBeDefined();
    expect(shm).toBeDefined();
    const files = [
      path.join(h.dir, "home", `k71-secret-${pid}`),
      `/tmp/k71-secret-${pid}`,
      path.join(h.workspace, `k71-ws-secret-${pid}`),
    ];
    for (const file of files) expect((await stat(file)).mode & 0o077).toBe(0);
    // The run ended: the idle Pi is reaped and its identity reclaimed.
    await until(() => identities.available === identities.size, 15_000);
    const group = (await stat(h.workspace)).gid;
    for (const file of files) {
      const info = await stat(file);
      expect(info.gid).toBe(group);
      expect(info.mode & 0o060).toBe(0o060);
    }
    const { execFileSync } = await import("node:child_process");
    const segments = execFileSync("ipcs", ["-m"], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[1]);
    expect(segments).not.toContain(shm);
    // Group-writable now, but in the sticky /tmp only its owner may remove it.
    await rm(`/tmp/k71-secret-${pid}`, { force: true }).catch(() => undefined);
  });

  it("reaches files inside an owner-only (000) directory, and clears a uid's leftovers in the runtime root", async () => {
    await start({ KOBE_PI_IDLE_MS: "200" });
    const runtimeRoot = path.join(shm, "pi-runtime");
    const out = await tool(
      THREAD,
      RUN,
      [
        "umask 077",
        "mkdir -p k71-deep/inner/innermost",
        "echo s > k71-deep/inner/innermost/secret; echo s > k71-deep/inner/secret",
        "chmod 000 k71-deep/inner/innermost k71-deep/inner",
        `echo s > ${runtimeRoot}/k71-leftover; mkdir ${runtimeRoot}/k71-leftover-dir; echo s > ${runtimeRoot}/k71-leftover-dir/f; chmod 000 ${runtimeRoot}/k71-leftover-dir`,
        "echo ok",
      ].join("\n"),
    );
    expect(out.code).toBe(0);
    await until(() => identities.available === identities.size, 15_000);
    const group = (await stat(h.workspace)).gid;
    for (const rel of ["k71-deep/inner", "k71-deep/inner/innermost"]) {
      const info = await stat(path.join(h.workspace, rel));
      expect(info.gid).toBe(group);
      expect(info.mode & 0o070).toBe(0o070);
    }
    for (const rel of ["k71-deep/inner/secret", "k71-deep/inner/innermost/secret"]) {
      const file = path.join(h.workspace, rel);
      expect((await stat(file)).gid).toBe(group);
      expect(await readFile(file, "utf8")).toBe("s\n");
    }
    const entries = await readdir(runtimeRoot);
    expect(entries.filter((name) => name.startsWith("k71-leftover"))).toEqual([]);
    // Real helper: the Pi spawn, the idle reap and the reclaim of the deep tree take about 5 s on a
    // loaded runner (KOBE-133: 5451 ms); the other real-helper tests that wait on a reclaim get 15 s+.
  }, 30_000);

  it("retires an identity whose reclaim failed: it is never handed out again", async () => {
    const failing = path.join(scratch, "failing-reclaim");
    await writeFile(
      failing,
      "#!/bin/sh\necho 'kobe-reclaim: could not reclaim: x' >&2\nexit 70\n",
      {
        mode: 0o755,
      },
    );
    // Same pool, but its reclaim retries fast (the real delays would outlast the test's teardown).
    class QuickRetry extends PiIdentities {
      override reclaimFiles(
        identity: Parameters<PiIdentities["reclaimFiles"]>[0],
        gid: number,
        dirs: readonly string[],
        options: Parameters<PiIdentities["reclaimFiles"]>[3] = {},
      ): Promise<void> {
        return super.reclaimFiles(identity, gid, dirs, { ...options, delaysMs: [10, 10] });
      }
    }
    const retiring = new QuickRetry(
      HELPER as string,
      [...Array(2).keys()].map((n) => PI_UID_MIN + n),
      undefined,
      failing,
    );
    h = await startHarness({
      piBin,
      env: { KOBE_PI_IDLE_MS: "200" },
      identities: retiring,
      runtimeDir: path.join(shm, "pi-runtime"),
      models: {
        gatewayUrl: "http://model-gateway.kobe.internal:80",
        extension: MODELS_EXTENSION,
        tokens,
      },
    });
    ok(await h.server.command(runStart("say:a", { config: { model: MODEL } })));
    await h.server.waitFor((f) => f.type === "pi.event");
    expect(retiring.available).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(retiring.available).toBe(1);
  }, 60_000);
});
