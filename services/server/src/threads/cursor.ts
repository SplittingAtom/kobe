import { z } from "zod";

/**
 * Keyset position after the last row of a page, ordered by (timestamp DESC, id DESC). The
 * timestamp travels as epoch microseconds in a decimal string: timestamptz has µs precision and a
 * JS Date only ms, so a ms cursor would skip or repeat rows that share a millisecond.
 */
export interface ActivityCursor {
  readonly micros: string;
  readonly id: string;
}

const MAX_CURSOR_LENGTH = 256;

// Non-negative and at most 17 digits (≈ year 5138), so the database's bigint and timestamp
// arithmetic on a crafted cursor can't overflow into a 500.
const cursorSchema = z.strictObject({
  a: z.string().regex(/^(0|[1-9]\d{0,16})$/),
  i: z.uuid(),
});

export function encodeActivityCursor(cursor: ActivityCursor): string {
  return Buffer.from(JSON.stringify({ a: cursor.micros, i: cursor.id })).toString("base64url");
}

/** The cursor, or null when it is malformed (the caller answers 400 `invalid_cursor`). */
export function decodeActivityCursor(raw: string): ActivityCursor | null {
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = cursorSchema.safeParse(json);
  return parsed.success ? { micros: parsed.data.a, id: parsed.data.i.toLowerCase() } : null;
}
