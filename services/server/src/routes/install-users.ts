import { Hono, type Context } from "hono";
import { asc, eq, installRoles, users } from "@kobe/db";
import type { AuthVariables } from "../auth/session.js";
import { requireInstallPermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { invalidRequest } from "../teams/http.js";
import { idSchema } from "../teams/schemas.js";
import {
  deactivateUser,
  reactivateUser,
  teamsLeftWithoutActiveAdmin,
} from "../users/deactivation.js";

/**
 * Install users (spec D7, §6.1 `/v1/install/users`): list, deactivate, reactivate. Deactivation
 * blocks every sign-in method and all API access at once and revokes every session; memberships
 * are kept so reactivation restores the user's teams. Admins act on Users; only the Owner acts on
 * Admins (as with granting Admin); the Owner can't be deactivated (transfer ownership first).
 */
export function installUsersRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  app.use(requireInstallPermission("install.users.manage"));

  app.get("/", async (c) => {
    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        installRole: installRoles.role,
        twoFactorEnabled: users.twoFactorEnabled,
        deactivatedAt: users.deactivatedAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .leftJoin(installRoles, eq(installRoles.userId, users.id))
      .orderBy(asc(users.name), asc(users.email));
    return c.json({
      users: rows.map((u) => ({
        ...u,
        installRole: u.installRole ?? "user",
        deactivatedAt: u.deactivatedAt?.toISOString() ?? null,
        createdAt: u.createdAt.toISOString(),
      })),
    });
  });

  /** Checks that the caller may change this user's activation; a Response when not. */
  async function guard(c: Context<{ Variables: AuthVariables }>, userId: string) {
    if (userId === c.get("user").id) {
      return c.json(
        { code: "cannot_change_self", message: "You can't deactivate or reactivate yourself." },
        400,
      );
    }
    const [target] = await db
      .select({ id: users.id, role: installRoles.role })
      .from(users)
      .leftJoin(installRoles, eq(installRoles.userId, users.id))
      .where(eq(users.id, userId));
    if (!target)
      return c.json({ code: "user_not_found", message: "No Kobe user with that id." }, 404);
    if (target.role === "owner") {
      return c.json(
        { code: "owner_cannot_be_deactivated", message: "Transfer ownership first." },
        409,
      );
    }
    if (target.role === "admin" && c.get("installRole") !== "owner") {
      return c.json(
        { code: "forbidden", message: "Only the Owner can deactivate or reactivate an Admin." },
        403,
      );
    }
    return null;
  }

  app.post("/:userId/deactivate", async (c) => {
    const userId = idSchema.safeParse(c.req.param("userId"));
    if (!userId.success) return invalidRequest(c);
    const refused = await guard(c, userId.data);
    if (refused) return refused;
    await deactivateUser(db, userId.data);
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
    const refused = await guard(c, userId.data);
    if (refused) return refused;
    await reactivateUser(db, userId.data);
    const incompleteSteps = await deps.lifecycle.emit("reactivated", userId.data);
    return c.json({ userId: userId.data, deactivated: false, incompleteSteps });
  });

  return app;
}
