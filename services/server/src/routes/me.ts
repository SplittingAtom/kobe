import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { eq, sql, users } from "@kobe/db";
import {
  readUiPreferences,
  scheduleTimezoneSchema,
  uiPreferencesSchema,
  UI_PREFERENCES_MAX_BODY,
} from "@kobe/protocol";
import { z } from "zod";
import type { AuthVariables } from "../auth/session.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest, parseBody } from "../teams/http.js";

const INVALID = "Send known layout preferences within their bounds.";

function pgCode(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  const code = e.cause?.code ?? e.code;
  return typeof code === "string" ? code : undefined;
}

export function meRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.get("/", (c) => c.json({ user: c.get("user"), siteRole: c.get("siteRole") }));

  /**
   * `GET/PUT /v1/me/preferences` (KOBE-202, CE8): the caller's layout preferences, kept on their
   * own `users` row (Site-wide, no team). The app role may update any user row, so this route is
   * the guard: both verbs only ever touch `WHERE id = <session user>`; there is no id to name.
   *
   * A PUT stores the keys it sends and keeps the others (a merge in one statement, so two
   * devices saving different keys don't overwrite each other). Unknown keys and out-of-bounds
   * values are refused with 400; the body is capped at UI_PREFERENCES_MAX_BODY bytes (413); the
   * column's CHECK (a JSON object of at most 4096 bytes as jsonb text) maps to 400, never 500.
   * The client debounces writes: a run's transaction holds FOR SHARE on the user's row.
   */
  app.get("/preferences", async (c) => {
    const [row] = await db
      .select({ prefs: users.uiPreferences })
      .from(users)
      .where(eq(users.id, c.get("user").id));
    return c.json({ preferences: readUiPreferences(row?.prefs ?? null) });
  });

  app.put(
    "/preferences",
    bodyLimit({
      maxSize: UI_PREFERENCES_MAX_BODY,
      onError: (c) =>
        c.json({ code: "payload_too_large", message: "Layout preferences are too large." }, 413),
    }),
    async (c) => {
      const change = await parseBody(c, uiPreferencesSchema);
      if (!change) return invalidRequest(c, INVALID);
      try {
        const [row] = await db
          .update(users)
          .set({
            uiPreferences: sql`coalesce(${users.uiPreferences}, '{}'::jsonb) || ${JSON.stringify(change)}::jsonb`,
          })
          .where(eq(users.id, c.get("user").id))
          .returning({ prefs: users.uiPreferences });
        return c.json({ preferences: readUiPreferences(row?.prefs ?? null) });
      } catch (err) {
        // users_ui_preferences CHECK: the merged document is too large (or not an object).
        if (pgCode(err) === "23514") return invalidRequest(c, INVALID);
        throw err;
      }
    },
  );
  /**
   * `GET/PUT /v1/me/time-zone` (KOBE-289): the member's IANA time zone, kept on their own `users`
   * row. The server ends "until end of today" approvals at midnight there; it never takes a time
   * zone from an approval request. Null = UTC. Only ever `WHERE id = <session user>`.
   */
  app.get("/time-zone", async (c) => {
    const [row] = await db
      .select({ timeZone: users.timeZone })
      .from(users)
      .where(eq(users.id, c.get("user").id));
    return c.json({ time_zone: row?.timeZone ?? null });
  });

  app.put("/time-zone", async (c) => {
    const body = await parseBody(c, timeZoneBodySchema);
    if (!body) return invalidRequest(c, "Send time_zone: an IANA zone name such as Europe/Berlin.");
    await db
      .update(users)
      .set({ timeZone: body.time_zone })
      .where(eq(users.id, c.get("user").id));
    return c.json({ time_zone: body.time_zone });
  });
  return app;
}

const timeZoneBodySchema = z.strictObject({ time_zone: scheduleTimezoneSchema.nullable() });
