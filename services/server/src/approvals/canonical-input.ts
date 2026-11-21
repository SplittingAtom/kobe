import { jsonObjectSchema, type JsonObject } from "@kobe/protocol";

/** The stored canonical input of an approval is not a JSON object (never expected: the server writes it). */
export class CanonicalInputError extends Error {
  constructor(id: string | undefined) {
    super(`approval ${id ?? "(new)"}: stored input is not a JSON object`);
    this.name = "CanonicalInputError";
  }
}

/**
 * An approval's tool input from its stored canonical JSON (KOBE-702). Approvals are HMAC-signed
 * over this exact text, so it is only parsed: the shape is checked, and the value `JSON.parse`
 * produced is returned as is (never a re-serialised or schema-rebuilt copy).
 */
export function parseCanonicalInput(row: {
  readonly id?: string;
  readonly inputCanonical: string;
}): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.inputCanonical);
  } catch {
    throw new CanonicalInputError(row.id);
  }
  if (!jsonObjectSchema.safeParse(parsed).success) throw new CanonicalInputError(row.id);
  return parsed as JsonObject;
}
