import type { EvalCaseContent } from "@kobe/protocol";

/**
 * Shared eval cases as the eval image's extra suite (KOBE-276): the agent's accepted cases, frozen
 * when the eval starts, written to the Job's ConfigMap as `cases.json` next to the agent's YAML.
 * The file holds the copied exchanges and the owner's expected behaviour (case content the Job
 * needs to replay and grade them) and nothing else: no member, no thread, no credential. The
 * image reports ids and pass/fail only (`images/orbit-eval/kobe_orbit_eval/cases.py`).
 */

/** `images/orbit-eval/kobe_orbit_eval/cases.py` SUITE_ID and SCHEMA_VERSION. */
export const CASE_SUITE = { id: "shared-cases", schemaVersion: 1 } as const;
export const EVAL_CASES_FILE = "cases.json";
/**
 * Largest `cases.json`: a ConfigMap holds at most 1 MiB with the agent's YAML beside it. The
 * case limits make this unreachable in practice; past it the publish is refused, never trimmed.
 */
export const EVAL_CASES_MAX_BYTES = 768 * 1024;

export interface AcceptedCase {
  readonly id: string;
  readonly content: EvalCaseContent;
  readonly expected: string;
}

/** The `cases.json` text for `cases` (null: no cases, no file). */
export function casesFile(cases: readonly AcceptedCase[]): string | null {
  if (cases.length === 0) return null;
  return `${JSON.stringify({
    schema_version: CASE_SUITE.schemaVersion,
    suite: CASE_SUITE.id,
    cases: cases.map((c) => ({
      id: c.id,
      prompt: c.content.prompt,
      earlier: c.content.earlier ?? [],
      tool_outputs: c.content.tool_outputs ?? [],
      attachments: c.content.attachments ?? [],
      rated_answer: c.content.answer,
      reasons: c.content.reasons ?? [],
      comment: c.content.comment ?? null,
      expected: c.expected,
    })),
  })}\n`;
}
