import type { Context } from "hono";
import { auditQuerySchema, type AuditPage, type AuditQuery, type TeamAuditPage } from "@kobe/db";

type Parsed = { ok: true; value: AuditQuery } | { ok: false; response: Response };

/** Validates audit list query parameters (strict: unknown parameters are a 400). */
export function parseAuditQuery(c: Context, { allowTeamFilter = true } = {}): Parsed {
  const raw = c.req.query();
  const parsed = auditQuerySchema.safeParse(raw);
  if (!parsed.success || (!allowTeamFilter && raw.teamId !== undefined)) {
    return {
      ok: false,
      response: c.json(
        {
          code: "invalid_request",
          message:
            "Check the filters: limit 1-200, before/after (not both), a known action or category, " +
            "actorId (and teamId on the install log) as ids, since/until as ISO date-times.",
        },
        400,
      ),
    };
  }
  return { ok: true, value: parsed.data };
}

/** JSON body of one page; `nextCursor` is a string so clients treat it as opaque. */
export function auditPageBody(page: AuditPage | TeamAuditPage) {
  return {
    events: page.events.map((e) => ({ ...e, at: e.at.toISOString() })),
    nextCursor: page.nextCursor === null ? null : String(page.nextCursor),
  };
}
