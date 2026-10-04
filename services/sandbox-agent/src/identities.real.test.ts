import { chmod, copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ModelTokenSource } from "./models/types.js";
import { loadPiIdentities, PI_UID_MIN, type PiIdentities } from "./pi/identities.js";
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

  beforeAll(async () => {
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
    await rm(scratch, { recursive: true, force: true });
    await rm(shm, { recursive: true, force: true });
  });
  afterEach(async () => {
    expect(h.server.violations).toEqual([]);
    await h.close();
  });

  async function start(env: Record<string, string> = {}): Promise<Harness> {
    h = await startHarness({
      piBin,
      env,
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
  async function tool(threadId: string, runId: string, command: string) {
    const result = await h.server.command({
      ...runStart(`sh:${command}`, { config: { model: MODEL } }),
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

  it("runs every Pi under its own identity, never the agent's uid", async () => {
    const [a, b] = await twoThreads();
    expect(a.uid).not.toBe(b.uid);
    for (const pi of [a, b]) {
      expect(pi.uid).toBeGreaterThanOrEqual(PI_UID_MIN);
      expect(pi.uid).not.toBe(process.getuid?.());
      expect(pi.gid).toBe(pi.uid);
      expect(pi.groups.sort()).toEqual([process.getgid?.(), pi.uid].sort());
      // HOME stays the shared one (like /workspace, D13); see docs/ledger/KOBE-71.md.
      expect(pi.home).toBe(path.join(h.dir, "home"));
    }
    const dir = await stat(path.dirname(a.agentDir));
    expect(dir.uid).toBe(process.getuid?.());
    expect(dir.gid).toBe(a.gid);
    expect(dir.mode & 0o7777).toBe(0o2750);
    expect((await stat(a.modelFile)).mode & 0o777).toBe(0o640);
  });

  it("a tool cannot plant a file in another thread's runtime directory (EACCES)", async () => {
    const [, b] = await twoThreads();
    const planted = path.join(b.agentDir, "settings.json");
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

  it("keeps the tripwire: a Pi's own tools planting config into its runtime dir fail the next run", async () => {
    const [a] = await twoThreads();
    const out = await tool(
      THREAD,
      "4f5a6b7c-8d9e-4f0a-9b1c-2d3e4f5a6b7c",
      `echo '{}' > ${a.agentDir}/settings.json`,
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
});
