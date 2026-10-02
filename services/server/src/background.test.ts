import { describe, expect, it, vi } from "vitest";
import { BackgroundTasks } from "./background.js";
import { logger } from "./logger.js";

/** A promise and the function that resolves it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("BackgroundTasks", () => {
  it("is idle at once with nothing in flight", async () => {
    await expect(new BackgroundTasks().idle()).resolves.toBeUndefined();
  });

  it("starts a task synchronously and idle() waits for it", async () => {
    const tasks = new BackgroundTasks();
    const gate = deferred();
    const events: string[] = [];
    tasks.run("failed", async () => {
      events.push("started");
      await gate.promise;
      events.push("done");
    });
    expect(events).toEqual(["started"]);
    const idle = tasks.idle().then(() => events.push("idle"));
    await Promise.resolve();
    expect(events).toEqual(["started"]);
    gate.resolve();
    await idle;
    expect(events).toEqual(["started", "done", "idle"]);
  });

  it("waits for tasks started by tasks while it waits", async () => {
    const tasks = new BackgroundTasks();
    const gate = deferred();
    let nestedDone = false;
    tasks.run("failed", async () => {
      await gate.promise;
      tasks.run("failed", async () => {
        await new Promise((r) => setTimeout(r, 5));
        nestedDone = true;
      });
    });
    const idle = tasks.idle();
    gate.resolve();
    await idle;
    expect(nestedDone).toBe(true);
  });

  it("logs a failure with its context instead of rejecting", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      const tasks = new BackgroundTasks();
      const boom = new Error("SMTP down");
      tasks.run("email failed", () => Promise.reject(boom), { userId: "u1" });
      await tasks.idle();
      expect(error).toHaveBeenCalledWith({ err: boom, userId: "u1" }, "email failed");
    } finally {
      error.mockRestore();
    }
  });
});
