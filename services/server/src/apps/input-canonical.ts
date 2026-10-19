import { createHash } from "node:crypto";
import { canonicalJson, type JsonObject } from "@kobe/protocol";
import { parseToolsSnapshot, sql, type KobeTx } from "@kobe/db";

/**
 * The canonical form of an MCP App tool's input against its pinned input schema (KOBE-441: the
 * Kobe Explorer Gate found real Pi's tool-call input and the proxy's captured input differ). Pi
 * records the model's raw arguments in `tool.call`, but converts them before it calls the tool:
 * TypeBox `Value.Convert` and its own JSON-schema coercion turn `"5"` into `5` for an integer, and
 * an optional `null` is dropped. Some MCP clients also fill in schema defaults. So the capture
 * ticket and the claim both digest this form: primitives coerced the way Pi coerces them (only
 * exact numeric and boolean strings), optional nulls dropped and defaults applied, recursively.
 * After that the comparison is exact: different values never match.
 */
type Schema = Record<string, unknown> | undefined;

/** How deep the canonical form follows a schema (the pin caps schemas at depth 32). */
const MAX_DEPTH = 32;
const NUMERIC = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function typesOf(schema: Record<string, unknown>): string[] {
  const t = schema["type"];
  return typeof t === "string"
    ? [t]
    : Array.isArray(t)
      ? t.filter((x) => typeof x === "string")
      : [];
}

function primitive(value: unknown, types: readonly string[]): unknown {
  if (types.length === 0 || types.includes(jsonType(value))) return value;
  if (typeof value === "string") {
    if ((types.includes("number") || types.includes("integer")) && NUMERIC.test(value)) {
      const n = Number(value);
      if (Number.isFinite(n) && (types.includes("number") || Number.isInteger(n))) return n;
    }
    if (types.includes("boolean") && (value === "true" || value === "false"))
      return value === "true";
  }
  return value;
}

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function canon(schemaValue: unknown, value: unknown, depth: number): unknown {
  const schema = record(schemaValue);
  if (!schema || depth > MAX_DEPTH) return value;
  const types = typesOf(schema);
  const coerced = primitive(value, types);
  const items = schema["items"];
  if (Array.isArray(coerced)) {
    return record(items) ? coerced.map((v) => canon(items, v, depth + 1)) : coerced;
  }
  const object = record(coerced);
  const properties = record(schema["properties"]);
  if (!object || !properties) return coerced;
  const required = new Set(
    Array.isArray(schema["required"]) ? (schema["required"] as unknown[]) : [],
  );
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(object)) {
    const prop = record(properties[key]);
    if (v === null && prop && !required.has(key) && !typesOf(prop).includes("null")) continue;
    out[key] = prop ? canon(prop, v, depth + 1) : v;
  }
  for (const [key, propValue] of Object.entries(properties)) {
    const prop = record(propValue);
    if (prop && !(key in out) && prop["default"] !== undefined) {
      out[key] = canon(prop, structuredClone(prop["default"]), depth + 1);
    }
  }
  return out;
}

export function canonicalToolInput(schema: Schema, input: Record<string, unknown>): unknown {
  return canon(schema, input, 0);
}

/** SHA-256 of the canonical JSON of the canonical form (`canonicalJson`, KOBE-37). */
export function appInputDigest(schema: Schema, input: Record<string, unknown>): string {
  return createHash("sha256")
    .update(canonicalJson(canonicalToolInput(schema, input) as JsonObject))
    .digest("hex");
}

/** A pinned tool's input schema, from its connector's snapshot (undefined when not pinned). */
export async function pinnedInputSchema(
  tx: Pick<KobeTx, "execute">,
  connectorId: string,
  tool: string,
): Promise<Record<string, unknown> | undefined> {
  const res = await tx.execute<{ snapshot: unknown }>(sql`
    SELECT tools_snapshot AS snapshot FROM connectors WHERE id = ${connectorId}`);
  const found = parseToolsSnapshot(res.rows[0]?.snapshot).find((t) => t.name === tool);
  return found?.input_schema as Record<string, unknown> | undefined;
}
