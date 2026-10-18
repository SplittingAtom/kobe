import { afterEach, describe, expect, it } from "vitest";
import {
  RUN,
  RUN_2,
  THREAD,
  runStart,
  silentLogger,
  startHarness,
  until,
  type Harness,
} from "./testing/harness.js";

/**
 * Stop while a run is still being prepared, before Pi has its prompt (KOBE-227, Gate 5 U19): the
 * workspace pull before a run can take a while, and a Stop then used to abort an idle Pi twice
 * (5 s each), kill it, and leave the start to prompt a Pi that was gone ("could not start Pi"),
 * while the next message met the stopped run still holding the thread ("Pi could not take the
 * prompt"). Nothing has reached Pi yet, so there is nothing to abort: the run ends at once and its
 * start never prompts.
 */
let h: Harness;
afterEach(async () => {
  expect(h.server.violations).toEqual([]);
  await h.close();
});

/** Workspace hooks whose first `beforeRun` waits until released (a slow pull). */
function slowFirstPull() {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  const calls: string[] = [];
  return {
    calls,
    release: () => release(),
    hooks: () => ({
      beforeRun: (frame: { run_id: string }) => {
        calls.push(frame.run_id);
        return calls.length === 1 ? held : Promise.resolve();
      },
      runEnded: () => undefined,
      flush: () => Promise.resolve(),
    }),
  };
}

const stop = (runId: string) => ({
  type: "run.stop",
  run_id: runId,
  thread_id: THREAD,
  mode: "abort",
  reason: "user_cancelled",
});

describe("Stop before Pi has the run's prompt", () => {
  it("ends the run at once; its start never prompts, and Pi keeps running", async () => {
    const pull = slowFirstPull();
    const warnings: string[] = [];
    h = await startHarness({
      workspace: pull.hooks,
      logger: {
        ...silentLogger,
        warn: (_obj: Record<string, unknown>, msg: string) => void warnings.push(msg),
      } as typeof silentLogger,
    });
    const started = h.server.command(runStart("say:first"), 30_000);
    await until(() => pull.calls.includes(RUN));

    const t0 = Date.now();
    expect(await h.server.command(stop(RUN), 30_000)).toMatchObject({ ok: true });
    // Nothing to abort in Pi: no 2 × 5 s settle wait, no killed process.
    expect(Date.now() - t0).toBeLessThan(2_000);
    pull.release();
    expect(await started).toMatchObject({ ok: false, error: { code: "run_not_active" } });

    const log = await h.commandsLog();
    expect(log.find((c) => c.type === "prompt")).toBeUndefined();
    expect(h.exits).toEqual([]);
    expect(warnings.some((w) => w.includes("stopped before Pi took its prompt"))).toBe(true);
  });

  it("the next run starts while the stopped one's preparation is still pending, and keeps the thread", async () => {
    const pull = slowFirstPull();
    h = await startHarness({ workspace: pull.hooks });
    const first = h.server.command(runStart("say:first"), 30_000);
    await until(() => pull.calls.includes(RUN));
    expect(await h.server.command(stop(RUN), 30_000)).toMatchObject({ ok: true });

    // The second message is not refused as "thread has an active run".
    const second = await h.server.command({ ...runStart("hang"), run_id: RUN_2 }, 30_000);
    expect(second).toMatchObject({ ok: true });

    // The first start finishing late must not end the second run.
    pull.release();
    expect(await first).toMatchObject({ ok: false, error: { code: "run_not_active" } });
    const steer = { type: "run.steer", run_id: RUN_2, thread_id: THREAD, message: "still there?" };
    expect(await h.server.command(steer)).toMatchObject({ ok: true });
    const prompts = (await h.commandsLog()).filter((c) => c.type === "prompt");
    expect(prompts.map((c) => c.message)).toEqual(["hang"]);
  });
});
