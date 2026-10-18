import { z } from "zod";
import { globSchema } from "../glob.js";
import { EVALS_DIR, packagePathProblem } from "../skill-package/layout.js";

/**
 * `evals/cases.yaml` (KOBE-324, spec SK15): a skill's eval suite. It lives in the package, never
 * in the runtime bundle (`runtimeFiles` drops `evals/**`, so neither the suite nor its fixtures
 * reach a sandbox that loads the skill, and editing them never changes the runtime hash).
 *
 * Text rules as `kobe.skill.yaml`: UTF-8, at most {@link EVAL_CASES_MAX_BYTES}, one YAML 1.2
 * (core schema) document whose root is a mapping, duplicate keys and aliases refused.
 * {@link parseSkillEvalSuite} applies them and returns located issues for Workbench lint.
 *
 * Unknown keys are refused at every level: a check Kobe does not know is never skipped (that
 * would pass a case silently). A new expectation therefore needs a new contract, and a format that
 * older Kobe must refuse a new `apiVersion`. `apiVersion` may be left out (skills written for
 * other tools have none); it then means v1.
 */

export const SKILL_EVALS_API_VERSION = "kobe.dev/skill-evals/v1";
export const EVAL_CASES_PATH = `${EVALS_DIR}cases.yaml`;
/** Fixture paths in a case are relative to `evals/` and start with this. */
export const EVAL_FIXTURES_PREFIX = "fixtures/";
export const EVAL_CASES_MAX_BYTES = 64 * 1024;

/** SK18: at most 25 cases per suite (a Site may lower it, never raise it). */
export const EVAL_MAX_CASES = 25;
export const EVAL_CASE_ID_PATTERN = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
export const EVAL_PROMPT_MAX_CHARS = 8000;
export const EVAL_MAX_FILES_PER_CASE = 20;
export const EVAL_MAX_OUTPUTS = 10;
export const EVAL_MAX_CONTAINS = 10;
export const EVAL_CONTAINS_MAX_CHARS = 500;
export const EVAL_MAX_MATCHES = 10;
export const EVAL_MATCH_MAX_CHARS = 256;
/** Flags a `matches` pattern may add; `u` is always on. */
export const EVAL_MATCH_FLAGS = ["i", "m", "s"] as const;
export const EVAL_RUBRIC_MAX_CHARS = 2000;
/** SK15: `max_turns` defaults to 20. */
export const EVAL_MAX_TURNS_DEFAULT = 20;
export const EVAL_MAX_TURNS_MAX = 100;
export const EVAL_MAX_COST_USD_MAX = 50;
/**
 * The final answer `contains` and `matches` read: its first this many characters. Each pattern
 * gets at most {@link EVAL_MATCH_TIMEOUT_MS} (the runner evaluates it off the event loop or under
 * a VM timeout); a pattern that runs out of time fails its check (`match_timeout`), so an author's
 * regular expression can never stall the server.
 */
export const EVAL_ANSWER_CHECK_MAX_CHARS = 64 * 1024;
export const EVAL_MATCH_TIMEOUT_MS = 100;
/** A model alias as the model catalog writes it (`@kobe/db` MODEL_ALIAS_PATTERN). */
export const EVAL_MODEL_ALIAS_PATTERN = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/;
/**
 * Roots of `/workspace` an eval may not write fixtures to or count as outputs: skill folders and
 * hidden (dot) folders, where Kobe and Pi keep their own state.
 */
const RESERVED_WORKSPACE_ROOT = /^(skills(\/|$)|\.)/;
/** Text an author writes: no C0 controls but tab, newline and carriage return, no DEL. */
// eslint-disable-next-line no-control-regex
const TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u;

const text = (max: number, what: string) =>
  z
    .string({ error: what })
    .trim()
    .min(1, { error: what })
    .max(max, { error: what })
    .regex(TEXT, { error: `${what} No control characters.` });

const uniqueList = <T extends z.ZodType>(item: T, max: number, what: string) =>
  z
    .array(item, { error: what })
    .min(1, { error: what })
    .max(max, { error: what })
    .superRefine((xs, ctx) => {
      const seen = new Map<string, number>();
      xs.forEach((x, i) => {
        const key = JSON.stringify(x);
        const first = seen.get(key);
        if (first === undefined) seen.set(key, i);
        else
          ctx.addIssue({
            code: "custom",
            path: [i],
            message: `the same as item ${first}; list each one once.`,
            params: { kobe: "duplicate" },
          });
      });
    });

/** A single value is a list of one: `contains: Total` is `contains: [Total]`. */
const listOf = <T extends z.ZodType>(item: T, max: number, what: string) =>
  z.preprocess(
    (v) => (typeof v === "string" || isPlainObject(v) ? [v] : v),
    uniqueList(item, max, what),
  );

function isPlainObject(v: unknown): boolean {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Why `pattern` with `flags` is not a regular expression the runner can compile, or null. */
export function evalMatchProblem(pattern: string, flags = ""): string | null {
  try {
    new RegExp(pattern, `u${flags}`);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const FLAGS = new RegExp(`^(?!.*(.).*\\1)[${EVAL_MATCH_FLAGS.join("")}]{0,3}$`);

const matchSchema = z.preprocess(
  (v) => (typeof v === "string" ? { pattern: v } : v),
  z
    .strictObject(
      {
        pattern: z
          .string({ error: "a regular expression." })
          .min(1, { error: `1 to ${EVAL_MATCH_MAX_CHARS} characters.` })
          .max(EVAL_MATCH_MAX_CHARS, { error: `1 to ${EVAL_MATCH_MAX_CHARS} characters.` }),
        flags: z
          .string({ error: "flags are text." })
          .regex(FLAGS, { error: "flags are some of i, m and s, each once." })
          .optional(),
      },
      { error: "a regular expression, or { pattern, flags }." },
    )
    .superRefine((m, ctx) => {
      if (typeof m.pattern !== "string") return;
      const problem = evalMatchProblem(m.pattern, m.flags);
      if (problem !== null)
        ctx.addIssue({
          code: "custom",
          message: `not a regular expression (${problem.replace(/\.$/, "")}).`,
          params: { kobe: "bad_pattern" },
        });
    }),
);

/** An output glob: Kobe's glob grammar, relative to `/workspace` (`outputs/*.xlsx`). */
const outputGlob = globSchema.superRefine((g, ctx) => {
  const segments = g.split("/");
  if (
    g.startsWith("/") ||
    g.includes("\\") ||
    segments.some((s) => s === ".." || s === "." || s === "") ||
    RESERVED_WORKSPACE_ROOT.test(g)
  )
    ctx.addIssue({
      code: "custom",
      message:
        "a glob relative to /workspace, such as outputs/*.xlsx, outside skills/ and hidden folders.",
      params: { kobe: "invalid_value" },
    });
});

/** A fixture: `fixtures/<path>`, a package path below `evals/fixtures/`. */
const fixturePath = z
  .string({ error: "a path such as fixtures/sales.csv." })
  .superRefine((f, ctx) => {
    const below = f.startsWith(EVAL_FIXTURES_PREFIX) ? f.slice(EVAL_FIXTURES_PREFIX.length) : "";
    if (below === "" || packagePathProblem(`${EVALS_DIR}${f}`) !== null)
      ctx.addIssue({
        code: "custom",
        message:
          "case files come from evals/fixtures/: write fixtures/<name>, such as fixtures/sales.csv.",
        params: { kobe: "invalid_value" },
      });
    else if (RESERVED_WORKSPACE_ROOT.test(below))
      ctx.addIssue({
        code: "custom",
        message: "a fixture can't land in skills/ or a hidden folder of /workspace.",
        params: { kobe: "invalid_value" },
      });
  });

/** Where a fixture lands, relative to `/workspace`: its path below `fixtures/`. */
export function fixtureWorkspacePath(fixture: string): string {
  return fixture.slice(EVAL_FIXTURES_PREFIX.length);
}

/** Checks that judge what the run did; a case needs one of these or `triggers`. */
export const EVAL_BEHAVIOUR_CHECKS = ["outputs", "contains", "matches", "judge"] as const;

export const skillEvalExpectSchema = z
  .strictObject(
    {
      /** Whether the skill was read (KOBE-297 detection). Checked with the skill only. */
      triggers: z.boolean({ error: "true or false." }).optional(),
      /** Every glob matches at least one file the run produced under `/workspace`. */
      outputs: uniqueList(
        outputGlob,
        EVAL_MAX_OUTPUTS,
        `1 to ${EVAL_MAX_OUTPUTS} globs.`,
      ).optional(),
      /** Every text appears in the final answer (case-sensitive). */
      contains: listOf(
        text(EVAL_CONTAINS_MAX_CHARS, `text of 1 to ${EVAL_CONTAINS_MAX_CHARS} characters.`),
        EVAL_MAX_CONTAINS,
        `a text or a list of 1 to ${EVAL_MAX_CONTAINS} texts.`,
      ).optional(),
      /** Every pattern finds a match in the final answer. */
      matches: listOf(
        matchSchema,
        EVAL_MAX_MATCHES,
        `a regular expression or a list of 1 to ${EVAL_MAX_MATCHES}.`,
      ).optional(),
      /** A rubric the judge model grades the answer and outputs against (SK17). */
      judge: text(
        EVAL_RUBRIC_MAX_CHARS,
        `a rubric of 1 to ${EVAL_RUBRIC_MAX_CHARS} characters.`,
      ).optional(),
      /** The run's model spend for this case at most (judge spend not included). */
      max_cost_usd: z
        .number({ error: `a number of dollars above 0 and at most ${EVAL_MAX_COST_USD_MAX}.` })
        .gt(0, { error: `a number of dollars above 0 and at most ${EVAL_MAX_COST_USD_MAX}.` })
        .max(EVAL_MAX_COST_USD_MAX, {
          error: `a number of dollars above 0 and at most ${EVAL_MAX_COST_USD_MAX}.`,
        })
        .optional(),
      /** Model turns at most; the runner ends the case's run there. */
      max_turns: z
        .number({ error: `a whole number from 1 to ${EVAL_MAX_TURNS_MAX}.` })
        .int({ error: `a whole number from 1 to ${EVAL_MAX_TURNS_MAX}.` })
        .min(1, { error: `a whole number from 1 to ${EVAL_MAX_TURNS_MAX}.` })
        .max(EVAL_MAX_TURNS_MAX, { error: `a whole number from 1 to ${EVAL_MAX_TURNS_MAX}.` })
        .default(EVAL_MAX_TURNS_DEFAULT),
      /** The run never hit a policy denial (in auto mode, anything that would ask is denied). */
      no_denied_tools: z.boolean({ error: "true or false." }).optional(),
    },
    { error: "a mapping of expectations." },
  )
  .superRefine((e, ctx) => {
    if (e.triggers === undefined && !EVAL_BEHAVIOUR_CHECKS.some((k) => e[k] !== undefined))
      ctx.addIssue({
        code: "custom",
        message: "needs at least one of triggers, outputs, contains, matches or judge.",
        params: { kobe: "no_expectation" },
      });
  });

export const skillEvalCaseSchema = z.strictObject(
  {
    id: z
      .string({
        error: "lowercase letters, digits and hyphens, up to 64 characters, such as q3-workbook.",
      })
      .regex(EVAL_CASE_ID_PATTERN, {
        error: "lowercase letters, digits and hyphens, up to 64 characters, such as q3-workbook.",
      }),
    prompt: text(
      EVAL_PROMPT_MAX_CHARS,
      `the message the eval sends, 1 to ${EVAL_PROMPT_MAX_CHARS} characters.`,
    ),
    /** Fixtures copied into the case's empty `/workspace` ({@link fixtureWorkspacePath}). */
    files: uniqueList(
      fixturePath,
      EVAL_MAX_FILES_PER_CASE,
      `a list of 1 to ${EVAL_MAX_FILES_PER_CASE} fixtures.`,
    ).default([]),
    expect: skillEvalExpectSchema,
  },
  { error: "a case: a mapping with id, prompt and expect." },
);

export const skillEvalSuiteSchema = z.strictObject(
  {
    apiVersion: z
      .literal(SKILL_EVALS_API_VERSION, {
        error: `must be ${SKILL_EVALS_API_VERSION} or left out; a newer format needs a newer Kobe.`,
      })
      .optional(),
    /** A catalog model alias; the team default runs when the team hasn't enabled it (SK17). */
    model: z
      .string({ error: "a model alias from the catalog, such as smart." })
      .regex(EVAL_MODEL_ALIAS_PATTERN, { error: "a model alias from the catalog, such as smart." })
      .optional(),
    cases: z
      .array(skillEvalCaseSchema, { error: "a list of cases." })
      .min(1, { error: `a suite has 1 to ${EVAL_MAX_CASES} cases.` })
      .max(EVAL_MAX_CASES, { error: `a suite has 1 to ${EVAL_MAX_CASES} cases.` })
      .superRefine((cases, ctx) => {
        const first = new Map<string, number>();
        cases.forEach((c, i) => {
          const at = first.get(c.id);
          if (at === undefined) first.set(c.id, i);
          else
            ctx.addIssue({
              code: "custom",
              path: [i, "id"],
              message: `${c.id} is already the id of cases[${at}]; each case needs its own id.`,
              params: { kobe: "duplicate" },
            });
        });
      }),
  },
  { error: "a mapping with a cases list." },
);

export type SkillEvalSuite = z.infer<typeof skillEvalSuiteSchema>;
export type SkillEvalCase = z.infer<typeof skillEvalCaseSchema>;
export type SkillEvalExpect = z.infer<typeof skillEvalExpectSchema>;
export interface SkillEvalMatch {
  readonly pattern: string;
  readonly flags?: string;
}
