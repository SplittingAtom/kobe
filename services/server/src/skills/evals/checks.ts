import { runInNewContext } from "node:vm";
import {
  EVAL_ANSWER_CHECK_MAX_CHARS,
  EVAL_CHECK_DETAIL_MAX_CHARS,
  EVAL_MATCH_TIMEOUT_MS,
  checkEvalOutputs,
  expectedChecks,
  type EvalFixtureFile,
  type EvalWorkspaceEntry,
  type EvalWorkspaceSnapshot,
  type SkillEvalCase,
  type SkillEvalCheck,
  type SkillEvalCheckReason,
  type SkillEvalCheckResult,
} from "@kobe/protocol";

// The checks of one eval execution (KOBE-325, contract KOBE-324 `docs/skill-evals.md`): pure, on
// the server, from what the run recorded (skill uses, cost, turns, denials) and the sandbox's
// after-snapshot. The judge is a seam (KOBE-326); until it is wired a `judge` check fails
// `judge_failed`.

/** What one finished attempt left behind, as the runner collected it. */
export interface EvalObservation {
  /** The run's final assistant answer. */
  readonly answer: string;
  /** Recorded reads of the skill (`runs.skills_used`). */
  readonly skillUses: number;
  /** Model spend of this attempt (judge excluded). */
  readonly costUsd: number;
  /** Model calls of this attempt's run. */
  readonly turns: number;
  /** The runner stopped the run because it wanted a turn past `max_turns`. */
  readonly overTurnLimit: boolean;
  /** `policy.denied` events of the run (auto-mode would-ask denials included). */
  readonly deniedToolCalls: number;
  /** The sandbox's after-snapshot; null when it could not be taken. */
  readonly snapshot: EvalWorkspaceSnapshot | null;
}

export type EvalJudgeResult =
  | { readonly kind: "passed"; readonly costUsd: number; readonly reason?: string }
  | { readonly kind: "rejected"; readonly costUsd: number; readonly reason?: string }
  | { readonly kind: "failed" | "unparseable"; readonly costUsd: number };

/** The judge seam (KOBE-326): grade the answer and the matched outputs against the rubric. */
export type EvalJudge = (input: {
  readonly rubric: string;
  readonly prompt: string;
  readonly answer: string;
  readonly outputs: readonly EvalWorkspaceEntry[];
}) => Promise<EvalJudgeResult>;

export interface EvalChecksResult {
  readonly status: "passed" | "failed";
  readonly checks: SkillEvalCheckResult[];
  readonly judgeCostUsd: number;
}

const pass = (check: SkillEvalCheck): SkillEvalCheckResult => ({ check, passed: true });
const fail = (
  check: SkillEvalCheck,
  reason: SkillEvalCheckReason,
  detail?: string,
): SkillEvalCheckResult =>
  detail
    ? { check, passed: false, reason, detail: detail.slice(0, EVAL_CHECK_DETAIL_MAX_CHARS) }
    : { check, passed: false, reason };

/**
 * Whether `pattern` (with `u` and the case's flags) finds a match in `text`, or `"timeout"` after
 * {@link EVAL_MATCH_TIMEOUT_MS}: evaluated in a fresh VM context with a timeout, so an author's
 * catastrophic pattern never stalls the server's event loop.
 */
export function matchWithTimeout(
  pattern: string,
  flags: string,
  text: string,
): boolean | "timeout" {
  try {
    return runInNewContext(
      "new RegExp(p, f).test(s)",
      { p: pattern, f: `u${flags}`, s: text },
      { timeout: EVAL_MATCH_TIMEOUT_MS },
    ) as boolean;
  } catch (err) {
    if ((err as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return "timeout";
    // The parser refused the pattern at upload; one that fails here simply doesn't match.
    return false;
  }
}

function containsCheck(c: SkillEvalCase, answer: string): SkillEvalCheckResult {
  const texts = c.expect.contains ?? [];
  const missing = texts.find((t) => !answer.includes(t));
  return missing === undefined
    ? pass("contains")
    : fail("contains", "no_match", `the answer doesn't contain ${JSON.stringify(missing)}`);
}

function matchesCheck(c: SkillEvalCase, answer: string): SkillEvalCheckResult {
  for (const m of c.expect.matches ?? []) {
    const hit = matchWithTimeout(m.pattern, m.flags ?? "", answer);
    if (hit === "timeout") return fail("matches", "match_timeout", m.pattern);
    if (!hit) return fail("matches", "no_match", m.pattern);
  }
  return pass("matches");
}

function outputsCheck(
  c: SkillEvalCase,
  o: EvalObservation,
  fixtures: readonly EvalFixtureFile[],
): { result: SkillEvalCheckResult; files: readonly EvalWorkspaceEntry[] } {
  if (!o.snapshot)
    return { result: fail("outputs", "not_produced", "no workspace snapshot"), files: [] };
  const r = checkEvalOutputs(c.expect.outputs ?? [], fixtures, o.snapshot);
  return r.passed
    ? { result: pass("outputs"), files: r.files }
    : { result: fail("outputs", r.reason ?? "not_produced", r.detail), files: [] };
}

/** Every check but the judge's, keyed by check. */
function plainChecks(
  c: SkillEvalCase,
  o: EvalObservation,
  fixtures: readonly EvalFixtureFile[],
  wanted: readonly SkillEvalCheck[],
): { results: Map<SkillEvalCheck, SkillEvalCheckResult>; files: readonly EvalWorkspaceEntry[] } {
  const answer = o.answer.slice(0, EVAL_ANSWER_CHECK_MAX_CHARS);
  const results = new Map<SkillEvalCheck, SkillEvalCheckResult>();
  let files: readonly EvalWorkspaceEntry[] = [];
  for (const check of wanted) {
    if (check === "triggers") {
      const triggered = o.skillUses > 0;
      results.set(
        check,
        triggered === c.expect.triggers
          ? pass(check)
          : fail(check, triggered ? "unexpected_trigger" : "not_triggered"),
      );
    } else if (check === "outputs") {
      const out = outputsCheck(c, o, fixtures);
      results.set(check, out.result);
      files = out.files;
    } else if (check === "contains") results.set(check, containsCheck(c, answer));
    else if (check === "matches") results.set(check, matchesCheck(c, answer));
    else if (check === "max_cost_usd") {
      const max = c.expect.max_cost_usd ?? Infinity;
      results.set(
        check,
        o.costUsd <= max ? pass(check) : fail(check, "over_limit", `$${o.costUsd} > $${max}`),
      );
    } else if (check === "max_turns") {
      const over = o.overTurnLimit || o.turns > c.expect.max_turns;
      results.set(check, over ? fail(check, "over_limit") : pass(check));
    } else if (check === "no_denied_tools") {
      results.set(
        check,
        o.deniedToolCalls === 0
          ? pass(check)
          : fail(check, "denied", `${o.deniedToolCalls} denied tool call(s)`),
      );
    }
  }
  return { results, files };
}

const JUDGE_REASON: Record<"failed" | "unparseable", SkillEvalCheckReason> = {
  failed: "judge_failed",
  unparseable: "judge_unparseable",
};

/**
 * The checks of one execution in contract order, and its status. The judge runs last and only
 * when every other check passed (the estimate counts on it); without a judge it fails.
 */
export async function evalChecks(
  c: SkillEvalCase,
  withSkill: boolean,
  o: EvalObservation,
  fixtures: readonly EvalFixtureFile[],
  opts: { readonly judge?: EvalJudge } = {},
): Promise<EvalChecksResult> {
  const wanted = expectedChecks(c, withSkill);
  const { results, files } = plainChecks(c, o, fixtures, wanted);
  let judgeCostUsd = 0;
  if (wanted.includes("judge") && [...results.values()].every((r) => r.passed)) {
    const verdict = opts.judge
      ? await opts.judge({
          rubric: c.expect.judge ?? "",
          prompt: c.prompt,
          answer: o.answer.slice(0, EVAL_ANSWER_CHECK_MAX_CHARS),
          outputs: files,
        })
      : ({ kind: "failed", costUsd: 0 } as const);
    judgeCostUsd = verdict.costUsd;
    results.set(
      "judge",
      verdict.kind === "passed"
        ? pass("judge")
        : verdict.kind === "rejected"
          ? fail("judge", "judge_rejected", verdict.reason)
          : fail("judge", JUDGE_REASON[verdict.kind]),
    );
  }
  const checks = wanted.flatMap((k) => results.get(k) ?? []);
  const passed = checks.length === wanted.length && checks.every((r) => r.passed);
  return { status: passed ? "passed" : "failed", checks, judgeCostUsd };
}
