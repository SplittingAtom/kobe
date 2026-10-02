import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EXAMPLE_IDS } from "@kobe/protocol/testing";
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_PI } from "../testing/harness.js";
import { ThreadManager } from "./manager.js";

const noop = () => undefined;
const hooks = {
  runStarted: noop,
  piEvent: noop,
  runEnded: noop,
  uiRequest: noop,
  piExited: noop,
  policyCheck: noop,
  policyChannelClosed: noop,
  diagnostic: noop,
};

let dir: string | undefined;
let manager: ThreadManager | undefined;
afterEach(async () => {
  await manager?.shutdown(100);
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

describe("ThreadManager beforeRun seam (KOBE-27)", () => {
  it("gives up a run whose workspace preparation does not finish in time", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "kobe-mgr-"));
    manager = new ThreadManager({
      bin: FAKE_PI,
      agentDir: dir,
      workspaceDir: dir,
      sessionDir: path.join(dir, "sessions"),
      home: path.join(dir, "home"),
      hooks,
      maxProcesses: 2,
      idleMs: 60_000,
      restoreMaxBytes: 1_000_000,
      parentEnv: { PATH: process.env.PATH },
      beforeRun: () => new Promise(() => undefined),
      beforeRunTimeoutMs: 50,
    });
    const frame = {
      v: 1 as const,
      type: "run.start" as const,
      command_id: "c1",
      run_id: EXAMPLE_IDS.run,
      thread_id: EXAMPLE_IDS.thread,
      message: "say:x",
    };
    expect(await manager.startRun(frame)).toEqual({
      ok: false,
      code: "internal",
      message: "workspace preparation timed out",
    });
    expect(manager.activeRuns()).toEqual([]);
  });
});
