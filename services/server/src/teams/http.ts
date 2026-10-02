import type { Context } from "hono";
import type { z } from "zod";
import type { MembershipError } from "./members.js";

/** Parses a JSON body with `schema`; undefined means a 400 has already been chosen. */
export async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<T | undefined> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : undefined;
}

export function invalidRequest(c: Context, message = "Check the request and try again.") {
  return c.json({ code: "invalid_request", message }, 400);
}

const MEMBERSHIP_ERRORS = {
  not_a_member: [404, "That user is not a member of this team."],
  last_team_admin: [409, "A team needs at least one team admin. Promote someone else first."],
} as const satisfies Record<MembershipError, readonly [number, string]>;

export function membershipError(c: Context, error: MembershipError) {
  const [status, message] = MEMBERSHIP_ERRORS[error];
  return c.json({ code: error, message }, status);
}
