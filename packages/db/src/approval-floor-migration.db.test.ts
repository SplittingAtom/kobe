import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest";

/**
 * The approval-floor unification (one install key, no team floor; spec D6) re-run against seeded
 * rows: the migration is plain idempotent SQL, so running it again after seeding shows what it
 * does to an install that had either key or a team floor.
 */
const dir = fileURLToPath(new URL("../drizzle/", import.meta.url));
const file = readdirSync(dir).find((f) => /^\d{4}_approval_floor_unify\.sql$/.test(f));
const migrationSql = readFileSync(`${dir}${file ?? "missing.sql"}`, "utf8").replaceAll(
  "--> statement-breakpoint",
  "",
);

const owner = new pg.Pool({ connectionString: inject("ownerUrl") });
afterAll(() => owner.end());

const KEYS = ["policy.approval_floor", "policy.approval_mode_floor"];

async function floors(): Promise<Record<string, string>> {
  const res = await owner.query<{ key: string; value: string }>(
    `SELECT key, value FROM install_settings WHERE key = ANY($1)`,
    [KEYS],
  );
  return Object.fromEntries(res.rows.map((r) => [r.key, r.value]));
}

async function seed(values: Partial<Record<(typeof KEYS)[number], string>>) {
  await owner.query(`DELETE FROM install_settings WHERE key = ANY($1)`, [KEYS]);
  for (const [key, value] of Object.entries(values)) {
    await owner.query(`INSERT INTO install_settings (key, value) VALUES ($1, $2)`, [key, value]);
  }
}

describe("approval floor unification migration", () => {
  beforeEach(() => owner.query(`DELETE FROM install_settings WHERE key = ANY($1)`, [KEYS]));

  it.each([
    [{ "policy.approval_mode_floor": "ask-on-write" }, "ask-on-write"],
    [{ "policy.approval_floor": "ask-all", "policy.approval_mode_floor": "auto" }, "ask-all"],
    [
      { "policy.approval_floor": "auto", "policy.approval_mode_floor": "ask-on-write" },
      "ask-on-write",
    ],
    // Unreadable values fail closed (the strictest mode), as both readers did.
    [{ "policy.approval_mode_floor": "yolo" }, "ask-all"],
  ] as const)("moves %o into one install key (stricter wins)", async (seeded, expected) => {
    await seed(seeded);
    await owner.query(migrationSql);
    expect(await floors()).toEqual({ "policy.approval_floor": expected });
  });

  it("leaves an install without a floor without one", async () => {
    await owner.query(migrationSql);
    expect(await floors()).toEqual({});
  });

  it("raises a notice for each dropped team floor stricter than auto", async () => {
    const ids = [randomUUID(), randomUUID()];
    for (const [i, value] of ["ask-on-write", "auto"].entries()) {
      const id = ids[i] as string;
      await owner.query(
        `INSERT INTO teams (id, slug, name, settings) VALUES ($1, $2, 'Floor', $3)`,
        [id, `notice-${id.slice(0, 8)}`, { approval_mode_floor: value }],
      );
    }
    const client = await owner.connect();
    const notices: string[] = [];
    client.on("notice", (n) => notices.push(n.message ?? ""));
    try {
      await client.query(migrationSql);
    } finally {
      client.release();
      await owner.query(`DELETE FROM teams WHERE id = ANY($1)`, [ids]);
    }
    const dropped = notices.filter((n) => n.includes("approval floor"));
    expect(dropped).toEqual([expect.stringContaining(`${ids[0]}`)]);
    expect(dropped[0]).toContain("ask-on-write");
  });

  it("removes team approval floors and keeps the other team settings", async () => {
    const id = randomUUID();
    await owner.query(`INSERT INTO teams (id, slug, name, settings) VALUES ($1, $2, 'Floor', $3)`, [
      id,
      `floor-${id.slice(0, 8)}`,
      { approval_mode_floor: "ask-all", sandbox_idle_minutes: 20 },
    ]);
    await owner.query(migrationSql);
    const res = await owner.query<{ settings: Record<string, unknown> }>(
      `SELECT settings FROM teams WHERE id = $1`,
      [id],
    );
    expect(res.rows[0]?.settings).toEqual({ sandbox_idle_minutes: 20 });
    await owner.query(`DELETE FROM teams WHERE id = $1`, [id]);
  });
});
