import { MODEL_ALIAS_PATTERN, SKILL_EVAL_RUN_MODES, SKILL_EVAL_RUN_STATES } from "@kobe/db";
import {
  EVAL_MODEL_ALIAS_PATTERN,
  SKILL_EVAL_MODES,
  SKILL_EVAL_RUN_STATUSES,
} from "@kobe/protocol";
import { describe, expect, it } from "vitest";

// The DB's lists mirror the 324 contract (asked for by the KOBE-324 handoff).
describe("eval contract mirrors (KOBE-325)", () => {
  it("keeps the model alias pattern, run states and modes equal in @kobe/db and @kobe/protocol", () => {
    expect(EVAL_MODEL_ALIAS_PATTERN.source).toBe(MODEL_ALIAS_PATTERN);
    expect([...SKILL_EVAL_RUN_STATES]).toEqual([...SKILL_EVAL_RUN_STATUSES]);
    expect([...SKILL_EVAL_RUN_MODES]).toEqual([...SKILL_EVAL_MODES]);
  });
});
