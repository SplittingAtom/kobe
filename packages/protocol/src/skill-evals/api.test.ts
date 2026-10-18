import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageHash, runtimeHash, runtimeZip } from "../node/index.js";
import {
  EVAL_CASES_PATH,
  SKILL_EVAL_DEFAULT_LIMITS,
  SKILL_EVAL_USAGE_KINDS,
  skillEvalCompletedPayloadSchema,
  skillEvalJudgeVerdictSchema,
  skillEvalLimitsSchema,
  skillEvalProgressPayloadSchema,
  skillEvalRunSchema,
  skillEvalStartedSchema,
  skillEvalSubjectSchema,
  startSkillEvalBodySchema,
  teamEvalCapSchema,
} from "./index.js";

const ID = "0b6d3a52-4c1e-4f7a-9d2b-1a2b3c4d5e01";
const HASH = "a".repeat(64);
const utf8 = (s: string) => new TextEncoder().encode(s);

/** Entry names of a stored zip (local headers in order; the canonical zip has no extras). */
function zipNames(zip: Uint8Array): string[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const names: string[] = [];
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const extra = view.getUint16(at + 28, true);
    names.push(new TextDecoder().decode(zip.subarray(at + 30, at + 30 + nameLength)));
    at += 30 + nameLength + extra + size;
  }
  return names;
}

describe("the runtime bundle never carries evals/ (KOBE-324 ac-3, SK15)", () => {
  const cases = readFileSync(join(import.meta.dirname, "fixtures/cases/valid-full.yaml"));
  const pkg = new Map([
    ["SKILL.md", utf8("---\nname: quarterly-report\ndescription: x\n---\n")],
    ["scripts/build.py", utf8("print(1)\n")],
    [EVAL_CASES_PATH, new Uint8Array(cases)],
    ["evals/fixtures/sales.csv", utf8("region,total\nnorth,1\n")],
    ["evals/fixtures/regions/map.json", utf8("{}")],
  ]);

  it("leaves every evals/ file out of the runtime zip and keeps it in the package", () => {
    expect(zipNames(runtimeZip(pkg))).toEqual(["SKILL.md", "scripts/build.py"]);
    expect(runtimeHash(pkg)).not.toBe(packageHash(pkg));
  });

  it("gives the same runtime hash whatever the suite holds, and a new package hash", () => {
    const edited = new Map(pkg);
    edited.set(EVAL_CASES_PATH, utf8("cases: []\n"));
    edited.set("evals/fixtures/extra.bin", new Uint8Array([0, 1, 2]));
    const bare = new Map([...pkg].filter(([p]) => !p.startsWith("evals/")));
    expect(runtimeHash(edited)).toBe(runtimeHash(pkg));
    expect(runtimeHash(bare)).toBe(runtimeHash(pkg));
    expect(packageHash(edited)).not.toBe(packageHash(pkg));
  });
});

describe("eval run API shapes", () => {
  it("names a draft revision or a saved version as the subject", () => {
    expect(skillEvalSubjectSchema.safeParse({ kind: "draft", draftId: ID, rev: 3 }).success).toBe(
      true,
    );
    expect(
      skillEvalSubjectSchema.safeParse({ kind: "version", scope: "team", skillId: ID, seq: 2 })
        .success,
    ).toBe(true);
    expect(
      skillEvalSubjectSchema.safeParse({ kind: "version", scope: "catalog", skillId: ID, seq: 2 })
        .success,
    ).toBe(false);
    expect(startSkillEvalBodySchema.safeParse({ mode: "full" }).success).toBe(true);
    expect(startSkillEvalBodySchema.safeParse({ mode: "full", skip: ["x"] }).success).toBe(false);
  });

  it("returns an estimate that may be unknown", () => {
    const started = {
      evalRunId: ID,
      estimate: { executions: 5, costUsd: null, minutes: null, basis: "none" },
    };
    expect(skillEvalStartedSchema.safeParse(started).success).toBe(true);
    expect(
      skillEvalStartedSchema.safeParse({
        ...started,
        estimate: { executions: 5, costUsd: 0.8, minutes: 4, basis: "team_history" },
      }).success,
    ).toBe(true);
  });

  it("describes a run with its progress and, when done, its scorecard", () => {
    const run = {
      id: ID,
      subject: { kind: "draft", draftId: ID, rev: 1 },
      packageHash: HASH,
      mode: "with_only",
      status: "running",
      progress: { done: 1, total: 3 },
      scorecard: null,
      failure: null,
      startedBy: ID,
      startedAt: "2026-10-18T09:00:00.000Z",
      finishedAt: null,
    };
    expect(skillEvalRunSchema.safeParse(run).success).toBe(true);
    expect(skillEvalRunSchema.safeParse({ ...run, progress: { done: 4, total: 3 } }).success).toBe(
      false,
    );
    expect(
      skillEvalRunSchema.safeParse({
        ...run,
        status: "failed",
        failure: { code: "eval_cap_reached", message: "The team's monthly eval cap is spent." },
        finishedAt: "2026-10-18T09:00:01.000Z",
      }).success,
    ).toBe(true);
  });

  it("streams progress and completion as numbers and ids only", () => {
    expect(
      skillEvalProgressPayloadSchema.safeParse({
        evalRunId: ID,
        done: 2,
        total: 5,
        caseId: "q3-workbook",
        withSkill: false,
        status: "failed",
      }).success,
    ).toBe(true);
    expect(
      skillEvalCompletedPayloadSchema.safeParse({
        evalRunId: ID,
        status: "completed",
        passRate: 1,
        baselinePassRate: null,
        lift: null,
      }).success,
    ).toBe(true);
    expect(
      skillEvalProgressPayloadSchema.safeParse({
        evalRunId: ID,
        done: 2,
        total: 5,
        caseId: "q3",
        withSkill: true,
        status: "passed",
        answer: "Paris",
      }).success,
    ).toBe(false);
  });

  it("bounds the Site limits and the team cap", () => {
    expect(skillEvalLimitsSchema.parse({})).toEqual(SKILL_EVAL_DEFAULT_LIMITS);
    expect(SKILL_EVAL_DEFAULT_LIMITS).toEqual({
      maxConcurrentSandboxes: 4,
      maxCases: 25,
      caseWallClockMinutes: 10,
    });
    expect(skillEvalLimitsSchema.safeParse({ maxCases: 26 }).success).toBe(false);
    expect(skillEvalLimitsSchema.safeParse({ caseWallClockMinutes: 11 }).success).toBe(false);
    expect(skillEvalLimitsSchema.safeParse({ maxConcurrentSandboxes: 0 }).success).toBe(false);
    expect(teamEvalCapSchema.safeParse({ usd: 50 }).success).toBe(true);
    expect(teamEvalCapSchema.safeParse({ tokens: 2_000_000 }).success).toBe(true);
    expect(teamEvalCapSchema.safeParse({ usd: 50, tokens: 1 }).success).toBe(false);
    expect(teamEvalCapSchema.safeParse(null).success).toBe(true);
    expect(SKILL_EVAL_USAGE_KINDS).toEqual(["eval", "eval_judge"]);
  });

  it("takes a judge verdict with a short reason", () => {
    expect(skillEvalJudgeVerdictSchema.safeParse({ passed: true, reason: "ok" }).success).toBe(
      true,
    );
    expect(
      skillEvalJudgeVerdictSchema.safeParse({ passed: true, reason: "x".repeat(1001) }).success,
    ).toBe(false);
  });
});
