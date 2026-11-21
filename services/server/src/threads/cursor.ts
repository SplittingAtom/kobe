import { z } from "zod";
import { makeCursorCodec } from "@kobe/db";

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

const activityCursor = makeCursorCodec(cursorSchema, { maxLength: MAX_CURSOR_LENGTH });

export function encodeActivityCursor(cursor: ActivityCursor): string {
  return activityCursor.encode({ a: cursor.micros, i: cursor.id });
}

/** The cursor, or null when it is malformed (the caller answers 400 `invalid_cursor`). */
export function decodeActivityCursor(raw: string): ActivityCursor | null {
  const cursor = activityCursor.decode(raw);
  return cursor ? { micros: cursor.a, id: cursor.i.toLowerCase() } : null;
}
