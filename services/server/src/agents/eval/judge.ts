import { z } from "zod";
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
  const attackSuccessRate = report.attack_success_rate;
  return {
    status: attackSuccessRate > input.threshold + 1e-9 ? "blocked" : "passed",
    attackSuccessRate,
    attempts: report.attempts,
    attackSuccesses: report.attack_successes,
    report,
  };
}
