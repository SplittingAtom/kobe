import { Hono } from "hono";
import { and, asc, eq, installRoles, users } from "@kobe/db";
import type { AuthVariables } from "../auth/session.js";
import { requireInstallPermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { findUserId } from "../teams/members.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { idSchema, installRoleChangeSchema, transferOwnershipSchema } from "../teams/schemas.js";

/**
 * Install roles (spec D8): one Owner (transferable), Admins, everyone else a User. Install admins
 * see who holds which role; only the Owner grants or revokes Admin and transfers ownership.
 */
export function installRolesRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  const userNotFound = { code: "user_not_found", message: "No Kobe user with that id." } as const;

  app.get("/", requireInstallPermission("install.users.manage"), async (c) => {
    const rows = await db
      .select({
        userId: installRoles.userId,
        name: users.name,
        email: users.email,
        role: installRoles.role,
      })
      .from(installRoles)
      .innerJoin(users, eq(users.id, installRoles.userId))
      .orderBy(asc(installRoles.role), asc(users.name));
    return c.json({ roles: rows });
  });

  app.put("/:userId", requireInstallPermission("install.roles.manage"), async (c) => {
    const userId = idSchema.safeParse(c.req.param("userId"));
    const body = await parseBody(c, installRoleChangeSchema);
    if (!userId.success || !body) return invalidRequest(c, "role must be admin or user.");
    if (!(await findUserId(db, { id: userId.data }))) return c.json(userNotFound, 404);
    const result = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ role: installRoles.role })
        .from(installRoles)
        .where(eq(installRoles.userId, userId.data))
        .for("update");
      if (current?.role === "owner") return "owner" as const;
      if (body.role === "admin") {
        await tx
          .insert(installRoles)
          .values({ userId: userId.data, role: "admin" })
          .onConflictDoNothing();
      } else {
        await tx.delete(installRoles).where(eq(installRoles.userId, userId.data));
      }
      return "ok" as const;
    });
    if (result === "owner") {
      return c.json(
        { code: "owner_role_fixed", message: "Transfer ownership to change the Owner's role." },
        409,
      );
    }
    return c.json({ userId: userId.data, role: body.role });
  });

  /** The Owner hands ownership to another user and becomes an Admin, atomically. */
  app.post(
    "/transfer-ownership",
    requireInstallPermission("install.ownership.transfer"),
    async (c) => {
      const body = await parseBody(c, transferOwnershipSchema);
      if (!body) return invalidRequest(c, "userId must be a user id.");
      const me = c.get("user").id;
      if (body.userId === me) return invalidRequest(c, "You are already the Owner.");
      if (!(await findUserId(db, { id: body.userId }))) return c.json(userNotFound, 404);
      const transferred = await db.transaction(async (tx) => {
        // Conditional on still being Owner: a concurrent transfer by the same Owner finds no row.
        const demoted = await tx
          .update(installRoles)
          .set({ role: "admin" })
          .where(and(eq(installRoles.userId, me), eq(installRoles.role, "owner")))
          .returning({ userId: installRoles.userId });
        if (demoted.length === 0) return false;
        await tx
          .insert(installRoles)
          .values({ userId: body.userId, role: "owner" })
          .onConflictDoUpdate({ target: installRoles.userId, set: { role: "owner" } });
        return true;
      });
      if (!transferred) {
        return c.json(
          { code: "forbidden", message: "Only the Owner can transfer ownership." },
          403,
        );
      }
      return c.json({ ownerUserId: body.userId });
    },
  );

  return app;
}
