import { Hono } from "hono";
import { z } from "zod";
import {
  AUDIT_PII_RETENTION_KEY,
  KOBE_MCP_MODES,
  auditPiiRetentionHoursSchema,
  eq,
  inArray,
  sessionSsoContexts,
  sessions,
  siteSettings,
  readAuditPiiRetentionHours,
  type KobeTx,
} from "@kobe/db";
import { REQUIRE_TWO_FACTOR, readRequireTwoFactor, type AuthVariables } from "../auth/session.js";
import { recordAudit } from "../audit/record.js";
import { requireSitePermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";
import { readKobeMode, storeKobeMode } from "../kobe-mcp/switches.js";

const settingsSchema = z
  .strictObject({
    requireTwoFactor: z.boolean().optional(),
    /** Hours audit rows keep their client IP and user agent (KOBE-17): 1-8760, default 12. */
    auditPiiRetentionHours: auditPiiRetentionHoursSchema.optional(),
    /** The Kobe MCP site switch (KOBE-623, KA5): `off`, `docs` (default) or `admin`. */
    kobeMcpMode: z.enum(KOBE_MCP_MODES).optional(),
  })
  .refine(
    (v) =>
      v.requireTwoFactor !== undefined ||
      v.auditPiiRetentionHours !== undefined ||
      v.kobeMcpMode !== undefined,
    { message: "Change at least one setting." },
  );

async function store(tx: KobeTx, key: string, value: string): Promise<void> {
  await tx
    .insert(siteSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt: new Date() } });
}

/** Site settings (site Owner/Admin only). Each change is audited. */
export function siteSettingsRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;

  app.use(requireSitePermission("site.settings.manage"));

  const current = async () => ({
    requireTwoFactor: await readRequireTwoFactor(deps),
    auditPiiRetentionHours: await readAuditPiiRetentionHours(db),
    kobeMcpMode: await readKobeMode(db),
  });

  app.get("/", async (c) => c.json(await current()));

  app.put("/", async (c) => {
    const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          code: "invalid_request",
          message:
            "Send requireTwoFactor (true or false), auditPiiRetentionHours (1-8760) and/or " +
            "kobeMcpMode (off, docs or admin).",
        },
        400,
      );
    }
    const { requireTwoFactor, auditPiiRetentionHours, kobeMcpMode } = parsed.data;
    // Lowering the requirement weakens every account: Owner only.
    if (requireTwoFactor === false && c.get("siteRole") !== "owner") {
      return c.json(
        { code: "forbidden", message: "Only the Owner can turn off required 2FA." },
        403,
      );
    }
    await db.transaction(async (tx) => {
      // Audit last: every write first, then one event per submitted setting.
      if (requireTwoFactor !== undefined) {
        await store(tx, REQUIRE_TWO_FACTOR, String(requireTwoFactor));
      }
      // Requiring 2FA ends every SSO session whose sign-in did not prove MFA (KOBE-629 review
      // M1): such a session could never pass again, and must not live on at /api/auth/*.
      if (requireTwoFactor === true) await endSsoSessionsWithoutMfa(tx);
      if (auditPiiRetentionHours !== undefined) {
        await store(tx, AUDIT_PII_RETENTION_KEY, String(auditPiiRetentionHours));
      }
      if (requireTwoFactor !== undefined) {
        await recordAudit(tx, {
          action: "site.settings.updated",
          target: { setting: "require_two_factor", value: requireTwoFactor },
        });
      }
      if (auditPiiRetentionHours !== undefined) {
        await recordAudit(tx, {
          action: "site.settings.updated",
          target: { setting: "audit_pii_retention_hours", value: auditPiiRetentionHours },
        });
      }
      if (kobeMcpMode !== undefined) await storeKobeMode(tx, kobeMcpMode);
    });
    return c.json(await current());
  });

  return app;
}

async function endSsoSessionsWithoutMfa(tx: KobeTx): Promise<void> {
  const weak = tx
    .select({ id: sessionSsoContexts.sessionId })
    .from(sessionSsoContexts)
    .where(eq(sessionSsoContexts.mfaSatisfied, false));
  await tx.delete(sessions).where(inArray(sessions.id, weak));
}
