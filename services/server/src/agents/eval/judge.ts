import { z } from "zod";
import { CASE_SUITE } from "./cases.js";
import { EVAL_EPOCHS, EXPECTED_PACK } from "./pack.js";

/**
 * Reads the eval image's result and decides (KOBE-93). Exit semantics are fail closed: the image
 * exits 0 only when every scenario was scored; 1 when a scenario errored (the result is still
 * written, and its rate understates risk), 2 for bad input and 3 for a failed run. So only a
 * Job that succeeded with a complete report can pass or block; anything else is `errored`: nothing
 * is published, and the person may retry (a retry is a new eval).
 */

/** The fields of result.json (schema_version 1, images/orbit-eval/kobe_orbit_eval/report.py) we use. */
export const evalResultSchema = z.looseObject({
  schema_version: z.literal(1),
  attack_success_rate: z.number().min(0).max(1).nullable(),
  attempts: z.number().int().nonnegative(),
  attack_successes: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  pack: z.looseObject({ id: z.string(), version: z.union([z.string(), z.number()]) }),
  /** The shared-case suite (KOBE-276), present when the eval ran cases. Ids and outcomes only. */
  cases: z
    .looseObject({
      suite: z.string(),
      cases: z.number().int().nonnegative(),
      scored: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      errors: z.number().int().nonnegative(),
      results: z.array(
        z.looseObject({ id: z.string(), status: z.enum(["passed", "failed", "error"]) }),
      ),
    })
    .optional(),
});
export type EvalResult = z.infer<typeof evalResultSchema>;

/** Where the Job ended, from its status conditions (not from anything the pod says). */
export type JobOutcome =
  { readonly kind: "succeeded" } | { readonly kind: "failed"; readonly reason: string };

export type Verdict =
  | {
      readonly status: "passed" | "blocked";
      readonly attackSuccessRate: number;
      readonly attempts: number;
      readonly attackSuccesses: number;
      /** Shared cases scored and failed (null: the eval ran none). */
      readonly caseScored?: number | null;
      readonly caseFailures?: number | null;
      readonly report: EvalResult;
    }
  | {
      readonly status: "errored";
      readonly error: string;
      /** The report when one was received (kept for diagnosis even though it is not trusted). */
      readonly report?: EvalResult;
    };

const MAX_ERROR = 500;

/**
 * The result JSON in a pod's log: the image prints it indented on stdout (`{` and `}` at column
 * 0), after any stderr lines. Takes the last such block.
 */
export function extractResult(log: string): unknown {
  const lines = log.split("\n");
  const start = lines.lastIndexOf("{");
  if (start < 0) return undefined;
  const end = lines.indexOf("}", start);
  if (end < 0) return undefined;
  try {
    return JSON.parse(lines.slice(start, end + 1).join("\n")) as unknown;
  } catch {
    return undefined;
  }
}

/** The part of the log worth keeping in an error message: the image's own `error:` lines. */
function imageError(log: string): string | undefined {
  const line = log.split("\n").findLast((l) => l.startsWith("error: "));
  return line?.slice(7, 7 + 300);
}

export function judge(input: {
  readonly outcome: JobOutcome;
  readonly log: string;
  /** The team's ceiling when the eval was requested. */
  readonly threshold: number;
  /** The shared cases frozen into the eval (KOBE-276); the result must cover exactly these. */
  readonly caseIds?: readonly string[];
}): Verdict {
  const parsed = evalResultSchema.safeParse(extractResult(input.log));
  const report = parsed.success ? parsed.data : undefined;
  const errored = (error: string): Verdict => ({
    status: "errored",
    error: error.slice(0, MAX_ERROR),
    ...(report ? { report } : {}),
  });
  if (input.outcome.kind === "failed") {
    const detail = imageError(input.log);
    return errored(
      `The eval Job failed (${input.outcome.reason})${detail ? `: ${detail}` : ""}. ` +
        "Nothing was published.",
    );
  }
  if (!report)
    return errored("The eval finished without a readable result. Nothing was published.");
  if (
    report.pack.id !== EXPECTED_PACK.id ||
    String(report.pack.version) !== String(EXPECTED_PACK.version) ||
    report.attempts + report.errors !== EXPECTED_PACK.scenarios * EVAL_EPOCHS
  ) {
    return errored(
      "The eval result is not for the expected scenario pack or did not run every scenario. " +
        "Nothing was published.",
    );
  }
  if (report.errors > 0 || report.attack_success_rate === null || report.attempts === 0) {
    return errored(
      `The eval could not score every scenario (${report.errors} errored, ${report.attempts} scored), ` +
        "so its rate would understate the risk. Nothing was published.",
    );
  }
  const cases = judgeCases(report, input.caseIds ?? []);
  if (!cases.ok) return errored(cases.error);
  const attackSuccessRate = report.attack_success_rate;
  const above = (rate: number) => rate > input.threshold + 1e-9;
  const caseRate = cases.scored === null ? null : (cases.failed ?? 0) / cases.scored;
  return {
    status:
      above(attackSuccessRate) || (caseRate !== null && above(caseRate)) ? "blocked" : "passed",
    attackSuccessRate,
    attempts: report.attempts,
    attackSuccesses: report.attack_successes,
    caseScored: cases.scored,
    caseFailures: cases.failed,
    report,
  };
}

type CaseCheck =
  | { readonly ok: true; readonly scored: number | null; readonly failed: number | null }
  | { readonly ok: false; readonly error: string };

/**
 * The shared-case suite's part of a verdict (fail closed): with cases frozen into the eval, the
 * result must hold that suite, one outcome for each of exactly those cases, and none errored.
 * Without cases, a result that claims some is not trusted either.
 */
function judgeCases(report: EvalResult, caseIds: readonly string[]): CaseCheck {
  const suite = report.cases;
  if (caseIds.length === 0) {
    return suite === undefined
      ? { ok: true, scored: null, failed: null }
      : {
          ok: false,
          error: "The eval result has shared cases this eval did not send. Nothing was published.",
        };
  }
  const ids = new Set(caseIds);
  const seen = new Set(suite?.results.map((r) => r.id) ?? []);
  if (
    !suite ||
    suite.suite !== CASE_SUITE.id ||
    suite.cases !== ids.size ||
    suite.results.length !== ids.size ||
    seen.size !== ids.size ||
    ![...seen].every((id) => ids.has(id)) ||
    suite.scored + suite.errors !== ids.size ||
    suite.failed !== suite.results.filter((r) => r.status === "failed").length
  ) {
    return {
      ok: false,
      error: "The eval result did not run every shared case. Nothing was published.",
    };
  }
  if (suite.errors > 0 || suite.results.some((r) => r.status === "error")) {
    return {
      ok: false,
      error:
        `The eval could not grade every shared case (${suite.errors} errored), so it can't ` +
        "say whether they pass. Nothing was published.",
    };
  }
  return { ok: true, scored: suite.scored, failed: suite.failed };
}
