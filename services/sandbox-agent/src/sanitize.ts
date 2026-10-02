import { MAX_JSON_NESTING, type JsonValue } from "@kobe/protocol";

/**
 * Make a value parsed from Pi output acceptable to the server's strict frame decoder
 * (json-safety.ts): U+0000 becomes U+FFFD in strings and keys, `__proto__` keys are dropped, and
 * subtrees nested deeper than the decoder allows are replaced by a marker string. A frame the server
 * would reject must never get an outbound seq: the server would answer every re-send with `resend`.
 */
const REPLACEMENT = "\uFFFD";
export const TOO_DEEP_MARKER = "[kobe: nested too deeply]";

/** Frame envelope levels above the bridged value (frame → event / input). */
const ENVELOPE_DEPTH = 2;

export function sanitizeString(text: string): string {
  return text.includes("\u0000") ? text.replaceAll("\u0000", REPLACEMENT) : text;
}

export function sanitizeJson(value: unknown, depth = 0): JsonValue {
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean" || value === null) return value;
  if (typeof value !== "object") return null;
  if (depth >= MAX_JSON_NESTING - ENVELOPE_DEPTH) return TOO_DEEP_MARKER;
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, depth + 1));
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "__proto__") continue;
    Object.defineProperty(out, sanitizeString(key), {
      value: sanitizeJson(item, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** Parse one JSONL record from Pi; `undefined` when it is not a JSON object. */
export function parsePiRecord(line: string): Record<string, JsonValue> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return sanitizeJson(parsed) as Record<string, JsonValue>;
}
