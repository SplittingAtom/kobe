import type { Context } from "hono";
import type { z } from "zod";

/**
 * Request parsing shared by the route files (KOBE-703, review CODE-18). Each route keeps its own
 * messages and status codes; these only remove the copies of the mechanics.
 */

/** The request's JSON body, or `fallback` when it is missing or not JSON. */
export async function readJson(c: Context, fallback: unknown): Promise<unknown> {
  return c.req.json().catch(() => fallback);
}

/** Parses a JSON body with `schema`; undefined means a 400 has already been chosen. */
export async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<T | undefined> {
  const parsed = schema.safeParse(await readJson(c, null));
  return parsed.success ? parsed.data : undefined;
}

/** A route parameter parsed with `schema` (the result, so a route can choose its own refusal). */
export function param<S extends z.ZodType>(
  c: { readonly req: { param(name: string): string | undefined } },
  name: string,
  schema: S,
): z.ZodSafeParseResult<z.output<S>> {
  return schema.safeParse(c.req.param(name));
}

export function invalidRequest(c: Context, message = "Check the request and try again.") {
  return c.json({ code: "invalid_request", message }, 400);
}

export function notFound<Code extends string>(c: Context, code: Code, message: string) {
  return c.json({ code, message }, 404);
}
