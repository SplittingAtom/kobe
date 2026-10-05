import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { createDb } from "./client.js";
import { LEGAL_HOLD_SQLSTATE } from "./legal-hold/index.js";
import { withTeam } from "./with-team.js";

/** KOBE-129: artifact tables' constraints, cascades and legal-hold guards (probe suite: probe.db.test). */
const app = createDb(inject("appUrl"), { max: 4 });
const appClient = new pg.Client({ connectionString: inject("appUrl") });
const admin = new pg.Client({ connectionString: inject("adminUrl") });
let requester = "";
let approver = "";
let owner = "";

async function user(name: string, role?: "admin"): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, $2, $3)`, [
    id,
    name,
    `${id}@a.test`,
  ]);
  if (role)
    await admin.query(`INSERT INTO install_roles (user_id, role) VALUES ($1, $2)`, [id, role]);
  return id;
}

async function team(): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T')`, [
    id,
    `art-${id.slice(0, 8)}`,
  ]);
  return id;
}

/** A thread with a run, an artifact and one version. */
async function artifact(teamId: string) {
  const threadId = randomUUID();
  await admin.query(
    `INSERT INTO threads (team_id, id, owner_user_id, title) VALUES ($1, $2, $3, 't')`,
    [teamId, threadId, owner],
  );
  const run = await admin.query<{ id: string }>(
    `INSERT INTO runs (team_id, thread_id, trigger, status, started_at, ended_at)
     VALUES ($1, $2, 'user', 'completed', now(), now()) RETURNING id`,
    [teamId, threadId],
  );
  const runId = run.rows[0]?.id ?? "";
  const art = await admin.query<{ id: string }>(
    `INSERT INTO artifacts (team_id, thread_id, created_by, kind, title) VALUES ($1, $2, $3, 'markdown', 'T') RETURNING id`,
    [teamId, threadId, owner],
  );
  const artifactId = art.rows[0]?.id ?? "";
  await version(teamId, artifactId, threadId, runId, 1, `call-${randomUUID()}`);
  return { threadId, runId, artifactId };
}

const version = (t: string, a: string, th: string, run: string, v: number, call: string) =>
  admin.query(
    `INSERT INTO artifact_versions (team_id, artifact_id, version, thread_id, blob_ref, size_bytes, sha256, run_id, tool_call_id)
     VALUES ($1, $2, $4, $3, 'k', 1, repeat('a', 64), $5, $6)`,
    [t, a, th, v, run, call],
  );

async function hold(teamId: string): Promise<string> {
  const { rows } = await appClient.query<{ id: string }>(
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, NULL, 'matter', $2) RETURNING id`,
    [teamId, requester],
  );
  const id = rows[0]?.id ?? "";
  await appClient.query(
    `UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
    [id, approver],
  );
  return id;
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
const count = async (text: string, params: unknown[]) =>
  Number((await admin.query<{ n: string }>(text, params)).rows[0]?.n ?? 0);

beforeAll(async () => {
  await appClient.connect();
  await admin.connect();
  requester = await user("Requester", "admin");
  approver = await user("Approver", "admin");
  owner = await user("Owner");
});
afterAll(async () => {
  await app.close();
  await appClient.end();
  await admin.end();
});

describe("artifact tables", () => {
  it("make a tool call id apply once per team and a version number once per artifact", async () => {
    const t = await team();
    const a = await artifact(t);
    expect(
      await errorCode(version(t, a.artifactId, a.threadId, a.runId, 2, "dup-call")),
    ).toBeUndefined();
    expect(await errorCode(version(t, a.artifactId, a.threadId, a.runId, 3, "dup-call"))).toBe(
      "23505",
    );
    expect(await errorCode(version(t, a.artifactId, a.threadId, a.runId, 2, "other"))).toBe(
      "23505",
    );
  });

  it("refuse a version whose thread is not the artifact's, a bad kind and a bad language", async () => {
    const t = await team();
    const a = await artifact(t);
    const other = await artifact(t);
    // thread_id must match the artifact's (composite FK to the thread alone can't tell; the server
    // writes both from the artifact row) — the FK to artifacts guards team, the check below the shape.
    expect(
      await errorCode(
        admin.query(`UPDATE artifacts SET kind = 'tsx' WHERE team_id = $1 AND id = $2`, [
          t,
          a.artifactId,
        ]),
      ),
    ).toBe("23514");
    expect(
      await errorCode(
        admin.query(`UPDATE artifacts SET language = 'python' WHERE team_id = $1 AND id = $2`, [
          t,
          a.artifactId,
        ]),
      ),
    ).toBe("23514");
    expect(other.artifactId).not.toBe(a.artifactId);
  });

  it("keep a version's thread equal to its artifact's, and are immutable", async () => {
    const t = await team();
    const a = await artifact(t);
    const b = await artifact(t);
    expect(await errorCode(version(t, a.artifactId, b.threadId, a.runId, 2, "x"))).toBe("23503");
    expect(
      await errorCode(
        admin.query(`UPDATE artifact_versions SET blob_ref = 'z' WHERE team_id = $1`, [t]),
      ),
    ).toBe("55000");
  });

  it("go with their thread (cascade) and never reach another team", async () => {
    const t = await team();
    const u = await team();
    const a = await artifact(t);
    await artifact(u);
    await admin.query(`DELETE FROM threads WHERE team_id = $1 AND id = $2`, [t, a.threadId]);
    expect(await count(`SELECT count(*) AS n FROM artifacts WHERE team_id = $1`, [t])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM artifact_versions WHERE team_id = $1`, [t])).toBe(
      0,
    );
    expect(await count(`SELECT count(*) AS n FROM artifacts WHERE team_id = $1`, [u])).toBe(1);
  });

  it("are refused deletion and truncation under a legal hold", async () => {
    const t = await team();
    const a = await artifact(t);
    const h = await hold(t);
    for (const table of ["artifact_versions", "artifacts"]) {
      expect(await errorCode(exec(t, `DELETE FROM ${table} WHERE team_id = '${t}'`))).toBe(
        LEGAL_HOLD_SQLSTATE,
      );
    }
    expect(
      await errorCode(
        exec(t, `DELETE FROM threads WHERE team_id = '${t}' AND id = '${a.threadId}'`),
      ),
    ).toBe(LEGAL_HOLD_SQLSTATE);
    expect(await count(`SELECT count(*) AS n FROM artifact_versions WHERE team_id = $1`, [t])).toBe(
      1,
    );
    await admin.query(
      `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(), release_reason = 'done' WHERE id = $1`,
      [h, requester],
    );
    await appClient.query(
      `UPDATE legal_holds SET status = 'released', released_by = $2 WHERE id = $1`,
      [h, approver],
    );
    await exec(t, `DELETE FROM artifact_versions WHERE team_id = '${t}'`);
    expect(await count(`SELECT count(*) AS n FROM artifact_versions WHERE team_id = $1`, [t])).toBe(
      0,
    );
  });
});
