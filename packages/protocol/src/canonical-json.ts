/**
 * Canonical JSON for approval signing (D29: approvals are HMAC-signed over the canonical input).
 *
 * The rule is RFC 8785 (JSON Canonicalization Scheme, JCS), with Kobe's strictness on top:
 *
 * 1. Only JSON values are accepted: `null`, booleans, finite numbers, strings, arrays, and plain
 *    objects (prototype `Object.prototype` or `null`). `undefined` (anywhere, including as a
 *    property value), functions, symbols, bigints, `NaN`/`±Infinity`, class instances (`Date`,
 *    `Map`, ...) and sparse array holes are rejected, never silently dropped.
 * 2. Object members are sorted by key, comparing keys as arrays of UTF-16 code units (JS default
 *    string ordering), recursively. No whitespace anywhere.
 * 3. Numbers use the ECMAScript `Number.prototype.toString` form (`JSON.stringify`): `4.50` → `4.5`,
 *    `1E30` → `1e+30`, `-0` → `0`. Inputs are canonicalised after `JSON.parse`, so integers beyond
 *    2^53 are canonicalised as the double they parsed to, identically on every Node/browser side.
 * 4. Strings are serialised as `JSON.stringify` does (escape `"`, `\`, and U+0000–U+001F using
 *    `\b \t \n \f \r` or lowercase `\u00xx`; everything else literal, including U+2028/U+2029 and
 *    non-ASCII). Strings — values and keys — must be well-formed UTF-16: a lone surrogate is
 *    rejected. **No Unicode normalisation** (NFC/NFD forms are different inputs: approving one must
 *    not approve the other).
 * 5. The canonical bytes are the UTF-8 encoding of the canonical string.
 * 6. Nesting deeper than {@link MAX_CANONICAL_DEPTH} is rejected.
 *
 * Pure and dependency-free so the server, the MCP proxy, and tests produce identical bytes.
 */

export const MAX_CANONICAL_DEPTH = 128;

export class CanonicalJsonError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path}`);
    this.name = "CanonicalJsonError";
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function serialiseString(value: string, path: string): string {
  if (LONE_SURROGATE.test(value)) {
    throw new CanonicalJsonError("lone surrogate in string", path);
  }
  return JSON.stringify(value);
}

function serialiseNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalJsonError("non-finite number", path);
  }
  return JSON.stringify(value);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serialiseArray(value: readonly unknown[], path: string, depth: number): string {
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      throw new CanonicalJsonError("sparse array hole", `${path}[${index}]`);
    }
    parts.push(serialise(value[index], `${path}[${index}]`, depth + 1));
  }
  return `[${parts.join(",")}]`;
}

function serialiseObject(value: Record<string, unknown>, path: string, depth: number): string {
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new CanonicalJsonError("symbol-keyed property", path);
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => {
    const childPath = `${path}.${key}`;
    return `${serialiseString(key, childPath)}:${serialise(value[key], childPath, depth + 1)}`;
  });
  return `{${parts.join(",")}}`;
}

function serialise(value: unknown, path: string, depth: number): string {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new CanonicalJsonError("nesting too deep", path);
  }
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return serialiseNumber(value, path);
    case "string":
      return serialiseString(value, path);
    case "object":
      if (Array.isArray(value)) return serialiseArray(value, path, depth);
      if (isPlainObject(value)) return serialiseObject(value, path, depth);
      throw new CanonicalJsonError("not a plain object", path);
    default:
      throw new CanonicalJsonError(`unsupported type ${typeof value}`, path);
  }
}

/** Canonical JSON text of `value` (RFC 8785 + the rules above). Throws `CanonicalJsonError`. */
export function canonicalJson(value: unknown): string {
  return serialise(value, "$", 0);
}

/** UTF-8 bytes of {@link canonicalJson}. */
export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}
