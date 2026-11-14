import { Hono, type Context } from "hono";
import { z } from "zod";
import { asc, eq, siteRoles, users } from "@kobe/db";
import type { AuthVariables } from "../auth/session.js";
import { requireSitePermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest } from "../teams/http.js";
import { idSchema } from "../teams/schemas.js";
import {
  deactivateUser,
  reactivateUser,
  teamsLeftWithoutActiveAdmin,
} from "../users/deactivation.js";

const purgeBodySchema = z.strictObject({ confirmEmail: z.string().min(3).max(320) });

const expectedStateSchema = z.strictObject({
  expectedState: z.enum(["active", "deactivated"]).optional(),
});

/**
 * Site users (spec D7, §6.1 `/v1/site/users`): list, deactivate, reactivate, purge portable memories. Deactivation
 * blocks every sign-in method and all API access at once and revokes every session; memberships
 * are kept so reactivation restores the user's teams. Admins act on Users; only the Owner acts on
 * Admins (as with granting Admin); the Owner can't be deactivated (transfer ownership first).
 */
export function siteUsersRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireSitePermission("site.users.manage"));

  app.get("/", async (c) => {
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        siteRole: siteRoles.role,
        twoFactorEnabled: users.twoFactorEnabled,
        deactivatedAt: users.deactivatedAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .leftJoin(siteRoles, eq(siteRoles.userId, users.id))
      .orderBy(asc(users.name), asc(users.email));
    return c.json({
      users: rows.map((u) => ({
        ...u,
        siteRole: u.siteRole ?? "user",
        deactivatedAt: u.deactivatedAt?.toISOString() ?? null,
        createdAt: u.createdAt.toISOString(),
      })),
    });
  });

  /**
   * Checks that the caller may change this user's activation (or purge their memories, `what`);
   * a Response when not.
   */
  async function guard(
    c: Context<{ Variables: AuthVariables }>,
    userId: string,
    what: "activation" | "purge" = "activation",
  ) {
    const act = what === "purge" ? "purge the memories of" : "deactivate or reactivate";
    if (userId === c.get("user").id) {
      return c.json(
        {
          code: "cannot_change_self",
          message:
            what === "purge" ? "You can't purge your own memories." : `You can't ${act} yourself.`,
        },
        400,
      );
    }
    const [target] = await db
      .select({ id: users.id, role: siteRoles.role })
      .from(users)
      .leftJoin(siteRoles, eq(siteRoles.userId, users.id))
      .where(eq(users.id, userId));
    if (!target)
      return c.json({ code: "user_not_found", message: "No Kobe user with that id." }, 404);
    if (target.role === "owner") {
      return c.json(
        { code: "owner_cannot_be_deactivated", message: "Transfer ownership first." },
        409,
      );
    }
    if (target.role === "admin" && c.get("siteRole") !== "owner") {
      return c.json({ code: "forbidden", message: `Only the Owner can ${act} an Admin.` }, 403);
    }
    return null;
  }

  /**
   * The optional body `{expectedState}` (KOBE-622): the state the caller saw. The change itself is
   * a conditional update, so when it changed nothing (someone else got there first) the call is
   * refused 409 `changed_since_approval` instead of reporting success (the Kobe MCP tools send the
   * approved before-state; the console sends no body).
   */
  async function expected(c: Context, want: "active" | "deactivated") {
    const raw: unknown = await c.req.json().catch(() => ({}));
    const parsed = expectedStateSchema.safeParse(raw ?? {});
    if (!parsed.success) return { ok: false as const, response: invalidRequest(c) };
    const state = parsed.data.expectedState;
    return { ok: true as const, check: state !== undefined, matches: state === want };
  }
  const changed = (c: Context) =>
    c.json(
      {
        code: "changed_since_approval",
        message: "The account's state changed meanwhile; nothing was changed.",
      },
      409,
    );

  app.post("/:userId/deactivate", async (c) => {
    const userId = idSchema.safeParse(c.req.param("userId"));
    if (!userId.success) return invalidRequest(c);
    const want = await expected(c, "active");
    if (!want.ok) return want.response;
    if (want.check && !want.matches) return changed(c);
    const refused = await guard(c, userId.data);
    if (refused) return refused;
    const did = await deactivateUser(db, userId.data);
    if (want.check && !did) return changed(c);
    const incompleteSteps = await deps.lifecycle.emit("deactivated", userId.data);
    return c.json({
      userId: userId.data,
      deactivated: true,
      // Teams whose only active team admin this was: nobody can manage them until reactivation.
      teamsWithoutActiveAdmin: await teamsLeftWithoutActiveAdmin(db, userId.data),
      incompleteSteps,
    });
  });

  app.post("/:userId/reactivate", async (c) => {
    const userId = idSchema.safeParse(c.req.param("userId"));
    if (!userId.success) return invalidRequest(c);
    const want = await expected(c, "deactivated");
    if (!want.ok) return want.response;
    if (want.check && !want.matches) return changed(c);
    const refused = await guard(c, userId.data);
    if (refused) return refused;
    const did = await reactivateUser(db, userId.data);
    if (want.check && !did) return changed(c);
    const incompleteSteps = await deps.lifecycle.emit("reactivated", userId.data);
    return c.json({ userId: userId.data, deactivated: false, incompleteSteps });
  });

  /**
   * Purge a deactivated person's portable memories (v1.3 Q7, KOBE-386): deactivation keeps them
   * and reactivation restores them unchanged until a site admin purges them here. Refused for an
   * active account (409 `user_active`) and while a legal hold covers the person (409
   * `legal_hold`). Same rules as deactivation for who may act on whom.
   */
  app.post("/:userId/portable-memory/purge", async (c) => {
    const userId = idSchema.safeParse(c.req.param("userId"));
    if (!userId.success) return invalidRequest(c);
    const body = purgeBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalidRequest(c, "Type the person's email address to confirm.");
    const refused = await guard(c, userId.data, "purge");
    if (refused) return refused;
    // One site admin is enough (Chris 2026-11-13, review L3), with a typed confirmation: the
    // person's email address, checked here as well as in the console.
    const [target] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId.data));
    if (!target || target.email.toLowerCase() !== body.data.confirmEmail.trim().toLowerCase())
      return c.json(
        {
          code: "confirmation_mismatch",
          message: "The email address typed doesn't match this person; nothing was purged.",
        },
        400,
      );
    const outcome = await deps.offboarding.purgePortable(userId.data);
    switch (outcome.status) {
      case "purged":
        return c.json({
          userId: userId.data,
          purged: outcome.counts.items,
          kept: outcome.counts.kept,
          // More than one call's batches: call again to continue (idempotent).
          remaining: outcome.remaining,
        });
      case "not_found":
        return c.json({ code: "user_not_found", message: "No Kobe user with that id." }, 404);
      case "active":
        return c.json(
          { code: "user_active", message: "Deactivate the account before purging its memories." },
          409,
        );
      case "held":
        return c.json(
          { code: "legal_hold", message: "A legal hold covers this person; nothing was purged." },
          409,
        );
      case "paused":
        return c.json(
          {
            code: "retention_paused",
            message: "Retention is paused on this site; nothing was purged.",
          },
          503,
        );
    }
  });

  return app;
}
