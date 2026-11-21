import type { Context } from "hono";
import type { z } from "zod";
import { expiresInFuture, ruleIdSchema, type RuleBodyFields } from "./schemas.js";
import { invalidRequest, notFound, param, readJson } from "../http/request.js";

export type ParsedBody<T> = { ok: true; value: T } | { ok: false; response: Response };

/** Parses and validates a rule body; the 400 names the first problem without echoing input. */
export async function parseRuleBody<T extends RuleBodyFields>(
  c: Context,
  schema: z.ZodType<T>,
): Promise<ParsedBody<T>> {
  const parsed = schema.safeParse(await readJson(c, null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") ?? "body";
    return {
      ok: false,
      response: invalidRequest(c, `Check ${where || "the rule"}: ${issue?.message ?? "invalid"}.`),
    };
  }
  if (!expiresInFuture(parsed.data.expires_at, new Date())) {
    return { ok: false, response: invalidRequest(c, "expires_at must be in the future.") };
  }
  return { ok: true, value: parsed.data };
}

export function ruleIdParam(c: Context): string | undefined {
  const parsed = param(c, "id", ruleIdSchema);
  return parsed.success ? parsed.data : undefined;
}

export function ruleNotFound(c: Context) {
  return notFound(c, "rule_not_found", "No such rule.");
}

export function ruleLimitReached(c: Context) {
  return c.json(
    { code: "too_many_rules", message: "This scope has reached its rule limit. Remove one first." },
    409,
  );
}
