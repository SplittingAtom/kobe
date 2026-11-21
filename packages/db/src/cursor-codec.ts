import type { z } from "zod";

/**
 * Opaque paging cursors (KOBE-702): base64url of the JSON of a small value. Not signed; a cursor
 * only names a position in the caller's own listing, so the schema is what keeps a crafted one
 * from reaching a query.
 */

/** Longest cursor text decoded by default; anything longer is refused unread. */
export const CURSOR_MAX_LENGTH = 4096;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface CursorCodec<In, Out> {
  /** base64url(JSON.stringify(value)): key order is the caller's, so tokens stay byte-stable. */
  encode(value: In): string;
  /** The value, or undefined for text that is malformed, oversized or of the wrong shape. */
  decode(raw: string): Out | undefined;
}

export function makeCursorCodec<S extends z.ZodType>(
  schema: S,
  options: { readonly maxLength?: number } = {},
): CursorCodec<z.input<S>, z.output<S>> {
  const maxLength = options.maxLength ?? CURSOR_MAX_LENGTH;
  return {
    encode: (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url"),
    decode: (raw) => {
      if (raw.length === 0 || raw.length > maxLength || !BASE64URL.test(raw)) return undefined;
      let json: unknown;
      try {
        json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
      } catch {
        return undefined;
      }
      const parsed = schema.safeParse(json);
      return parsed.success ? parsed.data : undefined;
    },
  };
}
