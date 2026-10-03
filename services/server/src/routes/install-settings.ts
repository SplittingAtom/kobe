import { Hono } from "hono";
import { z } from "zod";
import {
  AUDIT_PII_RETENTION_KEY,
  auditPiiRetentionHoursSchema,
  installSettings,
  readAuditPiiRetentionHours,
  type KobeTx,
} from "@kobe/db";
import { REQUIRE_TWO_FACTOR, readRequireTwoFactor, type AuthVariables } from "../auth/session.js";
import { recordAudit } from "../audit/record.js";
import { requireInstallPermission } from "../authz/middleware.js";
import type { ServerDeps } from "../deps.js";

const settingsSchema = z
  .strictObject({
    requireTwoFactor: z.boolean().optional(),
    /** Hours audit rows keep their client IP and user agent (KOBE-17): 1-8760, default 12. */
    auditPiiRetentionHours: auditPiiRetentionHoursSchema.optional(),
  })
  .refine((v) => v.requireTwoFactor !== undefined || v.auditPiiRetentionHours !== undefined, {
    message: "Change at least one setting.",
  });

async function store(tx: KobeTx, key: string, value: string): Promise<void> {
  await tx
    .insert(installSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: installSettings.key, set: { value, updatedAt: new Date() } });
}

/** Install settings (install Owner/Admin only). Each change is audited. */
export function installSettingsRoutes(deps: ServerDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const db = deps.database.db;

  app.use(requireInstallPermission("install.settings.manage"));

  const current = async () => ({
    requireTwoFactor: await readRequireTwoFactor(deps),
    auditPiiRetentionHours: await readAuditPiiRetentionHours(db),
  });

  app.get("/", async (c) => c.json(await current()));

  app.put("/", async (c) => {
    const parsed = settingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          code: "invalid_request",
          message: "Send requireTwoFactor (true or false) and/or auditPiiRetentionHours (1-8760).",
        },
        400,
      );
    }
    const { requireTwoFactor, auditPiiRetentionHours } = parsed.data;
    // Lowering the requirement weakens every account: Owner only.
    if (requireTwoFactor === false && c.get("installRole") !== "owner") {
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
      if (auditPiiRetentionHours !== undefined) {
        await store(tx, AUDIT_PII_RETENTION_KEY, String(auditPiiRetentionHours));
      }
      if (requireTwoFactor !== undefined) {
        await recordAudit(tx, {
          action: "install.settings.updated",
          target: { setting: "require_two_factor", value: requireTwoFactor },
        });
      }
      if (auditPiiRetentionHours !== undefined) {
        await recordAudit(tx, {
          action: "install.settings.updated",
          target: { setting: "audit_pii_retention_hours", value: auditPiiRetentionHours },
        });
      }
    });
    return c.json(await current());
  });

  return app;
}
