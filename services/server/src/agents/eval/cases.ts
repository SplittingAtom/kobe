import { EVAL_CASE_SUITE, evalCasesFile } from "@kobe/db";
import type { EvalCaseContent } from "@kobe/protocol";

/**
 * Shared eval cases as the eval image's extra suite (KOBE-276): the agent's accepted cases, frozen
 * into the eval when it starts (`orbit_evals.case_ids`). Their text never sits in a Kubernetes
 * object (review S2): the Job runs with `--gateway-cases` and fetches `cases.json` from the model
 * gateway with its own eval token, which reads it from Postgres while the eval runs
 * (`@kobe/db` `loadEvalCaseFile`). The image reports ids and pass/fail only.
 */

export const CASE_SUITE = EVAL_CASE_SUITE;
/**
 * Largest `cases.json` the gate starts an eval with. The case limits make this unreachable in
 * practice; past it the publish is refused, never trimmed.
 */
export const EVAL_CASES_MAX_BYTES = 768 * 1024;

export interface AcceptedCase {
  readonly id: string;
  readonly content: EvalCaseContent;
  readonly expected: string;
}

/** The `cases.json` text for `cases` (null: no cases); what the gateway serves the Job. */
export function casesFile(cases: readonly AcceptedCase[]): string | null {
  return evalCasesFile(
    cases.map((c) => ({
      id: c.id,
      content: c.content as unknown as Record<string, unknown>,
      expected: c.expected,
    })),
  );
}
