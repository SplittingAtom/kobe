import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import pg from "pg";

/**
 * Test database lanes (KOBE-482). Several worktrees ("lanes") run DB suites against one dev
 * Postgres server at once. Each lane connects to its own maintenance database `kobe_lane_<lane>`
 * (instead of the server URL's own database) and names every throwaway database and role it
 * creates `kobe_<kind>_<hex>_<lane>`, so a lane's leftovers can be listed and dropped without
 * touching another lane's. Without a lane (CI) nothing changes.
 */

export const LANE_ENV = "KOBE_TEST_DB_LANE";
const LANE_PATTERN = /^[a-z0-9]{1,20}$/;
const MAX_LANE_LENGTH = 20;
const REPO_PREFIX = "kobe";
const WORKSPACE_MARKER = "pnpm-workspace.yaml";

/** Lane from a worktree directory name: `Kobe-wt482` → `wt482`, `Kobe` → `kobe`. */
export function laneFromDirectory(name: string): string {
  const alnum = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const trimmed =
    alnum.startsWith(REPO_PREFIX) && alnum.length > REPO_PREFIX.length
      ? alnum.slice(REPO_PREFIX.length)
      : alnum;
  if (!trimmed) {
    throw new Error(`cannot derive a test database lane from directory "${name}"; set ${LANE_ENV}`);
  }
  return trimmed.slice(0, MAX_LANE_LENGTH);
}

function workspaceRoot(from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, WORKSPACE_MARKER))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * The lane for this test run: KOBE_TEST_DB_LANE when set (empty means no lane), else none in CI,
 * else derived from the workspace root's directory name (one worktree, one lane).
 */
export function resolveTestLane(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string | undefined {
  const explicit = env[LANE_ENV];
  if (explicit !== undefined) {
    if (explicit === "") return undefined;
    const lane = explicit.toLowerCase();
    if (!LANE_PATTERN.test(lane)) {
      throw new Error(`${LANE_ENV} must be 1-${MAX_LANE_LENGTH} of [a-z0-9], got "${explicit}"`);
    }
    return lane;
  }
  if (env.CI) return undefined;
  const root = workspaceRoot(cwd);
  return root ? laneFromDirectory(basename(root)) : undefined;
}

export function laneDatabaseName(lane: string): string {
  return `kobe_lane_${lane}`;
}

/** The server URL with its database switched to the lane's maintenance database. */
export function laneServerUrl(serverUrl: string, lane: string | undefined): string {
  if (!lane) return serverUrl;
  const url = new URL(serverUrl);
  url.pathname = `/${laneDatabaseName(lane)}`;
  return url.toString();
}

/** Suffix for throwaway database and role names: `<hex>` or `<hex>_<lane>`. */
export function laneSuffix(random: string, lane: string | undefined): string {
  return lane ? `${random}_${lane}` : random;
}

/** True for the lane's maintenance database and for objects named with its `laneSuffix`. */
export function isLaneObjectName(name: string, lane: string): boolean {
  return (
    name === laneDatabaseName(lane) || new RegExp(`^kobe_[a-z_]+_[0-9a-f]{8}_${lane}$`).test(name)
  );
}

const DUPLICATE_DATABASE = "42P04";
const UNIQUE_VIOLATION = "23505"; // two concurrent CREATE DATABASE of the same name

/** Creates the lane's maintenance database unless it exists (safe when lanes race). */
export async function ensureLaneDatabase(serverUrl: string, lane: string): Promise<void> {
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    const name = laneDatabaseName(lane);
    const { rowCount } = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [name]);
    if (rowCount) return;
    await admin.query(`CREATE DATABASE ${name}`).catch((err: unknown) => {
      const code = (err as { code?: string }).code;
      if (code !== DUPLICATE_DATABASE && code !== UNIQUE_VIOLATION) throw err;
    });
  } finally {
    await admin.end();
  }
}

export interface LaneObjects {
  readonly databases: readonly string[];
  readonly roles: readonly string[];
}

/** Every lane on the server (from its `kobe_lane_*` database) with its object counts. */
export async function listTestLanes(
  serverUrl: string,
): Promise<readonly { lane: string; databases: number; roles: number }[]> {
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE 'kobe\\_lane\\_%' ORDER BY datname`,
    );
    const lanes = rows.map((r) => r.datname.slice("kobe_lane_".length));
    return await Promise.all(
      lanes.map(async (lane) => {
        const objects = await laneObjects(admin, lane);
        return { lane, databases: objects.databases.length, roles: objects.roles.length };
      }),
    );
  } finally {
    await admin.end();
  }
}

async function laneObjects(admin: pg.Client, lane: string): Promise<LaneObjects> {
  const dbs = await admin.query<{ name: string }>(
    `SELECT datname AS name FROM pg_database WHERE datname LIKE 'kobe\\_%'`,
  );
  const roles = await admin.query<{ name: string }>(
    `SELECT rolname AS name FROM pg_roles WHERE rolname LIKE 'kobe\\_%'`,
  );
  return {
    databases: dbs.rows.map((r) => r.name).filter((n) => isLaneObjectName(n, lane)),
    roles: roles.rows.map((r) => r.name).filter((n) => isLaneObjectName(n, lane)),
  };
}

/**
 * Drops a lane: its throwaway databases, its maintenance database and its roles. Only for a lane
 * that is not running tests. `serverUrl` must not point at the lane's own database.
 */
export async function dropTestLane(serverUrl: string, lane: string): Promise<LaneObjects> {
  if (!LANE_PATTERN.test(lane)) throw new Error(`invalid lane "${lane}"`);
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  try {
    const objects = await laneObjects(admin, lane);
    for (const db of objects.databases) {
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    }
    for (const role of objects.roles) await admin.query(`DROP ROLE IF EXISTS ${role}`);
    return objects;
  } finally {
    await admin.end();
  }
}

/**
 * Vitest global setup step for every DB suite: creates the lane's maintenance database when this
 * run has a lane. Returns the lane (undefined in CI).
 */
export async function prepareTestLane(): Promise<string | undefined> {
  const base = process.env.KOBE_TEST_DATABASE_URL;
  const lane = resolveTestLane();
  if (base && lane) await ensureLaneDatabase(base, lane);
  return lane;
}
