import pino from "pino";
import { describe, expect, it } from "vitest";
import { SERVER_CALL_LIMITS } from "@kobe/protocol";
import { AppendError } from "../event-stream/append.js";
import { runEpilogue, type EpilogueDeps } from "./epilogue.js";

const THREAD = "2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f60";
const log = pino({ level: "silent" });

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function deps(over: Partial<EpilogueDeps> = {}) {
  const appended: { type: string; payload: unknown }[] = [];
  const saved: string[] = [];
  const d: EpilogueDeps = {
    threadId: THREAD,
    saveTitle: async (t) => {
      saved.push(t);
      return true;
    },
    append: async (e) => {
      appended.push(e);
    },
    log,
    ...over,
  };
  return { d, appended, saved };
}

describe("runEpilogue (KOBE-234)", () => {
  it("starts the title and follow-up calls together, each with its own timeout", async () => {
    const title = deferred<string | undefined>();
    const followups = deferred<readonly string[] | undefined>();
    const started: string[] = [];
    const signals: AbortSignal[] = [];
    const { d, appended } = deps({
      title: (signal) => {
        started.push("title");
        signals.push(signal);
        return title.promise;
      },
      followups: (signal) => {
        started.push("followups");
        signals.push(signal);
        return followups.promise;
      },
    });
    const done = runEpilogue(d);
    await Promise.resolve();
    // Both are in flight before either answered: never back to back.
    expect(started).toEqual(["title", "followups"]);
    expect(signals.every((s) => !s.aborted)).toBe(true);
    followups.resolve(["By month?"]);
    title.resolve("Revenue by region");
    expect(await done).toEqual({ title: "saved", followups: "sent" });
    expect(appended.map((e) => e.type).sort()).toEqual(["thread.suggestions", "thread.updated"]);
    expect(SERVER_CALL_LIMITS.followups.timeout_ms).toBeGreaterThan(0);
  });

  it("keeps the title saved when its event is refused (the window closed)", async () => {
    const { d, saved } = deps({
      title: async () => "Revenue by region",
      append: async () => {
        throw new AppendError("epilogue_refused", "the epilogue window has closed");
      },
    });
    expect(await runEpilogue(d)).toEqual({ title: "saved_event_refused" });
    expect(saved).toEqual(["Revenue by region"]);
  });

  it("writes no event when the thread was renamed meanwhile, and survives failures", async () => {
    const { d, appended } = deps({
      title: async () => "Revenue",
      saveTitle: async () => false,
      followups: async () => {
        throw new Error("gateway 402 budget_soft_limit");
      },
    });
    expect(await runEpilogue(d)).toEqual({ title: "locked", followups: "failed" });
    expect(appended).toEqual([]);
  });

  it("skips an empty answer", async () => {
    const { d, appended } = deps({ title: async () => undefined, followups: async () => [] });
    expect(await runEpilogue(d)).toEqual({ title: "skipped", followups: "skipped" });
    expect(appended).toEqual([]);
  });
});
