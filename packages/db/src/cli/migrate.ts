#!/usr/bin/env node
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";
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
  KOBE_DB_CONNECT_TIMEOUT_S: z.coerce.number().int().positive().default(300),
});

/** A bundled database may still be starting (CloudNativePG post-install); retry until it accepts. */
async function waitForDatabase(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const client = new pg.Client({ connectionString: url });
    try {
      await client.connect();
      return;
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      logger.info("database not reachable yet; retrying");
      await sleep(3_000);
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}

async function main(): Promise<void> {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  await waitForDatabase(
    parsed.data.KOBE_DB_MIGRATE_URL,
    parsed.data.KOBE_DB_CONNECT_TIMEOUT_S * 1000,
  );
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
