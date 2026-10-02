#!/usr/bin/env node
import { pino } from "pino";
import { z } from "zod";
import { runMigrations } from "../migrate.js";

// Entry point for the Helm pre-install/pre-upgrade migration Job.
const logger = pino({ base: { service: "kobe-migrate" } });

const envSchema = z.object({
  KOBE_DB_MIGRATE_URL: z.url({
    protocol: /^postgres(ql)?$/,
    error: "KOBE_DB_MIGRATE_URL must be a postgres:// URL",
  }),
  KOBE_DB_APP_ROLE: z.string().min(1, "KOBE_DB_APP_ROLE is required"),
});

async function main(): Promise<void> {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  await runMigrations({
    databaseUrl: parsed.data.KOBE_DB_MIGRATE_URL,
    appRole: parsed.data.KOBE_DB_APP_ROLE,
  });
  logger.info({ appRole: parsed.data.KOBE_DB_APP_ROLE }, "migrations applied");
}

main().catch((err: unknown) => {
  logger.error({ err }, "migration failed");
  process.exit(1);
});
