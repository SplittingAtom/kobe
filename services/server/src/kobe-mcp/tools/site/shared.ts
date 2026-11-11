import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { BeforeState, KobeRoute, KobeRouteCaller } from "../../catalog.js";

/**
 * Helpers shared by the Site console tools (KOBE-622, spec kobe-admin-mcp §5 Site list): reading a
 * console route as the person for a write's before-state, and bounding text the model sees.
 */

/** Reads a console route as the person and parses its 2xx body; undefined when unreadable. */
export async function readAs<T>(
  call: KobeRouteCaller,
  route: KobeRoute,
  schema: z.ZodType<T>,
): Promise<T | undefined> {
  const answer = await call(route);
  if (answer.status < 200 || answer.status > 299) return undefined;
  const parsed = schema.safeParse(answer.body);
  return parsed.success ? parsed.data : undefined;
}

/** A refusal of the write's own (the target is gone), not "changed". */
export const missing = (code: string, message: string): BeforeState => ({ code, message });

/** Bounded text for the model (names, notes, reasons). */
export const clip = (value: string, max: number): string => value.slice(0, max);

/** A case-insensitive substring filter over a few fields. */
export function matches(query: string | undefined, ...fields: (string | null)[]): boolean {
  if (query === undefined) return true;
  const q = query.toLowerCase();
  return fields.some((f) => f !== null && f.toLowerCase().includes(q));
}

/** An optional search text: short, one line. */
export const querySchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\p{Cc}]*$/u);

/**
 * Key-by-key equality of the named before-state values; objects compared deeply and independent of
 * key order (a theme read back with its keys in another order is the same theme).
 */
export function sameValues(
  expected: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
): boolean {
  return Object.entries(expected).every(
    ([k, v]) => v === undefined || isDeepStrictEqual(v, current[k]),
  );
}

/**
 * A connector URL as the model may see it (security review): scheme, host, port and path only.
 * User info and the query (where keys and tokens hide) and the fragment are dropped.
 */
export function publicUrl(url: string): string {
  try {
    const u = new URL(url);
    return clip(`${u.origin}${u.pathname}`, 300);
  } catch {
    return "(not shown)";
  }
}

/** "a → b" for the card's summary line; values from the input only. */
export function changeLine(
  from: Readonly<Record<string, unknown>>,
  to: Readonly<Record<string, unknown>>,
): string {
  return Object.keys(to)
    .filter((k) => to[k] !== undefined)
    .map((k) => `${k}: ${JSON.stringify(from[k] ?? null)} → ${JSON.stringify(to[k])}`)
    .join(", ");
}

/** Refines a `{from, to}` change: something changes and every changed key names its before-state. */
export function fromTo<S extends z.ZodRawShape>(shape: S) {
  const part = z.strictObject(shape).partial();
  return z
    .strictObject({ from: part, to: part })
    .refine((v) => Object.values(v.to).some((x) => x !== undefined), {
      message: "Name at least one value to change in `to`.",
    })
    .refine((v) => Object.keys(v.to).every((k) => k in v.from), {
      message:
        "Every value in `to` needs its current value in `from` (from the matching read tool).",
    });
}
