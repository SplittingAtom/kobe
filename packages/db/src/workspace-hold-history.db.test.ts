import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb } from "./client.js";
import { LEGAL_HOLD_SQLSTATE } from "./legal-hold/index.js";
import { withTeam } from "./with-team.js";

/**
 * KOBE-304: workspace_file_hold_history's constraints, immutability and legal-hold guard (team
 * isolation: probe.db.test; the policy text: catalog.db.test). The server's move writes the rows.
 */
const app = createDb(inject("appUrl"), { max: 4 });
const appClient = new pg.Client({ connectionString: inject("appUrl") });
const admin = new pg.Client({ connectionString: inject("adminUrl") });
const owner = new pg.Client({ connectionString: inject("ownerUrl") });
let requester = "";
let approver = "";
const SHA = "c".repeat(64);

async function user(name: string, role?: "admin"): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
    id,
    name,
    `${id}@hold-history.test`,
  ]);
  if (role) await admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, $2)`, [id, role]);
  return id;
}

async function team(): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T')`, [
    id,
    `wh-${id.slice(0, 8)}`,
  ]);
  return id;
}

async function keep(teamId: string, userId: string, values: { path?: string; sha?: string } = {}) {
  await withTeam(app.db, teamId, (tx) =>
    tx.execute(sql`
      INSERT INTO workspace_file_hold_history
        (team_id, user_id, path, moved_to, sha256, blob_key, size, mtime_ms, file_rev)
      VALUES (${teamId}, ${userId}, ${values.path ?? "a/b.txt"}, 'c/b.txt', ${values.sha ?? SHA},
              ${`teams/${teamId}/users/${userId}/workspace/${SHA}`}, 3, 0, 1)`),
  );
}

async function hold(teamId: string, userId: string | null): Promise<string> {
  const { rows } = await appClient.query<{ id: string }>(
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3) RETURNING id`,
    [teamId, userId, requester],
  );
  const id = rows[0]?.id ?? "";
  await appClient.query(
    `UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
    [id, approver],
  );
  return id;
}

async function release(id: string): Promise<void> {
  await admin.query(
    `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(), release_reason = 'done' WHERE id = $1`,
    [id, requester],
  );
  await appClient.query(
    `UPDATE legal_holds SET status = 'released', released_by = $2 WHERE id = $1`,
    [id, approver],
  );
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    const e = err as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
  return undefined;
}

const exec = (teamId: string, text: string) =>
  withTeam(app.db, teamId, (tx) => tx.execute(sql.raw(text)));
const count = async (teamId: string) =>
  Number(
    (
      await admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM workspace_file_hold_history WHERE team_id = $1`,
        [teamId],
      )
    ).rows[0]?.n ?? 0,
  );

beforeAll(async () => {
  await appClient.connect();
  await admin.connect();
  await owner.connect();
  requester = await user("Requester", "admin");
  approver = await user("Approver", "admin");
});

afterAll(async () => {
  await appClient.end();
  await admin.end();
  await owner.end();
  await app.close();
});

describe("workspace_file_hold_history (KOBE-304)", () => {
  it("checks its paths and content", async () => {
    const t = await team();
    const ann = await user("Ann");
    await keep(t, ann);
    expect(await errorCode(keep(t, ann, { path: "" }))).toBe("23514");
    expect(await errorCode(keep(t, ann, { path: "x".repeat(1025) }))).toBe("23514");
    expect(await errorCode(keep(t, ann, { sha: "nope" }))).toBe("23514");
    expect(await count(t)).toBe(1);
  });

  it("is immutable, and kept while a hold covers the member; released, it may go", async () => {
    const t = await team();
    const ann = await user("Ann");
    const bob = await user("Bob");
    await keep(t, ann);
    await keep(t, bob);
    const h = await hold(t, ann);
    expect(
      await errorCode(
        exec(t, `UPDATE workspace_file_hold_history SET path = 'x' WHERE team_id = '${t}'`),
      ),
    ).toBe("55000");
    expect(
      await errorCode(
        exec(
          t,
          `DELETE FROM workspace_file_hold_history WHERE team_id = '${t}' AND user_id = '${ann}'`,
        ),
      ),
    ).toBe(LEGAL_HOLD_SQLSTATE);
    expect(await errorCode(owner.query(`TRUNCATE workspace_file_hold_history`))).toBe(
      LEGAL_HOLD_SQLSTATE,
    );
    // Another member's rows are not held.
    expect(
      await errorCode(
        exec(
          t,
          `DELETE FROM workspace_file_hold_history WHERE team_id = '${t}' AND user_id = '${bob}'`,
        ),
      ),
    ).toBeUndefined();
    await release(h);
    expect(
      await errorCode(exec(t, `DELETE FROM workspace_file_hold_history WHERE team_id = '${t}'`)),
    ).toBeUndefined();
    expect(await count(t)).toBe(0);
  });

  it("a team-wide hold covers every member's rows", async () => {
    const t = await team();
    const ann = await user("Ann");
    await keep(t, ann);
    const h = await hold(t, null);
    expect(
      await errorCode(exec(t, `DELETE FROM workspace_file_hold_history WHERE team_id = '${t}'`)),
    ).toBe(LEGAL_HOLD_SQLSTATE);
    await release(h);
  });
});
