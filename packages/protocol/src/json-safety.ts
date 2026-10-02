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
 * - **Unsafe integers** (integral numbers with |n| > 2^53 − 1) are rejected in tool inputs: they
 *   don't survive a JS round-trip, so the executed value could differ from the approved one.
 */

export type JsonSafetyIssue = "nul_character" | "proto_key" | "unsafe_integer" | "duplicate_key";

export interface JsonSafetyOptions {
  /** Also reject integral numbers outside the safe-integer range (tool inputs). */
  readonly rejectUnsafeIntegers?: boolean;
}

const PROTO_KEY = "__proto__";

/** First rule violation in an already-parsed value, or `undefined` when it is safe. */
export function findJsonSafetyIssue(
  value: unknown,
  options: JsonSafetyOptions = {},
): JsonSafetyIssue | undefined {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const current = stack.pop();
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
    } else if (Array.isArray(current)) {
      stack.push(...(current as unknown[]));
    } else if (current !== null && typeof current === "object") {
      for (const key of Object.keys(current)) {
        if (key === PROTO_KEY) return "proto_key";
        if (key.includes("\u0000")) return "nul_character";
        stack.push((current as Record<string, unknown>)[key]);
      }
    }
  }
  return undefined;
}

type Frame = { readonly kind: "array" } | { kind: "object"; keys: Set<string>; expectKey: boolean };

function readString(text: string, start: number): { value: string; end: number } {
  let index = start + 1;
  while (index < text.length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
  return { value: JSON.parse(text.slice(start, index + 1)) as string, end: index };
}

/** True when an object in `text` repeats a key. `text` must already be valid JSON. */
export function hasDuplicateKeys(text: string): boolean {
  const stack: Frame[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const top = stack[stack.length - 1];
    if (char === '"') {
      const { value, end } = readString(text, index);
      index = end;
      if (top?.kind === "object" && top.expectKey) {
        if (top.keys.has(value)) return true;
        top.keys.add(value);
        top.expectKey = false;
      }
    } else if (char === "{") {
      stack.push({ kind: "object", keys: new Set(), expectKey: true });
    } else if (char === "[") {
      stack.push({ kind: "array" });
    } else if (char === "}" || char === "]") {
      stack.pop();
    } else if (char === "," && top?.kind === "object") {
      top.expectKey = true;
    }
  }
  return false;
}

export type StrictParseResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly issue: JsonSafetyIssue | "invalid_json" };

/** `JSON.parse` plus the boundary rules above (duplicate keys, U+0000, `__proto__`). */
export function parseJsonStrict(text: string): StrictParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, issue: "invalid_json" };
  }
  if (hasDuplicateKeys(text)) return { ok: false, issue: "duplicate_key" };
  const issue = findJsonSafetyIssue(value);
  return issue === undefined ? { ok: true, value } : { ok: false, issue };
}
