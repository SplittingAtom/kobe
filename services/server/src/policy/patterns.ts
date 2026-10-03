import {
  BUILTIN_TOOLS,
  canonicalJson,
  GLOB_MAX_LENGTH,
  matchGlob,
  resolveJsonPointer,
  type ArgPattern,
  type JsonObject,
  type ToolDescriptor,
} from "@kobe/protocol";

/**
 * Pattern matching for policy rules, built on the protocol's glob grammar (`*`, `?`, `\` escape;
 * anchored; no regular expressions). Every matcher here is total and **fails closed by effect**:
 * when a subject can't be matched safely (too long, not serializable, malformed pattern), a
 * restricting rule (deny/ask) counts as matching and a loosening rule (allow) as not matching.
 */

/** What a rule does if it matches; decides which way an unmatchable subject falls. */
export type MatchBias = "restrict" | "loosen";

/**
 * Longest subject (UTF-16 code units) a glob is run against. `matchGlob` is O(pattern × subject)
 * in the worst case (`*a*a*…` against `aaaa…`); with patterns capped at 256 code points this keeps
 * one match under a few milliseconds. Longer subjects take the fail-closed branch.
 */
export const MAX_GLOB_SUBJECT_LENGTH = 16_384;

function unmatchable(bias: MatchBias): boolean {
  return bias === "restrict";
}

/** The glob grammar's validity (protocol `globSchema`) without zod's per-call overhead. */
function isValidGlob(glob: string): boolean {
  // Same bounds as `globSchema` (z.string().min(1).max(256): UTF-16 code units).
  if (glob.length === 0 || glob.length > GLOB_MAX_LENGTH) return false;
  const points = [...glob];
  for (let i = 0; i < points.length; i += 1) {
    if (points[i] === "\\") {
      if (i === points.length - 1) return false;
      i += 1;
    }
  }
  return true;
}

/** Matches a glob against a subject, falling to `bias` when that can't be done safely. */
export function matchSubject(glob: string, subject: string, bias: MatchBias): boolean {
  if (!isValidGlob(glob)) return unmatchable(bias);
  if (subject.length > MAX_GLOB_SUBJECT_LENGTH) return unmatchable(bias);
  return matchGlob(glob, subject);
}

/** The string a glob sees for a resolved input value: the string itself, else canonical JSON. */
function subjectOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  try {
    return canonicalJson(value);
  } catch {
    return undefined;
  }
}

/**
 * `arg_pattern` (contract: protocol glob.ts): every entry's pointer must resolve in the input and its
 * glob must match the value's subject. An unresolvable pointer or an unmatchable subject falls to
 * `bias`: a deny/ask rule whose pointer is missing still applies (an input can't dodge a rule by
 * leaving a key out); an allow rule doesn't. JSON Pointer has no array wildcard: `/edits/0/oldText`
 * names one element only.
 */
export function matchArgPattern(pattern: ArgPattern, input: JsonObject, bias: MatchBias): boolean {
  return Object.entries(pattern).every(([pointer, glob]) => {
    const value = resolveJsonPointer(input, pointer);
    if (value === undefined) return unmatchable(bias);
    const subject = subjectOf(value);
    if (subject === undefined) return unmatchable(bias);
    return matchSubject(glob, subject, bias);
  });
}

/**
 * Splits an agent-file tool entry (§6.3) into tool glob and optional argument glob at the first
 * unescaped `:` — `bash:rm -rf*` → (`bash`, `rm -rf*`). Tool names never contain `:` (Pi built-ins
 * and `mcp__<server>__<tool>` names are `[A-Za-z0-9_]`).
 */
export function splitAgentToolEntry(entry: string): { tool: string; arg: string | undefined } {
  const points = [...entry];
  for (let i = 0; i < points.length; i += 1) {
    if (points[i] === "\\") {
      i += 1;
    } else if (points[i] === ":") {
      return { tool: points.slice(0, i).join(""), arg: points.slice(i + 1).join("") };
    }
  }
  return { tool: entry, arg: undefined };
}

/** The input pointer an agent-file shorthand matches against (built-ins only). */
function primaryArgPointer(tool: ToolDescriptor): string | undefined {
  if (tool.source === "mcp" || !Object.hasOwn(BUILTIN_TOOLS, tool.name)) return undefined;
  return BUILTIN_TOOLS[tool.name]?.primary_arg;
}

/**
 * Agent frontmatter `tools.allow` / `tools.deny` entry (D19): a tool glob, optionally with a
 * `:<glob>` over the tool's primary argument (matched on the prepared input: canonical paths).
 * A deny entry with an argument part on a tool that has no primary argument, or whose input lacks
 * it, falls back to the tool name alone (restrict); an allow entry does not match.
 */
export function matchAgentToolEntry(
  entry: string,
  tool: ToolDescriptor,
  input: JsonObject,
  bias: MatchBias,
): boolean {
  const { tool: toolGlob, arg } = splitAgentToolEntry(entry);
  if (toolGlob === "") return unmatchable(bias);
  if (!matchSubject(toolGlob, tool.name, bias)) return false;
  if (arg === undefined) return true;
  const pointer = primaryArgPointer(tool);
  if (pointer === undefined) return unmatchable(bias);
  return matchArgPattern({ [pointer]: arg }, input, bias);
}

/** A glob's literal prefix: everything before its first unescaped `*` or `?`, unescaped. */
export function literalPrefix(glob: string): string {
  const points = [...glob];
  let prefix = "";
  for (let i = 0; i < points.length; i += 1) {
    const cp = points[i];
    if (cp === "*" || cp === "?") break;
    if (cp === "\\") {
      i += 1;
      prefix += points[i] ?? "";
    } else {
      prefix += cp;
    }
  }
  return prefix;
}

/** `mcp__<server segment>__` (segments as `mcpServerSegment` makes them: `[a-z0-9]` runs joined by `_`). */
const MCP_CONNECTOR_PREFIX = /^mcp__[a-z0-9]+(?:_[a-z0-9]+)*__/;

/** A valid glob with no unescaped `*` or `?`: it names exactly one tool. */
export function isLiteralGlob(glob: string): boolean {
  if (!isValidGlob(glob)) return false;
  const points = [...glob];
  for (let i = 0; i < points.length; i += 1) {
    if (points[i] === "\\") i += 1;
    else if (points[i] === "*" || points[i] === "?") return false;
  }
  return true;
}

/**
 * Allow rules (team and user) must name what they allow: exactly one built-in, or tools of one
 * connector (literal `mcp__<server>__` prefix). No blanket allow (`*`, `mcp__*`, `*_issue`): that
 * would turn every prompt off at once, which D29's "no bypass mode" rules out.
 */
export function allowGlobScoped(glob: string): boolean {
  if (Object.hasOwn(BUILTIN_TOOLS, glob)) return true;
  return MCP_CONNECTOR_PREFIX.test(literalPrefix(glob));
}
