import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDatabase, testServerUrl, type TestDatabase } from "./database.js";
import { attachPoolErrorLogger } from "./pool-errors.js";

/**
 * KOBE-507: a db test file closed its pool and dropped its database WITH (FORCE) at once. A pool's
 * `end()` resolves before its clients' sockets close, so the drop terminated a still-closing
 * backend; Postgres sent FATAL 57P01 to that idle client, the pool re-emitted it as 'error' with no
 * listener, and vitest reported an unhandled error although every test passed.
 */

let db: TestDatabase | undefined;
const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
};

beforeAll(async () => {
  db = await createTestDatabase(testServerUrl());
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

async function backendPid(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error("no backend pid");
  return pid;
}

async function terminate(pid: number): Promise<void> {
  const admin = new pg.Client({ connectionString: database().adminUrl });
  await admin.connect();
  try {
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
  } finally {
    await admin.end();
  }
}

describe("db test pools (KOBE-507)", () => {
  it("logs a terminated idle pool client instead of throwing", async () => {
    const log = vi.fn();
    const uninstall = attachPoolErrorLogger(log);
    const pool = new pg.Pool({ connectionString: database().adminUrl, max: 1 });
    try {
      const removed = new Promise((resolve) => pool.once("remove", resolve));
      await terminate(await backendPid(pool));
      await removed;
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0]?.[1]).toMatchObject({ code: "57P01" });
    } finally {
      uninstall();
      await pool.end();
    }
  });

  it("still throws any other error on a pool without its own listener", async () => {
    const log = vi.fn();
    const uninstall = attachPoolErrorLogger(log);
    const pool = new pg.Pool({ connectionString: database().adminUrl, max: 1 });
    try {
      const lost = new Error("Connection terminated unexpectedly");
      expect(() => pool.emit("error", lost)).toThrow("Connection terminated unexpectedly");
      expect(log).not.toHaveBeenCalled();
    } finally {
      uninstall();
      await pool.end();
    }
  });

  it("leaves a pool's own 'error' listener in charge", async () => {
    const log = vi.fn();
    const uninstall = attachPoolErrorLogger(log);
    const pool = new pg.Pool({ connectionString: database().adminUrl, max: 1 });
    const own = vi.fn();
    pool.on("error", own);
    try {
      const removed = new Promise((resolve) => pool.once("remove", resolve));
      await terminate(await backendPid(pool));
      await removed;
      expect(own).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
    } finally {
      uninstall();
      await pool.end();
    }
  });

  it("drop() lets a closing client finish instead of terminating it", async () => {
    const scratch = await createTestDatabase(testServerUrl());
    const client = new pg.Client({ connectionString: scratch.adminUrl });
    const errors: unknown[] = [];
    client.on("error", (err) => errors.push(err));
    await client.connect();
    const dropped = scratch.drop();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await client.end();
    await dropped;
    expect(errors).toEqual([]);
  }, 60_000);
});
