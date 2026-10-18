import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STARTUP_SEEDED_ROWS } from "@kobe/db";
import { isolationAuditor } from "./audit/isolation.js";
import { sweepAuditPii } from "./audit/pii-sweeper.js";
import { seedGalleryAgents } from "./gallery/seed.js";
import { logger } from "./logger.js";
import { RetentionJob } from "./retention/job.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * What the server's start writes into a fresh site before first-run setup (KOBE-422): every row
 * must be one `kobe restore` may replace (`@kobe/db` STARTUP_SEEDED_ROWS), or a restore into a
 * freshly installed, started site is refused. A new start-up writer that fails here belongs in
 * STARTUP_SEEDED_ROWS (or must wait for setup, as the isolation auditor does).
 */
let h: Harness;

beforeAll(async () => {
  h = await openHarness();
});
afterAll(async () => {
  await h.close();
});

/** Every table's rows as JSON text, sorted (tables without rows left out). */
async function snapshot(): Promise<Map<string, string[]>> {
  const { rows } = await h.admin.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`,
  );
  const out = new Map<string, string[]>();
  for (const { name } of rows) {
    const res = await h.admin.query<{ r: string }>(
      `SELECT to_jsonb(t)::text AS r FROM public."${name}" t ORDER BY 1`,
    );
    if (res.rows.length > 0)
      out.set(
        name,
        res.rows.map((r) => r.r),
      );
  }
  return out;
}

/** The server's start-up writers that run without a person (services/server/src/index.ts). */
async function start(): Promise<void> {
  const db = h.deps.database.db;
  await seedGalleryAgents(db);
  const isolation = isolationAuditor(db, "replica-1");
  await isolation({
    state: "verified",
    runtimeClassName: "gvisor",
    handler: "runsc",
    checkedAt: new Date(),
  });
  await isolation({
    state: "missing",
    runtimeClassName: "gvisor",
    message: "gone",
    checkedAt: new Date(),
  });
  await new RetentionJob({ db, pool: h.deps.database.pool, hourUtc: 3, logger }).tick(true);
  await sweepAuditPii(db);
  const browser = h.browser();
  for (const path of ["/healthz", "/readyz", "/v1/setup"]) await browser.get(path);
}

describe("rows a fresh site's start writes (KOBE-422)", () => {
  it("are all startup seeds the restore replaces; nothing else changes", async () => {
    const before = await snapshot();
    await start();
    await start(); // a restart, as a rollout does: still only seeds
    const after = await snapshot();
    const written = [...after.keys()].filter(
      (t) => JSON.stringify(after.get(t)) !== JSON.stringify(before.get(t)),
    );
    expect(written.sort()).toEqual(
      ["audit_log", "site_agent_versions", "site_agents", "site_settings"].sort(),
    );
    for (const table of written) {
      const seed = STARTUP_SEEDED_ROWS[table];
      expect(seed, `${table} is written at start but is not in STARTUP_SEEDED_ROWS`).toBeDefined();
      const other = await h.admin.query(
        `SELECT to_jsonb(t)::text AS r FROM public."${table}" t WHERE (${seed?.rows ?? "false"}) IS NOT TRUE`,
      );
      expect(other.rows, `${table} rows the restore would refuse`).toEqual([]);
    }
  });
});
