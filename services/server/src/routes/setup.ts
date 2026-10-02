import { Hono } from "hono";
import { z } from "zod";
import { count, eq, installRoles } from "@kobe/db";
import type { ServerDeps } from "../deps.js";

/** Serializes first-run setup across server replicas. */
const SETUP_LOCK = 0x6b6f6201;

const setupSchema = z.object({
  setupToken: z.string().max(256).optional(),
  email: z.email().max(254),
  name: z.string().trim().min(1).max(100),
  password: z.string().min(12, "password must be at least 12 characters").max(128),
});

/**
 * First-run setup (spec D7): creates the Owner while none exists, then disables itself. Requires
 * the install's setup token (from the Helm-generated Secret), so the first caller on an exposed
 * fresh install can't take ownership. An advisory lock plus the single-owner unique index
 * guarantee one Owner across replicas; the user, credential and role are written atomically.
 */
export function setupRoutes(deps: ServerDeps): Hono {
  const app = new Hono();
  const ownerExists = async (): Promise<boolean> => {
    const [row] = await deps.database.db
      .select({ n: count() })
      .from(installRoles)
      .where(eq(installRoles.role, "owner"));
    return (row?.n ?? 0) > 0;
  };
  const complete = { code: "setup_complete", message: "Kobe is already set up." } as const;

  app.get("/", async (c) => c.json({ required: !(await ownerExists()) }));

  app.post("/", async (c) => {
    // Cheap check first, without the lock: a finished install never holds a connection here.
    if (await ownerExists()) return c.json(complete, 409);
    const parsed = setupSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        { code: "invalid_request", issues: parsed.error.issues.map((i) => i.message) },
        400,
      );
    }
    if (!deps.isSetupToken(parsed.data.setupToken)) {
      return c.json(
        { code: "invalid_setup_token", message: "The setup token is missing or wrong." },
        403,
      );
    }
    const client = await deps.database.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [SETUP_LOCK]);
      if (await ownerExists()) return c.json(complete, 409);
      const { email, name, password } = parsed.data;
      const owner = await deps.createUserWithPassword(
        { email, name, password },
        { installRole: "owner" },
      );
      return c.json({ userId: owner.id }, 201);
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [SETUP_LOCK]).catch(() => undefined);
      client.release();
    }
  });

  return app;
}
