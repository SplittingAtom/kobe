import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RUN,
  RUN_2,
  THREAD,
  runStart,
  startHarness as startHarnessWith,
  type Harness,
} from "./testing/harness.js";
import { PI_AVAILABLE, PI_BIN, REAL_POLICY_EXTENSION } from "./testing/real-pi.js";

/**
 * Integration with the REAL pinned Pi (`@earendil-works/pi-coding-agent` 1.0.0 from
 * images/sandbox/pi) in RPC mode. No model credentials exist (or may exist) in a sandbox, so these
 * tests use commands that never call a model, plus a prompt that Pi must refuse for lack of a key.
 * Every Pi loads the real kobe-policy (KOBE-36), so each test also proves it loads and reports
 * ready. See testing/real-pi.ts for how Pi is found.
 */
const startHarness = (options: { piBin: string }) =>
  startHarnessWith({ ...options, env: { KOBE_POLICY_EXTENSION: REAL_POLICY_EXTENSION } });

let h: Harness | undefined;
afterEach(async () => {
  expect(h?.server.violations ?? []).toEqual([]);
  await h?.close();
  h = undefined;
});

const header = {
  type: "session",
  version: 3,
  id: THREAD,
  timestamp: "2026-10-01T22:00:00.000Z",
  cwd: "/workspace",
};
const message = (id: string, parentId: string | null, role: string, content: unknown) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-10-01T22:00:00.000Z",
  message: { role, content, timestamp: 1 },
});
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (id: string, parentId: string, text: string) => ({
  ...message(id, parentId, "assistant", [{ type: "text", text }]),
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "x",
    provider: "x",
    model: "x",
    usage,
    stopReason: "stop",
    timestamp: 2,
  },
});

describe.skipIf(!PI_AVAILABLE)("real Pi 1.0.0 in RPC mode (no model credentials)", () => {
  async function piCommand(command: Record<string, unknown>) {
    if (h === undefined) throw new Error("harness not started");
    return h.server.command(
      { type: "pi.command", thread_id: THREAD, command: { id: "srv", ...command } },
      30_000,
    );
  }

  it("loads no extension the sandbox user can write (HOME or project .pi)", async () => {
    h = await startHarness({ piBin: PI_BIN });
    const marker = (name: string) => path.join(h?.dir ?? "", `${name}-LOADED`);
    const evil = (name: string) =>
      `export default function (pi) { pi.on("session_start", async () => {` +
      ` require("node:fs").writeFileSync(${JSON.stringify(marker(name))}, "x"); }); }\n`;
    const home = path.join(h.dir, "home");
    await mkdir(path.join(home, ".pi/agent/extensions"), { recursive: true });
    await writeFile(path.join(home, ".pi/agent/extensions/evil.ts"), evil("home"));
    await writeFile(
      path.join(home, ".pi/agent/settings.json"),
      JSON.stringify({ defaultProjectTrust: "always" }),
    );
    await mkdir(path.join(h.workspace, ".pi/extensions"), { recursive: true });
    await writeFile(path.join(h.workspace, ".pi/extensions/evil.ts"), evil("project"));

    expect(await piCommand({ type: "get_state" })).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(marker("home"))).toBe(false);
    expect(existsSync(marker("project"))).toBe(false);

    // Control: the same Pi without Kobe's launch options does load the HOME extension.
    const child = spawn(PI_BIN, ["--mode", "rpc", "--no-session"], {
      cwd: h.workspace,
      env: { PATH: process.env.PATH ?? "", HOME: home, PI_OFFLINE: "1" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    child.stdin.write('{"id":"1","type":"get_state"}\n');
    await new Promise<void>((resolve) => {
      child.stdout.on("data", (d: Buffer) => {
        if (d.toString().includes('"get_state"')) resolve();
      });
    });
    child.stdin.end();
    await new Promise((resolve) => child.on("exit", resolve));
    expect(existsSync(marker("home"))).toBe(true);
  }, 60_000);

  it("answers get_state on the thread's own session file", async () => {
    h = await startHarness({ piBin: PI_BIN });
    const state = await piCommand({ type: "get_state" });
    expect(state).toMatchObject({
      ok: true,
      data: {
        isStreaming: false,
        sessionFile: path.join(h.sessions, `${THREAD}.jsonl`),
      },
    });
  }, 60_000);

  it("relays Pi's refusal of a prompt without credentials and keeps the thread usable", async () => {
    h = await startHarness({ piBin: PI_BIN });
    const result = await h.server.command(runStart("hello"), 30_000);
    expect(result).toMatchObject({ ok: false, error: { code: "pi_rejected" } });
    expect((result as { error: { message: string } }).error.message).toMatch(/API key/i);
    expect(await piCommand({ type: "get_state" })).toMatchObject({ ok: true });
  }, 60_000);

  it("reads a session rebuilt by session.restore and branches in place", async () => {
    h = await startHarness({ piBin: PI_BIN });
    const entries = [
      message("a1b2c3d4", null, "user", "first question"),
      assistant("b1b2c3d4", "a1b2c3d4", "first answer"),
      message("c1b2c3d4", "b1b2c3d4", "user", "second question"),
    ];
    expect(
      await h.server.command(
        { type: "session.restore", thread_id: THREAD, part: 0, final: true, header, entries },
        30_000,
      ),
    ).toMatchObject({ ok: true, data: { entries: 3 } });

    const restored = await piCommand({ type: "get_entries" });
    expect(restored).toMatchObject({ ok: true });
    const ids = (restored as { data: { entries: { id: string }[] } }).data.entries.map((e) => e.id);
    expect(ids.slice(0, 3)).toEqual(["a1b2c3d4", "b1b2c3d4", "c1b2c3d4"]);
    expect(await piCommand({ type: "get_fork_messages" })).toMatchObject({
      ok: true,
      data: { messages: [{ entryId: "a1b2c3d4" }, { entryId: "c1b2c3d4" }] },
    });

    // Edit-and-regenerate the second question: branch at the first answer.
    const branched = await h.server.command(
      runStart("second question, edited", { parent_entry_id: "b1b2c3d4" }),
      30_000,
    );
    expect(branched).toMatchObject({ ok: false, error: { code: "pi_rejected" } }); // no API key
    const after = await piCommand({ type: "get_entries", since: "c1b2c3d4" });
    const tail = (after as { data: { entries: Record<string, unknown>[]; leafId: string } }).data;
    const marker = tail.entries.find((e) => e.type === "custom");
    expect(marker).toMatchObject({ parentId: "b1b2c3d4", customType: "kobe.branch" });
    // Pi resumed on the branch: the abandoned question is no longer in its context.
    const state = await piCommand({ type: "get_state" });
    expect(state).toMatchObject({ ok: true, data: { messageCount: 2 } });
    expect(RUN).not.toBe(RUN_2);
  }, 60_000);
});
