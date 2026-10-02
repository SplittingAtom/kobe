import { Hono } from "hono";
import { z } from "zod";
import { count, installRoles, users } from "@kobe/db";
import type { ServerDeps } from "../deps.js";

/** Serializes first-run setup across server replicas. */
const SETUP_LOCK = 0x6b6f6201;

const setupSchema = z.object({
  email: z.email().max(254),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(12, "password must be at least 12 characters").max(128),
});

/**
 * First-run setup (spec D7): creates the Owner while no user exists, then disables itself. An
 * advisory lock plus the single-owner unique index guarantee one Owner across replicas.
 */
export function setupRoutes(deps: ServerDeps): Hono {
  const app = new Hono();
  const userCount = async (): Promise<number> => {
    const [row] = await deps.database.db.select({ n: count() }).from(users);
    return row?.n ?? 0;
  };

  app.get("/", async (c) => c.json({ required: (await userCount()) === 0 }));

  app.post("/", async (c) => {
    const parsed = setupSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { code: "invalid_request", issues: parsed.error.issues.map((i) => i.message) },
        400,
      );
    }
    const client = await deps.database.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [SETUP_LOCK]);
      if ((await userCount()) > 0) {
        return c.json({ code: "setup_complete", message: "Kobe is already set up." }, 409);
      }
      const owner = await deps.createUserWithPassword(parsed.data);
      await deps.database.db.insert(installRoles).values({ userId: owner.id, role: "owner" });
      return c.json({ userId: owner.id }, 201);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [SETUP_LOCK]).catch(() => undefined);
      client.release();
    }
  });

  return app;
}
