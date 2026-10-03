import { pino } from "pino";
import { describe, expect, it, vi } from "vitest";
import { BlockedReporter, type BlockedAttempt } from "./blocked-reporter.js";

const attempt: BlockedAttempt = {
  teamId: "0b5e8f1c-2d3a-4b5c-8d9e-0f1a2b3c4d5e",
  userId: "2d7a0b3e-4f5c-4d7e-8fa0-2b3c4d5e6f70",
  sandboxId: "4f9c2d5a-6b7e-4f90-8bc2-4d5e6f708192",
  domain: "pypi.org",
  port: 443,
  reason: "not_enabled",
  requestAccess: true,
  threadHint: undefined,
};

describe("BlockedReporter", () => {
  it("reports once per sandbox, host and reason per window", async () => {
    let t = 0;
    const sink = vi.fn().mockResolvedValue(undefined);
    const reporter = new BlockedReporter({ sink, logger: pino({ level: "silent" }), now: () => t });
    reporter.report(attempt);
    reporter.report(attempt);
    reporter.report({ ...attempt, domain: "registry.npmjs.org" });
    t = 31_000;
    reporter.report(attempt);
    await reporter.drain();
    expect(sink).toHaveBeenCalledTimes(3);
  });

  it("caps reports per sandbox across hosts (random-host floods)", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    const reporter = new BlockedReporter({
      sink,
      logger: pino({ level: "silent" }),
      perSandbox: { burst: 5, perSecond: 0 },
    });
    for (let i = 0; i < 500; i++) reporter.report({ ...attempt, domain: `r${i}.example.com` });
    reporter.report({ ...attempt, sandboxId: "5a0d3e6b-7c8f-4a01-9cd3-5e6f708192a3" });
    await reporter.drain();
    expect(sink).toHaveBeenCalledTimes(6);
  });

  it("never throws when the write fails, and bounds writes in flight", async () => {
    const sink = vi.fn(
      () => new Promise<void>((_, reject) => setTimeout(() => reject(new Error("x")), 5)),
    );
    const reporter = new BlockedReporter({
      sink,
      logger: pino({ level: "silent" }),
      maxInFlight: 2,
    });
    for (const domain of ["a.com", "b.com", "c.com"]) reporter.report({ ...attempt, domain });
    await reporter.drain();
    expect(sink).toHaveBeenCalledTimes(2);
  });
});
