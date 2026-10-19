import {
  isCollection,
  isMap,
  isScalar,
  isSeq,
  Lexer,
  LineCounter,
  parseDocument,
  visit,
  type Document,
} from "yaml";
import type { z } from "zod";
import { EVALS_DIR } from "../skill-package/layout.js";
import { MANIFEST_YAML_OPTIONS } from "../skill-package/manifest.js";
import {
  EVAL_CASES_MAX_BYTES,
  EVAL_CASES_PATH,
  EVAL_MAX_CASES,
  skillEvalSuiteSchema,
  type SkillEvalSuite,
} from "./cases.js";

/**
 * Reading `evals/cases.yaml` with located, sentence-form issues (KOBE-324 ac-2): what Workbench
 * lint shows on every edit and what the eval runner refuses before it starts a sandbox. The same
 * function runs in the browser and on the server, so both say the same thing about a file.
 *
 * YAML limits: the size first (before parsing), then flow nesting on the lexer's tokens (an
 * iterative scan, so no stack overflow in any engine), then the parsed tree: no alias, no explicit
 * tag (`!foo`, `!!timestamp`: the core schema's plain types only), at most
 * {@link EVAL_YAML_MAX_DEPTH} levels. Exported from `@kobe/protocol/skill-evals`, not the root
 * entry, so services that never read a suite don't load the YAML parser.
 */

/** Nesting a suite needs: root, cases, case, expect, matches, match is 6. */
export const EVAL_YAML_MAX_DEPTH = 16;

export const SKILL_EVAL_ISSUE_CODES = [
  "too_large",
  "yaml_syntax",
  "yaml_duplicate_key",
  "yaml_alias",
  "yaml_tag",
  "too_deep",
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
  /** The Site's case limit (`eval_limits.maxCases`, clamped to 1–25), so lint agrees with the runner. */
  readonly maxCases?: number;
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

/** The lexer's document, flow-error-end and scalar markers. */
const LEXER_MARKERS: ReadonlySet<string> = new Set(["\u0002", "\u0018", "\u001f"]);

/**
 * Offset of the first node nested past the depth limit, or null, from the lexer's tokens (an
 * iterative scan, before any recursive parsing). Flow collections count their brackets. Block
 * nesting is tracked as a stack of columns: the first token of each line and every `-` / `?`
 * indicator opens a level at its column, closing those at the same column or deeper. This bounds
 * compact nesting (`- - - - x`) too, and over-counts a little, never under.
 */
function tooDeepAt(text: string): number | null {
  let flow = 0;
  let offset = 0;
  let column = 0;
  let lineStart = true;
  const block: number[] = [];
  const open = (at: number) => {
    while (block.length > 0 && (block[block.length - 1] as number) >= at) block.pop();
    block.push(at);
  };
  for (const token of new Lexer().lex(text)) {
    if (LEXER_MARKERS.has(token)) continue;
    const startColumn = column;
    if (token === "[" || token === "{") flow += 1;
    else if (token === "]" || token === "}") flow -= 1;
    else if (flow === 0 && (token === "-" || token === "?")) open(startColumn);
    else if (flow === 0 && lineStart && !/^[ \t]*$/.test(token) && !token.startsWith("#"))
      open(startColumn);
    if (flow + block.length > EVAL_YAML_MAX_DEPTH) return offset;
    if (!/^[ \t]*$/.test(token)) lineStart = false;
    offset += token.length;
    const newline = token.lastIndexOf("\n");
    if (newline >= 0) {
      column = token.length - newline - 1;
      lineStart = true;
    } else column += token.length;
  }
  return null;
}

/** The first node deeper than the limit, walked without recursion. */
function treeTooDeep(doc: Document): unknown {
  const stack: [unknown, number][] = [[doc.contents, 1]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop() as [unknown, number];
    if (!isCollection(node)) continue;
    if (depth > EVAL_YAML_MAX_DEPTH) return node;
    for (const item of node.items as unknown[]) {
      const value = (item as { value?: unknown }).value;
      stack.push([isMap(node) ? value : item, depth + 1]);
    }
  }
  return null;
}

/** Aliases and explicit tags, located. */
function nodeIssues(doc: Document, lines: LineCounter): SkillEvalIssue[] {
  const out: SkillEvalIssue[] = [];
  const at = (node: unknown) => lines.linePos(rangeStart(node));
  visit(doc, {
    Alias(_, node) {
      out.push(
        fileIssue(
          "yaml_alias",
          "YAML aliases (*name) are not allowed; write the value out.",
          at(node),
        ),
      );
    },
    Node(_, node) {
      if ((node as { tag?: string }).tag)
        out.push(
          fileIssue(
            "yaml_tag",
            "YAML tags (!name, !!type) are not allowed; write a plain value.",
            at(node),
          ),
        );
    },
  });
  return out;
}

const tooDeepIssue = (pos?: { line: number; col: number }) =>
  fileIssue("too_deep", `Nested deeper than ${EVAL_YAML_MAX_DEPTH} levels.`, pos);

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
  const deepAt = tooDeepAt(text);
  if (deepAt !== null) {
    lines.addNewLine(0);
    for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") lines.addNewLine(i + 1);
    return {
      ok: false,
      issues: [
        fileIssue(
          "too_deep",
          `Nested deeper than ${EVAL_YAML_MAX_DEPTH} levels.`,
          lines.linePos(deepAt),
        ),
      ],
    };
  }
  let doc: Document;
  try {
    doc = parseDocument(text, { ...MANIFEST_YAML_OPTIONS, lineCounter: lines });
  } catch (err) {
    // A stack overflow the pre-scan missed is refused as nesting, never as a crash.
    if (err instanceof RangeError) return { ok: false, issues: [tooDeepIssue()] };
    throw err;
  }
  if (doc.errors.some((e) => /call stack/i.test(e.message)))
    return { ok: false, issues: [tooDeepIssue()] };
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
  const refused = nodeIssues(doc, lines);
  if (refused.length > 0) return { ok: false, issues: refused.sort(byPosition) };
  const deep = treeTooDeep(doc);
  if (deep !== null)
    return {
      ok: false,
      issues: [
        fileIssue(
          "too_deep",
          `Nested deeper than ${EVAL_YAML_MAX_DEPTH} levels.`,
          lines.linePos(rangeStart(deep)),
        ),
      ],
    };
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
  const maxCases = Math.min(
    EVAL_MAX_CASES,
    Math.max(1, Math.trunc(options.maxCases ?? EVAL_MAX_CASES)),
  );
  if (parsed.data.cases.length > maxCases) {
    const { node } = locate(doc, ["cases"]);
    const pos = lines.linePos(rangeStart(node));
    return {
      ok: false,
      issues: [
        {
          file: EVAL_CASES_PATH,
          code: "out_of_range",
          path: "cases",
          message: sentence("cases", `this Site runs at most ${maxCases} cases per suite.`),
          line: pos.line,
          column: pos.col,
        },
      ],
    };
  }
  const missing = options.paths ? fixtureIssues(doc, lines, parsed.data, options.paths) : [];
  if (missing.length > 0) return { ok: false, issues: missing.sort(byPosition) };
  return { ok: true, suite: parsed.data, issues: [] };
}
