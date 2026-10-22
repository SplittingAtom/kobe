import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { dropTestLane, ensureLaneDatabase, laneDatabaseName, listTestLanes } from "./lane.js";

const base = process.env.KOBE_TEST_DATABASE_URL ?? "";
const lane = `t${randomBytes(4).toString("hex")}`;
const other = `${lane}x`;

async function sql(query: string): Promise<pg.QueryResult> {
  const c = new pg.Client({ connectionString: base });
  await c.connect();
  try {
    return await c.query(query);
  } finally {
    await c.end();
  }
}

describe("test database lanes (KOBE-482)", () => {
  afterAll(async () => {
    await dropTestLane(base, lane);
    await dropTestLane(base, other);
  });

  it("creates the lane database once, even when two setups race", async () => {
    await Promise.all([ensureLaneDatabase(base, lane), ensureLaneDatabase(base, lane)]);
    await ensureLaneDatabase(base, lane);
    const { rowCount } = await sql(
      `SELECT 1 FROM pg_database WHERE datname = '${laneDatabaseName(lane)}'`,
    );
    expect(rowCount).toBe(1);
  });

  it("lists and drops only the lane's own databases and roles", async () => {
    await ensureLaneDatabase(base, other);
    const hex = randomBytes(4).toString("hex");
    await sql(`CREATE ROLE kobe_owner_${hex}_${lane} NOLOGIN`);
    await sql(`CREATE DATABASE kobe_test_${hex}_${lane} OWNER kobe_owner_${hex}_${lane}`);
    await sql(`CREATE ROLE kobe_owner_${hex}_${other} NOLOGIN`);

    const lanes = await listTestLanes(base);
    expect(lanes).toContainEqual({ lane, databases: 2, roles: 1 });
    expect(lanes).toContainEqual({ lane: other, databases: 1, roles: 1 });

    const dropped = await dropTestLane(base, lane);
    expect([...dropped.databases].sort()).toEqual(
      [laneDatabaseName(lane), `kobe_test_${hex}_${lane}`].sort(),
    );
    expect(dropped.roles).toEqual([`kobe_owner_${hex}_${lane}`]);
    const after = await listTestLanes(base);
    expect(after.some((l) => l.lane === lane)).toBe(false);
    expect(after).toContainEqual({ lane: other, databases: 1, roles: 1 });
  });
});
