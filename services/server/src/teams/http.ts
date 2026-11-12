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
  changed_since_approval: [
    409,
    "The member's role changed since you loaded it; nothing was changed. Check the current role and try again.",
  ],
  managed_by_idp: [
    409,
    "The identity provider manages this membership. Take it over first, or change it in the identity provider.",
  ],
  not_managed: [409, "No identity provider manages this membership."],
} as const satisfies Record<MembershipError, readonly [number, string]>;

export function membershipError(c: Context, error: MembershipError) {
  const [status, message] = MEMBERSHIP_ERRORS[error];
  return c.json({ code: error, message }, status);
}
