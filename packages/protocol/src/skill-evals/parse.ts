import { isMap, isScalar, isSeq, LineCounter, parseDocument, visit, type Document } from "yaml";
import type { z } from "zod";
import { EVALS_DIR } from "../skill-package/layout.js";
import { MANIFEST_YAML_OPTIONS } from "../skill-package/manifest.js";
import {
  EVAL_CASES_MAX_BYTES,
  EVAL_CASES_PATH,
  skillEvalSuiteSchema,
  type SkillEvalSuite,
} from "./cases.js";

/**
 * Reading `evals/cases.yaml` with located, sentence-form issues (KOBE-324 ac-2): what Workbench
 * lint shows on every edit and what the eval runner refuses before it starts a sandbox. The same
 * function runs in the browser and on the server, so both say the same thing about a file.
 */

export const SKILL_EVAL_ISSUE_CODES = [
  "too_large",
  "yaml_syntax",
  "yaml_duplicate_key",
  "yaml_alias",
  "not_a_mapping",
  "missing",
  "invalid_type",
  "invalid_value",
  "out_of_range",
  "unknown_key",
  "duplicate",
  "no_expectation",
  "bad_pattern",
  "fixture_missing",
] as const;
export type SkillEvalIssueCode = (typeof SKILL_EVAL_ISSUE_CODES)[number];

export interface SkillEvalIssue {
  /** Always `evals/cases.yaml`: the file to open. */
  readonly file: string;
  readonly code: SkillEvalIssueCode;
  /** Where in the document, as `cases[2].expect.max_turns`; empty for the whole file. */
  readonly path: string;
  /** A sentence that names the place and says what is expected. */
  readonly message: string;
  /** 1-based position of the offending node (or its nearest existing parent). */
  readonly line: number;
  readonly column: number;
}

export type SkillEvalParseResult =
  | { readonly ok: true; readonly suite: SkillEvalSuite; readonly issues: readonly [] }
  | { readonly ok: false; readonly issues: readonly SkillEvalIssue[] };

export interface ParseSkillEvalSuiteOptions {
  /** Every path of the package; when given, each case's `files` must be among them. */
  readonly paths?: Iterable<string>;
}

type Segment = string | number;

const UNKNOWN_KEY = "unknown key. Kobe refuses what it does not know rather than skip a check.";

function pathText(path: readonly Segment[]): string {
  return path.reduce<string>(
    (out, s) => (typeof s === "number" ? `${out}[${s}]` : out === "" ? s : `${out}.${s}`),
    "",
  );
}

function sentence(path: string, message: string, missing = false): string {
  const body = /[.!?]$/.test(message) ? message : `${message}.`;
  if (path === "") return body.charAt(0).toUpperCase() + body.slice(1);
  return missing ? `${path} is missing: ${body}` : `${path}: ${body}`;
}

/**
 * Walks `path` in the YAML tree; returns the node reached (or the nearest one that exists) and the
 * path as the file spells it: a list index into a single value (`contains: Total` read as a list
 * of one) is dropped, so the issue points at what the author wrote.
 */
function locate(doc: Document, path: readonly Segment[], keyOf = false) {
  let node: unknown = doc.contents;
  const shown: Segment[] = [];
  for (const [i, seg] of path.entries()) {
    const last = i === path.length - 1;
    if (typeof seg === "number" && isSeq(node) && node.items[seg] !== undefined) {
      node = node.items[seg];
      shown.push(seg);
    } else if (typeof seg === "number" && seg === 0 && !isSeq(node)) {
      continue;
    } else if (typeof seg === "string" && isMap(node)) {
      const pair = node.items.find((p) => isScalar(p.key) && p.key.value === seg);
      shown.push(seg);
      if (!pair) return { node, shown: [...shown, ...path.slice(i + 1)] };
      node = last && keyOf ? pair.key : pair.value;
    } else return { node, shown: [...shown, ...path.slice(i)] };
  }
  return { node, shown };
}

function rangeStart(node: unknown): number {
  const range = (node as { range?: [number, number, number] } | null)?.range;
  return range ? range[0] : 0;
}

function valueAt(value: unknown, path: readonly Segment[]): unknown {
  let at = value;
  for (const seg of path) {
    if (at === null || typeof at !== "object") return undefined;
    at = (at as Record<Segment, unknown>)[seg];
  }
  return at;
}

function codeOf(issue: z.core.$ZodIssue, raw: unknown): SkillEvalIssueCode {
  switch (issue.code) {
    case "custom": {
      const code = (issue.params as { kobe?: SkillEvalIssueCode } | undefined)?.kobe;
      return code ?? "invalid_value";
    }
    case "invalid_type":
      return valueAt(raw, issue.path as Segment[]) === undefined ? "missing" : "invalid_type";
    case "too_big":
    case "too_small":
      return "out_of_range";
    case "unrecognized_keys":
      return "unknown_key";
    default:
      return "invalid_value";
  }
}

function schemaIssues(doc: Document, lines: LineCounter, raw: unknown, error: z.ZodError) {
  const out: SkillEvalIssue[] = [];
  const add = (code: SkillEvalIssueCode, path: Segment[], message: string, keyOf = false) => {
    const { node, shown } = locate(doc, path, keyOf);
    const where = pathText(shown);
    const pos = lines.linePos(rangeStart(node));
    out.push({
      file: EVAL_CASES_PATH,
      code,
      path: where,
      message: sentence(where, message, code === "missing"),
      line: pos.line,
      column: pos.col,
    });
  };
  for (const issue of error.issues) {
    const path = issue.path.filter((s): s is Segment => typeof s !== "symbol");
    if (issue.code === "unrecognized_keys")
      for (const key of issue.keys) add("unknown_key", [...path, key], UNKNOWN_KEY, true);
    else add(codeOf(issue, raw), path, issue.message);
  }
  return out;
}

function fixtureIssues(
  doc: Document,
  lines: LineCounter,
  suite: SkillEvalSuite,
  paths: Iterable<string>,
) {
  const present = new Set(paths);
  const out: SkillEvalIssue[] = [];
  suite.cases.forEach((c, i) =>
    c.files.forEach((f, j) => {
      const full = `${EVALS_DIR}${f}`;
      if (present.has(full)) return;
      const { node, shown } = locate(doc, ["cases", i, "files", j]);
      const where = pathText(shown);
      const pos = lines.linePos(rangeStart(node));
      out.push({
        file: EVAL_CASES_PATH,
        code: "fixture_missing",
        path: where,
        message: sentence(where, `${full} is not in the skill.`),
        line: pos.line,
        column: pos.col,
      });
    }),
  );
  return out;
}

const fileIssue = (
  code: SkillEvalIssueCode,
  message: string,
  pos: { line: number; col: number } = { line: 1, col: 1 },
): SkillEvalIssue => ({
  file: EVAL_CASES_PATH,
  code,
  path: "",
  message: sentence("", message),
  line: pos.line,
  column: pos.col,
});

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const CASE_ID_PATH = /^cases\[\d+\]\.id$/;

function duplicateIdIssues(doc: Document, lines: LineCounter, raw: unknown): SkillEvalIssue[] {
  const cases = valueAt(raw, ["cases"]);
  if (!Array.isArray(cases)) return [];
  const first = new Map<string, number>();
  const out: SkillEvalIssue[] = [];
  cases.forEach((c: unknown, i) => {
    const id = valueAt(c, ["id"]);
    if (typeof id !== "string") return;
    const at = first.get(id);
    if (at === undefined) {
      first.set(id, i);
      return;
    }
    const { node, shown } = locate(doc, ["cases", i, "id"]);
    const where = pathText(shown);
    const pos = lines.linePos(rangeStart(node));
    out.push({
      file: EVAL_CASES_PATH,
      code: "duplicate",
      path: where,
      message: sentence(
        where,
        `${id} is already the id of cases[${at}]; each case needs its own id.`,
      ),
      line: pos.line,
      column: pos.col,
    });
  });
  return out;
}

const byPosition = (a: SkillEvalIssue, b: SkillEvalIssue) =>
  a.line - b.line || a.column - b.column || a.path.localeCompare(b.path);

/** Parses and checks `evals/cases.yaml`: the suite with defaults applied, or every issue found. */
export function parseSkillEvalSuite(
  text: string,
  options: ParseSkillEvalSuiteOptions = {},
): SkillEvalParseResult {
  if (new TextEncoder().encode(text).length > EVAL_CASES_MAX_BYTES)
    return {
      ok: false,
      issues: [
        fileIssue(
          "too_large",
          `${EVAL_CASES_PATH} is larger than ${EVAL_CASES_MAX_BYTES / 1024} KiB.`,
        ),
      ],
    };
  const lines = new LineCounter();
  const doc = parseDocument(text, { ...MANIFEST_YAML_OPTIONS, lineCounter: lines });
  if (doc.errors.length > 0)
    return {
      ok: false,
      issues: doc.errors.map((e) =>
        e.code === "DUPLICATE_KEY"
          ? fileIssue(
              "yaml_duplicate_key",
              "A key appears twice in one mapping; keep one.",
              lines.linePos(e.pos[0]),
            )
          : fileIssue(
              "yaml_syntax",
              `Not valid YAML: ${lowerFirst(e.message.split("\n")[0] ?? "")}`,
              lines.linePos(e.pos[0]),
            ),
      ),
    };
  const aliases: SkillEvalIssue[] = [];
  visit(doc, {
    Alias(_, node) {
      aliases.push(
        fileIssue(
          "yaml_alias",
          "YAML aliases (*name) are not allowed; write the value out.",
          lines.linePos(rangeStart(node)),
        ),
      );
    },
  });
  if (aliases.length > 0) return { ok: false, issues: aliases };
  if (!isMap(doc.contents))
    return {
      ok: false,
      issues: [
        fileIssue(
          "not_a_mapping",
          `${EVAL_CASES_PATH} must be a mapping with a cases list.`,
          lines.linePos(rangeStart(doc.contents)),
        ),
      ],
    };
  const raw: unknown = doc.toJS();
  const parsed = skillEvalSuiteSchema.safeParse(raw);
  if (!parsed.success) {
    // zod skips the list's duplicate-id check when a case has another issue: check the raw ids.
    const issues = [
      ...schemaIssues(doc, lines, raw, parsed.error).filter(
        (i) => !(i.code === "duplicate" && CASE_ID_PATH.test(i.path)),
      ),
      ...duplicateIdIssues(doc, lines, raw),
    ];
    return { ok: false, issues: issues.sort(byPosition) };
  }
  const missing = options.paths ? fixtureIssues(doc, lines, parsed.data, options.paths) : [];
  if (missing.length > 0) return { ok: false, issues: missing.sort(byPosition) };
  return { ok: true, suite: parsed.data, issues: [] };
}
