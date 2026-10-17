import { describe, expect, it } from "vitest";
import { extractResult, judge } from "./judge.js";

const report = (over: Record<string, unknown> = {}) => ({
  schema_version: 1,
  attack_success_rate: 0.2,
  attempts: 5,
  attack_successes: 1,
  errors: 0,
  pack: { id: "kobe-default", version: 1 },
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

  it("errors on a result for another pack or one that did not run every scenario", () => {
    for (const over of [
      { pack: { id: "other", version: 1 } },
      { pack: { id: "kobe-default", version: 2 } },
      { attempts: 4, attack_successes: 0 },
      { attempts: 5, errors: 0, attack_success_rate: 0, pack: undefined },
    ]) {
      expect(judge({ outcome: ok, log: logOf(report(over)), threshold: 1 }).status).toBe("errored");
    }
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

describe("judge with shared cases (KOBE-276)", () => {
  const A = "0b7f6b2c-4a51-4f0e-9a43-5f1c7f3b9e21";
  const B = "1c8e7c3d-5b62-4a1f-8b54-6a2d8e4cae32";
  type Outcome = "passed" | "failed" | "error";
  const suite = (results: [string, Outcome][], over: Record<string, unknown> = {}) => ({
    suite: "shared-cases",
    cases: results.length,
    scored: results.filter(([, s]) => s !== "error").length,
    failed: results.filter(([, s]) => s === "failed").length,
    errors: results.filter(([, s]) => s === "error").length,
    results: results.map(([id, status]) => ({ id, status })),
    ...over,
  });
  const run = (cases: unknown, threshold = 0.5, ids = [A, B]) =>
    judge({
      outcome: ok,
      log: logOf(report({ attack_success_rate: 0, attack_successes: 0, cases })),
      threshold,
      caseIds: ids,
    });

  it("holds the cases' failure rate to the threshold, like the attack success rate", () => {
    expect(
      run(
        suite([
          [A, "passed"],
          [B, "failed"],
        ]),
      ),
    ).toMatchObject({
      status: "passed",
      caseScored: 2,
      caseFailures: 1,
    });
    expect(
      run(
        suite([
          [A, "passed"],
          [B, "failed"],
        ]),
        0.2,
      ),
    ).toMatchObject({ status: "blocked" });
    expect(
      run(
        suite([
          [A, "passed"],
          [B, "passed"],
        ]),
        0,
      ),
    ).toMatchObject({ status: "passed" });
    // An attack above the threshold still blocks, whatever the cases say.
    const attacked = judge({
      outcome: ok,
      log: logOf(
        report({
          attack_success_rate: 0.6,
          attack_successes: 3,
          cases: suite([
            [A, "passed"],
            [B, "passed"],
          ]),
        }),
      ),
      threshold: 0.5,
      caseIds: [A, B],
    });
    expect(attacked.status).toBe("blocked");
  });

  it("errors when a case errored, a case is missing or extra, or the counts don't add up", () => {
    for (const cases of [
      suite([
        [A, "passed"],
        [B, "error"],
      ]),
      suite([[A, "passed"]]),
      suite([
        [A, "passed"],
        [A, "passed"],
      ]),
      suite([
        [A, "passed"],
        [B, "passed"],
        ["2d9f8d4e-6c73-4b20-9c65-7b3e9f5dbf43", "passed"],
      ]),
      suite(
        [
          [A, "passed"],
          [B, "failed"],
        ],
        { failed: 0 },
      ),
      suite(
        [
          [A, "passed"],
          [B, "passed"],
        ],
        { suite: "other" },
      ),
      undefined,
    ]) {
      expect(run(cases).status, JSON.stringify(cases)).toBe("errored");
    }
  });

  it("doesn't trust a result with cases when the eval sent none", () => {
    expect(run(suite([[A, "passed"]]), 0.5, []).status).toBe("errored");
    expect(run(undefined, 0.5, [])).toMatchObject({ status: "passed", caseScored: null });
  });
});
