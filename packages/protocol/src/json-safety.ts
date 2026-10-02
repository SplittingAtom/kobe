import { MAX_CANONICAL_DEPTH } from "./canonical-json.js";

/**
 * Boundary rules for JSON that Kobe stores (Postgres `jsonb`) or signs (approvals).
 *
 * - **U+0000** in any string or key is rejected: `jsonb` cannot store it. Where: the server's
 *   sandbox-wire decoder (`decodeSandboxFrame`, every inbound frame), every tool-input schema, and
 *   every HTTP body schema. kobe-sandbox-agent replaces U+0000 in Pi output (tool results, messages)
 *   with U+FFFD before framing, so legitimate runs never hit the rejection; tool *inputs* are never
 *   rewritten (that would change the signed bytes) — a call with U+0000 in its input is denied.
 * - **`__proto__` keys** are rejected everywhere: `JSON.parse` makes them own properties, but any
 *   later spread/assign may turn them into a prototype, so the executed object could differ from the
 *   signed one.
 * - **Duplicate keys** are rejected where the raw text is available (inbound frames): `JSON.parse`
 *   keeps the last one silently, so two parsers could disagree on what was approved.
 * - **Nesting deeper than {@link MAX_JSON_NESTING}** containers is rejected (text pre-scan and value
 *   walk), before any recursive validator runs.
 * - **Unsafe integers** (integral numbers with |n| > 2^53 − 1) are rejected in tool inputs: they
 *   don't survive a JS round-trip, so the executed value could differ from the approved one.
 */

export type JsonSafetyIssue =
  "nul_character" | "proto_key" | "unsafe_integer" | "duplicate_key" | "too_deep";

/**
 * Maximum nesting of arrays/objects accepted at a boundary (same bound as canonical JSON). Checked
 * before anything recursive (zod's z.json(), canonicalJson) sees the value, so hostile input under
 * the frame-size cap cannot exhaust the stack. Everything here is iterative.
 */
export const MAX_JSON_NESTING = MAX_CANONICAL_DEPTH;

export interface JsonSafetyOptions {
  /** Also reject integral numbers outside the safe-integer range (tool inputs). */
  readonly rejectUnsafeIntegers?: boolean;
}

const PROTO_KEY = "__proto__";

/** First rule violation in an already-parsed value, or `undefined` when it is safe. Iterative. */
export function findJsonSafetyIssue(
  value: unknown,
  options: JsonSafetyOptions = {},
): JsonSafetyIssue | undefined {
  const values: unknown[] = [value];
  const depths: number[] = [0];
  while (values.length > 0) {
    const current = values.pop();
    const depth = depths.pop() ?? 0;
    if (typeof current === "string") {
      if (current.includes("\u0000")) return "nul_character";
    } else if (typeof current === "number") {
      if (
        options.rejectUnsafeIntegers === true &&
        Number.isInteger(current) &&
        !Number.isSafeInteger(current)
      ) {
        return "unsafe_integer";
      }
    } else if (current !== null && typeof current === "object") {
      if (depth + 1 > MAX_JSON_NESTING) return "too_deep";
      if (Array.isArray(current)) {
        for (const item of current as unknown[]) {
          values.push(item);
          depths.push(depth + 1);
        }
      } else {
        for (const key of Object.keys(current)) {
          if (key === PROTO_KEY) return "proto_key";
          if (key.includes("\u0000")) return "nul_character";
          values.push((current as Record<string, unknown>)[key]);
          depths.push(depth + 1);
        }
      }
    }
  }
  return undefined;
}

type Frame = { readonly kind: "array" } | { kind: "object"; keys: Set<string>; expectKey: boolean };

function readString(text: string, start: number): { value: string; end: number } {
  let index = start + 1;
  while (index < text.length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
  try {
    return { value: JSON.parse(text.slice(start, index + 1)) as string, end: index };
  } catch {
    return { value: text.slice(start, index + 1), end: index };
  }
}

/**
 * One iterative pass over JSON text: the first duplicate key in any object, or nesting deeper than
 * `maxDepth`. Assumes valid JSON for exact results; on invalid text it may answer anything, but never
 * throws or recurses (callers JSON.parse afterwards).
 */
export function scanJsonText(
  text: string,
  maxDepth: number = MAX_JSON_NESTING,
): "duplicate_key" | "too_deep" | undefined {
  const stack: Frame[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const top = stack[stack.length - 1];
    if (char === '"') {
      const { value, end } = readString(text, index);
      index = end;
      if (top?.kind === "object" && top.expectKey) {
        if (top.keys.has(value)) return "duplicate_key";
        top.keys.add(value);
        top.expectKey = false;
      }
    } else if (char === "{" || char === "[") {
      if (stack.length + 1 > maxDepth) return "too_deep";
      stack.push(
        char === "{" ? { kind: "object", keys: new Set(), expectKey: true } : { kind: "array" },
      );
    } else if (char === "}" || char === "]") {
      stack.pop();
    } else if (char === "," && top?.kind === "object") {
      top.expectKey = true;
    }
  }
  return undefined;
}

/** True when an object in `text` repeats a key. `text` must already be valid JSON. */
export function hasDuplicateKeys(text: string): boolean {
  return scanJsonText(text, Number.POSITIVE_INFINITY) === "duplicate_key";
}

export type StrictParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issue: JsonSafetyIssue | "invalid_json" };

/** `JSON.parse` plus the boundary rules above. Never throws; never recurses on the input. */
export function parseJsonStrict(text: string): StrictParseResult {
  const scanned = scanJsonText(text);
  if (scanned === "too_deep") return { ok: false, issue: scanned };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, issue: "invalid_json" };
  }
  if (scanned !== undefined) return { ok: false, issue: scanned };
  const issue = findJsonSafetyIssue(value);
  return issue === undefined ? { ok: true, value } : { ok: false, issue };
}
