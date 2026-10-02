import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";

/**
 * The only pattern language in Kobe policy (`tool_rules.tool_glob`, `tool_rules.arg_pattern`,
 * agent `tools.allow/deny`). No regular expressions anywhere a user can write a pattern (no ReDoS,
 * one obvious meaning).
 *
 * Glob grammar, matched against the WHOLE subject (anchored), case-sensitive, by Unicode code point:
 *   `*`  any sequence of code points, including empty (also matches `/` and `_`)
 *   `?`  exactly one code point
 *   `\x` the literal code point x (escape for `*`, `?`, `\`)
 *   anything else matches itself. A trailing lone `\` is invalid.
 *
 * `arg_pattern` is an object `{ "<RFC 6901 JSON Pointer>": "<glob>" }` (1–16 entries). It matches a
 * tool input when, for EVERY entry, the pointer resolves in the input and the glob matches the
 * resolved value's subject: the string itself for a JSON string, else `canonicalJson(value)` (so
 * `{"/count": "1?"}` matches `10`..`19`, `{"/flags": "[\"a\"*"}` an array starting with "a").
 * An unresolvable pointer never matches.
 */

export const GLOB_MAX_LENGTH = 256;
export const ARG_PATTERN_MAX_ENTRIES = 16;

function isValidGlob(glob: string): boolean {
  const points = [...glob];
  for (let i = 0; i < points.length; i += 1) {
    if (points[i] === "\\") {
      if (i === points.length - 1) return false;
      i += 1;
    }
  }
  return true;
}

export const globSchema = z
  .string()
  .min(1)
  .max(GLOB_MAX_LENGTH)
  .refine(isValidGlob, "trailing escape in glob");

/** RFC 6901 JSON Pointer to a value inside the tool input (root `""` is not allowed). */
export const jsonPointerSchema = z
  .string()
  .max(512)
  .regex(/^(\/([^~/]|~[01])*)+$/, "JSON Pointer");

export const argPatternSchema = z.record(jsonPointerSchema, globSchema).refine((p) => {
  const size = Object.keys(p).length;
  return size >= 1 && size <= ARG_PATTERN_MAX_ENTRIES;
}, `1–${ARG_PATTERN_MAX_ENTRIES} entries`);
export type ArgPattern = z.infer<typeof argPatternSchema>;

type Token =
  | { readonly kind: "star" }
  | { readonly kind: "one" }
  | { readonly kind: "lit"; readonly cp: string };

function tokenize(glob: string): Token[] {
  const points = [...glob];
  const tokens: Token[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const cp = points[i] as string;
    if (cp === "\\") {
      i += 1;
      tokens.push({ kind: "lit", cp: points[i] ?? "" });
    } else if (cp === "*") tokens.push({ kind: "star" });
    else if (cp === "?") tokens.push({ kind: "one" });
    else tokens.push({ kind: "lit", cp });
  }
  return tokens;
}

/** Linear-time wildcard match (greedy with single backtrack point). */
export function matchGlob(glob: string, subject: string): boolean {
  if (!isValidGlob(glob)) return false;
  const p = tokenize(glob);
  const s = [...subject];
  let pi = 0;
  let si = 0;
  let starP = -1;
  let starS = 0;
  while (si < s.length) {
    const token = p[pi];
    if (
      token !== undefined &&
      (token.kind === "one" || (token.kind === "lit" && token.cp === s[si]))
    ) {
      pi += 1;
      si += 1;
    } else if (token?.kind === "star") {
      starP = pi;
      starS = si;
      pi += 1;
    } else if (starP >= 0) {
      pi = starP + 1;
      starS += 1;
      si = starS;
    } else {
      return false;
    }
  }
  while (p[pi]?.kind === "star") pi += 1;
  return pi === p.length;
}

/** Resolve an RFC 6901 pointer; `undefined` when any segment is missing. */
export function resolveJsonPointer(value: unknown, pointer: string): unknown {
  let current: unknown = value;
  for (const raw of pointer.split("/").slice(1)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (current !== null && typeof current === "object" && Object.hasOwn(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export function matchesArgPattern(pattern: ArgPattern, input: unknown): boolean {
  return Object.entries(pattern).every(([pointer, glob]) => {
    const value = resolveJsonPointer(input, pointer);
    if (value === undefined) return false;
    return matchGlob(glob, typeof value === "string" ? value : canonicalJson(value));
  });
}
