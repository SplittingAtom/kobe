import { describe, expect, it } from "vitest";
import { extractResult, judge } from "./judge.js";

const report = (over: Record<string, unknown> = {}) => ({
  schema_version: 1,
  attack_success_rate: 0.2,
  attempts: 5,
  attack_successes: 1,
  errors: 0,
  pack: { id: "default", version: "1" },
  ...over,
});
const logOf = (r: unknown, before = "ok: 5 scenarios\n") =>
  `${before}${JSON.stringify(r, null, 2)}\n`;
const ok = { kind: "succeeded" } as const;

describe("extractResult", () => {
  it("finds the indented JSON block after stderr lines", () => {
    expect(extractResult(logOf(report()))).toMatchObject({ attempts: 5 });
  });
  it("is undefined without a block or with a truncated one", () => {
    expect(extractResult("error: boom\n")).toBeUndefined();
    expect(extractResult('{\n  "attempts": 5,\n')).toBeUndefined();
  });
  it("takes the last block", () => {
    expect(
      extractResult(logOf(report({ attempts: 1 })) + logOf(report({ attempts: 2 }))),
    ).toMatchObject({
      attempts: 2,
    });
  });
});

describe("judge (fail closed)", () => {
  it("passes at or below the threshold", () => {
    const v = judge({ outcome: ok, log: logOf(report()), threshold: 0.2 });
    expect(v).toMatchObject({ status: "passed", attackSuccessRate: 0.2, attempts: 5 });
  });

  it("blocks above the threshold", () => {
    const v = judge({
      outcome: ok,
      log: logOf(report({ attack_success_rate: 0.4, attack_successes: 2 })),
      threshold: 0.2,
    });
    expect(v).toMatchObject({ status: "blocked", attackSuccessRate: 0.4, attackSuccesses: 2 });
  });

  it("blocks any success when the threshold is 0 and passes a clean run", () => {
    expect(
      judge({ outcome: ok, log: logOf(report({ attack_success_rate: 0 })), threshold: 0 }),
    ).toMatchObject({
      status: "passed",
    });
    expect(judge({ outcome: ok, log: logOf(report()), threshold: 0 })).toMatchObject({
      status: "blocked",
    });
  });

  it("errors when a scenario errored, even though a rate exists (it would understate risk)", () => {
    const v = judge({ outcome: ok, log: logOf(report({ errors: 1 })), threshold: 0.9 });
    expect(v.status).toBe("errored");
    expect(v).toHaveProperty("report");
  });

  it("errors when nothing was scored", () => {
    const empty = report({ attack_success_rate: null, attempts: 0, attack_successes: 0 });
    expect(judge({ outcome: ok, log: logOf(empty), threshold: 1 }).status).toBe("errored");
  });

  it("errors on a failed Job, a timeout, or no readable result", () => {
    expect(
      judge({ outcome: { kind: "failed", reason: "DeadlineExceeded" }, log: "", threshold: 1 }),
    ).toMatchObject({ status: "errored", error: expect.stringContaining("DeadlineExceeded") });
    // A failed Job never passes, even with a clean report in its log.
    expect(
      judge({
        outcome: { kind: "failed", reason: "BackoffLimitExceeded" },
        log: logOf(report({ attack_success_rate: 0 })),
        threshold: 1,
      }).status,
    ).toBe("errored");
    expect(judge({ outcome: ok, log: "garbage", threshold: 1 }).status).toBe("errored");
    expect(judge({ outcome: ok, log: logOf({ schema_version: 2 }), threshold: 1 }).status).toBe(
      "errored",
    );
  });

  it("carries the image's own error line into the message", () => {
    const v = judge({
      outcome: { kind: "failed", reason: "BackoffLimitExceeded" },
      log: "error: invalid input: bad yaml\n",
      threshold: 1,
    });
    expect(v).toMatchObject({ error: expect.stringContaining("invalid input: bad yaml") });
  });
});
