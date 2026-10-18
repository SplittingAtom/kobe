import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { STARTUP_SEEDED_ROWS } from "@kobe/db";
import { isolationAuditor } from "./audit/isolation.js";
import { logger } from "./logger.js";
import { FakeBifrost } from "./models/testing/fake-bifrost.js";
import { seedAtStart, serverJobs } from "./startup/jobs.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * What the server's start writes into a fresh site before first-run setup (KOBE-422): every row
 * must be one `kobe restore` may replace (`@kobe/db` STARTUP_SEEDED_ROWS), or a restore into a
 * freshly installed, started site is refused. A new start-up writer that fails here belongs in
 * STARTUP_SEEDED_ROWS (or must wait for setup, as the isolation auditor does).
 */
let h: Harness;

beforeAll(async () => {
  h = await openHarness({ egressHeaderSecrets: ["e".repeat(48)] });
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

/**
 * What a server replica runs at start (`startup/jobs.ts`, the same list `index.ts` starts), one
 * pass each, with every optional job configured: SIEM forwarding to both destinations (nothing
 * listens there, so the forwarder records a failure), the Bifrost sync (a fake admin), and the
 * egress header re-seal. Plus the isolation auditor, which `index.ts` wires into the isolation
 * gate, and the requests a load balancer and a first visitor make.
 */
async function start(): Promise<void> {
  const db = h.deps.database.db;
  await seedAtStart(h.deps, logger);
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
  const jobs = serverJobs({
    deps: h.deps,
    databaseUrl: h.appUrl,
    logger,
    auditForwarding: {
      syslog: { host: "127.0.0.1", port: 9, tls: false },
      otlp: { url: "http://127.0.0.1:9/v1/logs", headers: {} },
    },
    retention: { hourUtc: new Date().getUTCHours(), paused: false, uploadOrphanHours: 24 },
    connectorRefreshSeconds: 3600,
    models: {
      admin: new FakeBifrost(),
      config: {
        bifrostUrl: "http://bifrost.invalid",
        adminUsername: "admin",
        adminPassword: "p".repeat(32),
        providerKeySecrets: ["k".repeat(48)],
        virtualKeySecrets: ["v".repeat(48)],
        allowUnsafeEndpoints: false,
        syncIntervalMs: 3_600_000,
      },
    },
  });
  expect(jobs.map((j) => j.name)).toContain("audit-forwarding");
  for (const j of jobs) await j.once();
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
    for (const table of written) {
      const seed = STARTUP_SEEDED_ROWS[table];
      if (!seed) {
        // A table a migration seeds (packages/cli/src/seeded.ts) may change, never grow: the
        // restore replaces its rows whole. Anything else written at start must be listed.
        expect(
          before.has(table),
          `${table} is written at start but is not in STARTUP_SEEDED_ROWS`,
        ).toBe(true);
        expect(after.get(table)?.length, table).toBe(before.get(table)?.length);
        continue;
      }
      const other = await h.admin.query(
        `SELECT to_jsonb(t)::text AS r FROM public."${table}" t WHERE (${seed.rows}) IS NOT TRUE`,
      );
      expect(other.rows, `${table} rows the restore would refuse`).toEqual([]);
    }
    expect(written).toEqual(expect.arrayContaining(["audit_log", "site_agents", "site_settings"]));
    const keys = await h.admin.query<{ key: string }>(`SELECT key FROM site_settings ORDER BY key`);
    expect(keys.rows.map((r) => r.key)).toEqual(
      expect.arrayContaining(["audit.forward.otlp", "audit.forward.syslog"]),
    );
  });
});
