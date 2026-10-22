import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { KobeDb } from "@kobe/db";
import { BudgetMonitor, type Evaluation } from "./monitor.js";

const TEAM = "6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f";

/** A monitor whose evaluations are scripted: each one waits for the test, then answers. */
function scripted() {
  const monitor = new BudgetMonitor({
    db: {} as KobeDb,
    connectionString: "postgres://unused",
    runs: { stopForBudget: () => Promise.resolve([]) },
    mailer: { send: () => Promise.resolve() } as never,
    publicUrl: "http://kobe.test",
    logger: pino({ level: "silent" }),
  });
  const started: { finish: (e: Evaluation) => void }[] = [];
  Object.defineProperty(monitor, "evaluateOnce", {
    value: () =>
      new Promise<Evaluation>((finish) => {
        started.push({ finish });
      }),
  });
  return { monitor, started };
}

const none: Evaluation = { alerts: 0, stopped: [] };
const bob: Evaluation = { alerts: 0, stopped: ["user:bob"] };

describe("BudgetMonitor.evaluate (KOBE-415)", () => {
  it("runs again after an evaluation already under way, which may have read before the spend", async () => {
    const { monitor, started } = scripted();
    const first = monitor.evaluate(TEAM); // e.g. a budget change, before the usage landed
    const second = monitor.evaluate(TEAM); // after the usage landed
    const third = monitor.evaluate(TEAM); // joins the second: one follow-up for both
    expect(started).toHaveLength(1);
    started[0]?.finish(none);
    expect(await first).toEqual(none);
    await vi.waitFor(() => expect(started).toHaveLength(2));
    started[1]?.finish(bob);
    expect(await second).toEqual(bob);
    expect(await third).toEqual(bob);
    // Nothing under way: the next call starts at once.
    const fourth = monitor.evaluate(TEAM);
    expect(started).toHaveLength(3);
    started[2]?.finish(none);
    expect(await fourth).toEqual(none);
  });

  it("skips a follow-up asked for before close() once the running one ends", async () => {
    const { monitor, started } = scripted();
    const first = monitor.evaluate(TEAM);
    const second = monitor.evaluate(TEAM);
    const closing = monitor.close();
    started[0]?.finish(bob);
    await closing;
    expect(await first).toEqual(bob);
    expect(await second).toEqual({ alerts: 0, stopped: [] });
    expect(started).toHaveLength(1);
  });
});
