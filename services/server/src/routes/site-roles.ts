import { Hono } from "hono";
import { z } from "zod";
import { SITE_GRANTS } from "@kobe/protocol";
import { giveGrant, listGrants, takeGrant } from "../skills/registry/grants.js";
import { and, asc, eq, siteRoles, ne, users } from "@kobe/db";
import type { AuthVariables } from "../auth/session.js";
import { recordAudit } from "../audit/record.js";
import { requireSitePermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { findUserId } from "../teams/members.js";
import { invalidRequest, parseBody } from "../teams/http.js";
import { idSchema, siteRoleChangeSchema, transferOwnershipSchema } from "../teams/schemas.js";

/**
 * Site roles (spec D8): one Owner (transferable), Admins, everyone else a User. Site admins
 * see who holds which role; only the Owner grants or revokes Admin and transfers ownership.
 * Site grants (KOBE-331): the Owner or a Site admin gives and takes the Skill reviewer grant.
 */
export function siteRolesRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;
  const userNotFound = { code: "user_not_found", message: "No Kobe user with that id." } as const;

  app.get("/", requireSitePermission("site.users.manage"), async (c) => {
    const rows = await db
      .select({
        userId: siteRoles.userId,
        name: users.name,
        email: users.email,
        role: siteRoles.role,
      })
      .from(siteRoles)
      .innerJoin(users, eq(users.id, siteRoles.userId))
      .orderBy(asc(siteRoles.role), asc(users.name));
    return c.json({ roles: rows });
  });

  app.put("/:userId", requireSitePermission("site.roles.manage"), async (c) => {
    const userId = idSchema.safeParse(c.req.param("userId"));
    const body = await parseBody(c, siteRoleChangeSchema);
    if (!userId.success || !body) return invalidRequest(c, "role must be admin or user.");
    if (!(await findUserId(db, { id: userId.data }))) return c.json(userNotFound, 404);
    const result = await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ role: siteRoles.role })
        .from(siteRoles)
        .where(eq(siteRoles.userId, userId.data))
        .for("update");
      if (current?.role === "owner") return "owner" as const;
      const changed =
        body.role === "admin"
          ? await tx
              .insert(siteRoles)
              .values({ userId: userId.data, role: "admin" })
              .onConflictDoNothing()
              .returning({ userId: siteRoles.userId })
          : // Never the Owner row: a concurrent transfer may have made this user Owner meanwhile.
            await tx
              .delete(siteRoles)
              .where(and(eq(siteRoles.userId, userId.data), ne(siteRoles.role, "owner")))
              .returning({ userId: siteRoles.userId });
      if (changed.length > 0) {
        await recordAudit(tx, {
          action:
            body.role === "admin" ? "identity.site_role.granted" : "identity.site_role.revoked",
          target: { userId: userId.data, role: "admin" },
        });
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

  // Site grants beside the ladder (KOBE-331, SK22): read like roles, changed by Site admins.
  app.get("/grants", requireSitePermission("site.users.manage"), async (c) =>
    c.json({ grants: await listGrants(db) }),
  );

  const grantParams = (c: { req: { param(name: string): string } }) => {
    const userId = idSchema.safeParse(c.req.param("userId"));
    const grant = z.enum(SITE_GRANTS).safeParse(c.req.param("grant"));
    return userId.success && grant.success ? { userId: userId.data, grant: grant.data } : null;
  };

  app.put("/grants/:userId/:grant", requireSitePermission("site.grants.manage"), async (c) => {
    const p = grantParams(c);
    if (!p) return invalidRequest(c, "Name a user and the grant skill_reviewer.");
    const r = await giveGrant(db, p.userId, p.grant, c.get("user").id);
    if (r.ok) return c.json({ userId: p.userId, grant: p.grant, changed: r.changed });
    if (r.code === "user_not_found") return c.json(userNotFound, 404);
    if (r.code === "user_deactivated")
      return c.json(
        { code: "user_deactivated", message: "Reactivate the account before granting." },
        409,
      );
    return c.json(
      {
        code: "self_grant",
        message:
          "Another Site admin gives you the grant; on a single-admin Site you may give it to yourself (flagged).",
      },
      403,
    );
  });

  app.delete("/grants/:userId/:grant", requireSitePermission("site.grants.manage"), async (c) => {
    const p = grantParams(c);
    if (!p) return invalidRequest(c, "Name a user and the grant skill_reviewer.");
    if (!(await findUserId(db, { id: p.userId }))) return c.json(userNotFound, 404);
    const { changed } = await takeGrant(db, p.userId, p.grant);
    if (!changed)
      return c.json({ code: "not_found", message: "That user doesn't hold that grant." }, 404);
    return new Response(null, { status: 204 });
  });

  /** The Owner hands ownership to another user and becomes an Admin, atomically. */
  app.post("/transfer-ownership", requireSitePermission("site.ownership.transfer"), async (c) => {
    const body = await parseBody(c, transferOwnershipSchema);
    if (!body) return invalidRequest(c, "userId must be a user id.");
    const me = c.get("user").id;
    if (body.userId === me) return invalidRequest(c, "You are already the Owner.");
    if (!(await findUserId(db, { id: body.userId }))) return c.json(userNotFound, 404);
    const transferred = await db.transaction(async (tx) => {
      // Conditional on still being Owner: a concurrent transfer by the same Owner finds no row.
      const demoted = await tx
        .update(siteRoles)
        .set({ role: "admin" })
        .where(and(eq(siteRoles.userId, me), eq(siteRoles.role, "owner")))
        .returning({ userId: siteRoles.userId });
      if (demoted.length === 0) return false;
      await tx
        .insert(siteRoles)
        .values({ userId: body.userId, role: "owner" })
        .onConflictDoUpdate({ target: siteRoles.userId, set: { role: "owner" } });
      await recordAudit(tx, {
        action: "identity.ownership.transferred",
        target: { fromUserId: me, toUserId: body.userId },
      });
      return true;
    });
    if (!transferred) {
      return c.json({ code: "forbidden", message: "Only the Owner can transfer ownership." }, 403);
    }
    return c.json({ ownerUserId: body.userId });
  });

  return app;
}
