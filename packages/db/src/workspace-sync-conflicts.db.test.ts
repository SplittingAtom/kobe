import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb } from "./client.js";
import { withTeam } from "./with-team.js";

/**
 * KOBE-492: workspace_sync_conflicts' constraints and keys (team isolation: probe.db.test). The
 * server writes the rows when the sandbox reports a conflict.
 */
const app = createDb(inject("appUrl"), { max: 4 });
const admin = new pg.Client({ connectionString: inject("adminUrl") });
const SHA = "d".repeat(64);
let teamId = "";
let userId = "";

beforeAll(async () => {
  await admin.connect();
  teamId = randomUUID();
  userId = randomUUID();
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T')`, [
    teamId,
    `sc-${teamId.slice(0, 8)}`,
  ]);
  await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, 'M', $2)`, [
    userId,
    `${userId}@sync-conflicts.test`,
  ]);
});

afterAll(async () => {
  await admin.end();
  await app.close();
});

async function threadAndRun(): Promise<{ threadId: string; runId: string }> {
  return withTeam(app.db, teamId, async (tx) => {
    const t = await tx.execute<{ id: string }>(sql`
      INSERT INTO threads (team_id, owner_user_id) VALUES (${teamId}, ${userId}) RETURNING id`);
    const threadId = t.rows[0]?.id ?? "";
    const r = await tx.execute<{ id: string }>(sql`
      INSERT INTO runs (team_id, thread_id, trigger, status, started_at)
      VALUES (${teamId}, ${threadId}, 'user', 'running', now()) RETURNING id`);
    return { threadId, runId: r.rows[0]?.id ?? "" };
  });
}

async function insert(values: {
  threadId?: string | null;
  runId?: string | null;
  path?: string;
  sha?: string;
}): Promise<string> {
  return withTeam(app.db, teamId, async (tx) => {
    const r = await tx.execute<{ id: string }>(sql`
      INSERT INTO workspace_sync_conflicts
        (team_id, user_id, thread_id, run_id, path, conflict_path, member_sha256, agent_sha256)
      VALUES (${teamId}, ${userId}, ${values.threadId ?? null}, ${values.runId ?? null},
              ${values.path ?? "notes.md"}, 'notes.conflict-20261023-120000.md',
              ${values.sha ?? SHA}, ${SHA})
      RETURNING id`);
    return r.rows[0]?.id ?? "";
  });
}

const count = async (id: string) =>
  (
    await admin.query<{ run_id: string | null }>(
      `SELECT run_id FROM workspace_sync_conflicts WHERE team_id = $1 AND id = $2`,
      [teamId, id],
    )
  ).rows;

describe("workspace_sync_conflicts", () => {
  it("takes a conflict with or without a thread", async () => {
    const { threadId, runId } = await threadAndRun();
    expect(await insert({ threadId, runId })).not.toBe("");
    expect(await insert({ threadId: null })).not.toBe("");
  });

  it("refuses bad hashes, empty or oversize paths, and a run without a thread", async () => {
    const { runId } = await threadAndRun();
    await expect(insert({ sha: "XYZ" })).rejects.toThrow();
    await expect(insert({ path: "" })).rejects.toThrow();
    await expect(insert({ path: "a".repeat(1025) })).rejects.toThrow();
    await expect(insert({ threadId: null, runId })).rejects.toThrow();
  });

  it("clears only run_id when the run goes, and follows its thread", async () => {
    const { threadId, runId } = await threadAndRun();
    const id = await insert({ threadId, runId });
    await admin.query(`DELETE FROM run_events WHERE team_id = $1 AND run_id = $2`, [teamId, runId]);
    await admin.query(`DELETE FROM runs WHERE team_id = $1 AND id = $2`, [teamId, runId]);
    expect(await count(id)).toEqual([{ run_id: null }]);
    await admin.query(`DELETE FROM threads WHERE team_id = $1 AND id = $2`, [teamId, threadId]);
    expect(await count(id)).toEqual([]);
  });
});
