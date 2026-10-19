import { parseSkillEvalSuite } from "@kobe/protocol/skill-evals";
import type { SkillEvalCase } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { evalChecks, matchWithTimeout, type EvalObservation } from "./checks.js";

function suiteCase(yaml: string, fixtures: string[] = []): SkillEvalCase {
  const res = parseSkillEvalSuite(yaml, { paths: fixtures.map((f) => `evals/${f}`) });
  if (!res.ok) throw new Error(JSON.stringify(res.issues));
  const c = res.suite.cases[0];
  if (!c) throw new Error("no case");
  return c;
}

const obs = (over: Partial<EvalObservation> = {}): EvalObservation => ({
  answer: "Total: 42",
  skillUses: 1,
  costUsd: 0.1,
  turns: 3,
  overTurnLimit: false,
  deniedToolCalls: 0,
  snapshot: { walks: [] },
  ...over,
});

describe("evalChecks (KOBE-325)", () => {
  it("passes every expected check, in contract order", async () => {
    const c = suiteCase(
      `cases:\n  - id: a\n    prompt: p\n    expect: {triggers: true, contains: Total, matches: "\\\\d+", max_cost_usd: 1, no_denied_tools: true}\n`,
    );
    const r = await evalChecks(c, true, obs(), []);
    expect(r.status).toBe("passed");
    expect(r.checks.map((x) => x.check)).toEqual([
      "triggers",
      "contains",
      "matches",
      "max_cost_usd",
      "max_turns",
      "no_denied_tools",
    ]);
  });

  it("names each failure's reason", async () => {
    const c = suiteCase(
      `cases:\n  - id: a\n    prompt: p\n    expect: {triggers: true, contains: Nope, matches: "^x$", max_cost_usd: 0.01, max_turns: 2, no_denied_tools: true}\n`,
    );
    const r = await evalChecks(c, true, obs({ skillUses: 0, deniedToolCalls: 1 }), []);
    expect(r.status).toBe("failed");
    expect(Object.fromEntries(r.checks.map((x) => [x.check, x.reason]))).toEqual({
      triggers: "not_triggered",
      contains: "no_match",
      matches: "no_match",
      max_cost_usd: "over_limit",
      max_turns: "over_limit",
      no_denied_tools: "denied",
    });
  });

  it("reports an unexpected trigger and makes no trigger check without the skill", async () => {
    const neg = suiteCase(`cases:\n  - id: a\n    prompt: p\n    expect: {triggers: false}\n`);
    const r = await evalChecks(neg, true, obs(), []);
    expect(r.checks[0]).toMatchObject({
      check: "triggers",
      passed: false,
      reason: "unexpected_trigger",
    });
    const beh = suiteCase(
      `cases:\n  - id: a\n    prompt: p\n    expect: {triggers: true, contains: Total}\n`,
    );
    const base = await evalChecks(beh, false, obs({ skillUses: 0 }), []);
    expect(base.checks.map((x) => x.check)).toEqual(["contains", "max_turns"]);
    expect(base.status).toBe("passed");
  });

  it("fails max_turns when the run was stopped for one more turn, and passes ending on the last", async () => {
    const c = suiteCase(
      `cases:\n  - id: a\n    prompt: p\n    expect: {contains: Total, max_turns: 3}\n`,
    );
    expect((await evalChecks(c, true, obs({ turns: 3 }), [])).status).toBe("passed");
    const over = await evalChecks(c, true, obs({ turns: 3, overTurnLimit: true }), []);
    expect(over.checks.find((x) => x.check === "max_turns")?.reason).toBe("over_limit");
  });

  it("checks outputs against the after-snapshot (only produced files count)", async () => {
    const c = suiteCase(
      `cases:\n  - id: a\n    prompt: p\n    files: [fixtures/in.csv]\n    expect: {outputs: ["outputs/*.txt"]}\n`,
      ["fixtures/in.csv"],
    );
    const none = await evalChecks(
      c,
      true,
      obs({ snapshot: { walks: [{ root: "outputs/", entries: [], truncated: false }] } }),
      [],
    );
    expect(none.checks[0]).toMatchObject({ check: "outputs", reason: "not_produced" });
    const made = await evalChecks(
      c,
      true,
      obs({
        snapshot: {
          walks: [
            {
              root: "outputs/",
              entries: [{ path: "outputs/r.txt", type: "file", size: 3 }],
              truncated: false,
            },
          ],
        },
      }),
      [{ path: "in.csv", sha256: "a".repeat(64) }],
    );
    expect(made.status).toBe("passed");
    const noSnap = await evalChecks(c, true, obs({ snapshot: null }), []);
    expect(noSnap.checks[0]).toMatchObject({ check: "outputs", reason: "not_produced" });
  });

  it("skips the judge once another check failed, and fails it until a judge is wired", async () => {
    const c = suiteCase(
      `cases:\n  - id: a\n    prompt: p\n    expect: {contains: Nope, judge: "Good."}\n`,
    );
    let called = 0;
    const judge = async () => {
      called += 1;
      return { kind: "passed" as const, costUsd: 0.01 };
    };
    const r = await evalChecks(c, true, obs(), [], { judge });
    expect(called).toBe(0);
    expect(r.checks.map((x) => x.check)).toEqual(["contains", "max_turns"]);
    const ok = suiteCase(
      `cases:\n  - id: a\n    prompt: p\n    expect: {contains: Total, judge: "Good."}\n`,
    );
    const unwired = await evalChecks(ok, true, obs(), []);
    expect(unwired.checks.find((x) => x.check === "judge")?.reason).toBe("judge_failed");
    const judged = await evalChecks(ok, true, obs(), [], { judge });
    expect(judged.status).toBe("passed");
    expect(judged.judgeCostUsd).toBe(0.01);
  });

  it("reads only the first 64 Ki characters of the answer", async () => {
    const c = suiteCase(`cases:\n  - id: a\n    prompt: p\n    expect: {contains: END}\n`);
    const r = await evalChecks(c, true, obs({ answer: `${"x".repeat(70_000)}END` }), []);
    expect(r.checks[0]?.reason).toBe("no_match");
  });
});

describe("matchWithTimeout (KOBE-325)", () => {
  it("matches with the u flag and the case's flags", () => {
    expect(matchWithTimeout("\\p{L}+", "", "héllo")).toBe(true);
    expect(matchWithTimeout("^total", "i", "Total")).toBe(true);
  });

  it("gives up on catastrophic backtracking instead of stalling the server", () => {
    const started = Date.now();
    expect(matchWithTimeout("^(a+)+$", "", `${"a".repeat(40)}!`)).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
