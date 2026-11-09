import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { LEGAL_HOLD_SQLSTATE } from "./legal-hold/index.js";

/**
 * KOBE-577 (Workspaces CM1, GV2, GV3, D18): project_commits, project_tree_entries,
 * project_checkouts, the head / parent / base / thread keys, team_storage_quotas.max_objects and
 * the legal-hold guard over history. Isolation is the probe suite's (probe.db.test).
 */
const admin = new pg.Client({ connectionString: inject("adminUrl") });
const appClient = new pg.Client({ connectionString: inject("appUrl") });
let owner = "";
let requester = "";
let approver = "";

async function user(isAdmin = false): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
    id,
    `${id}@pc.test`,
  ]);
  if (isAdmin)
    await admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [id]);
  return id;
}

async function team(): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T')`, [
    id,
    `pc-${id.slice(0, 8)}`,
  ]);
  return id;
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

const count = async (text: string, params: unknown[]) =>
  Number((await admin.query<{ n: string }>(text, params)).rows[0]?.n ?? 0);

async function project(teamId: string): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO projects (team_id, id, slug, name, created_by) VALUES ($1, $2, $3, 'P', $4)`,
    [teamId, id, `p-${id.slice(0, 8)}`, owner],
  );
  return id;
}

interface CommitOpts {
  seq?: number;
  parentId?: string | null;
  authorKind?: string;
  message?: string;
  fileCount?: number;
  bytes?: number;
  threadId?: string | null;
  runId?: string | null;
}

async function commit(teamId: string, projectId: string, o: CommitOpts = {}): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO project_commits (team_id, project_id, seq, parent_id, author_user_id, author_kind,
       thread_id, run_id, message, file_count, bytes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [
      teamId,
      projectId,
      o.seq ?? 1,
      o.parentId ?? null,
      owner,
      o.authorKind ?? "user",
      o.threadId ?? null,
      o.runId ?? null,
      o.message ?? "Imported",
      o.fileCount ?? 1,
      o.bytes ?? 5,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("no commit");
  return id;
}

interface EntryOpts {
  path?: string;
  sha?: string;
  size?: number;
}

const entry = (teamId: string, commitId: string, o: EntryOpts = {}) =>
  admin.query(
    `INSERT INTO project_tree_entries (team_id, commit_id, path, sha256, blob_ref, size_bytes, mime_type)
     VALUES ($1, $2, $3, $4, $5, $6, 'text/plain')`,
    [
      teamId,
      commitId,
      o.path ?? "a.txt",
      o.sha ?? "a".repeat(64),
      `teams/${teamId}/projects/x/blobs/${"a".repeat(64)}`,
      o.size ?? 5,
    ],
  );

const checkout = (teamId: string, projectId: string, userId: string, base: string | null) =>
  admin.query(
    `INSERT INTO project_checkouts (team_id, project_id, user_id, base_commit_id) VALUES ($1, $2, $3, $4)`,
    [teamId, projectId, userId, base],
  );

const setHead = (teamId: string, projectId: string, head: string | null) =>
  admin.query(`UPDATE projects SET head_commit_id = $3 WHERE team_id = $1 AND id = $2`, [
    teamId,
    projectId,
    head,
  ]);

async function activeHold(teamId: string, userId: string | null): Promise<void> {
  const { rows } = await appClient.query<{ id: string }>(
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3) RETURNING id`,
    [teamId, userId, requester],
  );
  await appClient.query(
    `UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
    [rows[0]?.id, approver],
  );
}

beforeAll(async () => {
  await admin.connect();
  await appClient.connect();
  owner = await user();
  requester = await user(true);
  approver = await user(true);
});
afterAll(async () => {
  await appClient.end();
  await admin.end();
});

describe("project_commits", () => {
  it("numbers commits per project: seq unique per project, from 1", async () => {
    const t = await team();
    const p = await project(t);
    const c1 = await commit(t, p);
    expect(await errorCode(commit(t, p))).toBe("23505");
    expect(await errorCode(commit(t, p, { seq: 2, parentId: c1 }))).toBeUndefined();
    expect(await errorCode(commit(t, await project(t)))).toBeUndefined();
    expect(await errorCode(commit(t, p, { seq: 0 }))).toBe("23514");
  });

  it("refuses bad author kinds, messages and counts", async () => {
    const t = await team();
    const p = await project(t);
    let seq = 1;
    const bad = async (o: CommitOpts) => errorCode(commit(t, p, { seq: seq++, ...o }));
    expect(await bad({ authorKind: "robot" })).toBe("23514");
    expect(await bad({ message: "" })).toBe("23514");
    expect(await bad({ message: "   " })).toBe("23514");
    expect(await bad({ message: "m".repeat(501) })).toBe("23514");
    expect(await bad({ fileCount: -1 })).toBe("23514");
    expect(await bad({ fileCount: 501 })).toBe("23514");
    expect(await bad({ bytes: -1 })).toBe("23514");
    expect(await bad({ message: "m".repeat(500), fileCount: 500, authorKind: "agent" })).toBe(
      undefined,
    );
  });

  it("refuses another team's project and a parent in another team", async () => {
    const t = await team();
    const t2 = await team();
    const p = await project(t);
    expect(await errorCode(commit(t2, p))).toBe("23503");
    const foreign = await commit(t2, await project(t2));
    expect(await errorCode(commit(t, p, { parentId: foreign }))).toBe("23503");
  });

  it("refuses deleting the head and lets the project delete take its whole history", async () => {
    const t = await team();
    const p = await project(t);
    const c1 = await commit(t, p);
    await entry(t, c1);
    await setHead(t, p, c1);
    expect(
      await errorCode(admin.query(`DELETE FROM project_commits WHERE team_id = $1`, [t])),
    ).toBe("23503");
    // Another team's commit as head: refused.
    const t2 = await team();
    const foreign = await commit(t2, await project(t2));
    expect(await errorCode(setHead(t, p, foreign))).toBe("23503");
    await admin.query(`DELETE FROM projects WHERE team_id = $1 AND id = $2`, [t, p]);
    expect(await count(`SELECT count(*) AS n FROM project_commits WHERE team_id = $1`, [t])).toBe(
      0,
    );
    expect(
      await count(`SELECT count(*) AS n FROM project_tree_entries WHERE team_id = $1`, [t]),
    ).toBe(0);
  });

  it("refuses a head, parent or checkout base naming another project's commit", async () => {
    const t = await team();
    const p = await project(t);
    const q = await project(t);
    const theirs = await commit(t, q);
    expect(await errorCode(setHead(t, p, theirs))).toBe("23503");
    expect(await errorCode(commit(t, p, { parentId: theirs }))).toBe("23503");
    expect(await errorCode(checkout(t, p, owner, theirs))).toBe("23503");
    const mine = await commit(t, p);
    expect(await errorCode(setHead(t, p, mine))).toBeUndefined();
    expect(await errorCode(commit(t, p, { seq: 2, parentId: mine }))).toBeUndefined();
    expect(await errorCode(checkout(t, p, owner, mine))).toBeUndefined();
  });

  it("clears the parent link when pruning removes the parent", async () => {
    const t = await team();
    const p = await project(t);
    const c1 = await commit(t, p);
    const c2 = await commit(t, p, { seq: 2, parentId: c1 });
    await setHead(t, p, c2);
    await admin.query(`DELETE FROM project_commits WHERE team_id = $1 AND id = $2`, [t, c1]);
    const { rows } = await admin.query(
      `SELECT seq, parent_id FROM project_commits WHERE team_id = $1`,
      [t],
    );
    expect(rows).toEqual([{ seq: 2, parent_id: null }]);
  });

  it("keeps an agent commit when its conversation is purged, clearing thread and run", async () => {
    const t = await team();
    const p = await project(t);
    const { rows: th } = await admin.query<{ id: string }>(
      `INSERT INTO threads (team_id, owner_user_id) VALUES ($1, $2) RETURNING id`,
      [t, owner],
    );
    const threadId = th[0]?.id ?? "";
    const { rows: rn } = await admin.query<{ id: string }>(
      `INSERT INTO runs (team_id, thread_id, trigger, status) VALUES ($1, $2, 'user', 'queued') RETURNING id`,
      [t, threadId],
    );
    const runId = rn[0]?.id ?? "";
    await commit(t, p, { authorKind: "agent", threadId, runId });
    expect(await errorCode(commit(await team(), p, { seq: 9, threadId }))).toBe("23503");
    await admin.query(`DELETE FROM threads WHERE team_id = $1`, [t]);
    const { rows } = await admin.query(
      `SELECT author_kind, thread_id, run_id FROM project_commits WHERE team_id = $1`,
      [t],
    );
    expect(rows).toEqual([{ author_kind: "agent", thread_id: null, run_id: null }]);
  });
});

describe("project_tree_entries", () => {
  it("holds one row per commit and path, with the project file rules", async () => {
    const t = await team();
    const c = await commit(t, await project(t));
    expect(await errorCode(entry(t, c, { path: "docs/a.txt" }))).toBeUndefined();
    expect(await errorCode(entry(t, c, { path: "docs/a.txt" }))).toBe("23505");
    for (const path of ["", "/abs", "a//b", "a/", "../x", "a/../b", "./x", "a\\b"]) {
      expect(await errorCode(entry(t, c, { path })), path).toBe("23514");
    }
    expect(await errorCode(entry(t, c, { path: "s1", size: -1 }))).toBe("23514");
    expect(await errorCode(entry(t, c, { path: "s2", size: 50 * 1024 * 1024 + 1 }))).toBe("23514");
    expect(await errorCode(entry(t, c, { path: "h", sha: "XYZ" }))).toBe("23514");
    expect(await errorCode(entry(await team(), c, { path: "o" }))).toBe("23503");
    const { rows } = await admin.query(
      `SELECT executable FROM project_tree_entries WHERE team_id = $1`,
      [t],
    );
    expect(rows).toEqual([{ executable: false }]);
  });
});

describe("project_checkouts", () => {
  it("holds one checkout per project and member, refuses a foreign base", async () => {
    const t = await team();
    const p = await project(t);
    const c = await commit(t, p);
    expect(await errorCode(checkout(t, p, owner, c))).toBeUndefined();
    expect(await errorCode(checkout(t, p, owner, c))).toBe("23505");
    const second = await user();
    expect(await errorCode(checkout(t, p, second, null))).toBeUndefined();
    const t2 = await team();
    const foreign = await commit(t2, await project(t2));
    expect(await errorCode(checkout(t, p, await user(), foreign))).toBe("23503");
    expect(await errorCode(checkout(t2, p, await user(), null))).toBe("23503");
  });

  it("refuses deleting a checkout's base, and goes with its project", async () => {
    const t = await team();
    const p = await project(t);
    const c1 = await commit(t, p);
    const c2 = await commit(t, p, { seq: 2, parentId: c1 });
    await setHead(t, p, c2);
    await checkout(t, p, owner, c1);
    expect(
      await errorCode(
        admin.query(`DELETE FROM project_commits WHERE team_id = $1 AND id = $2`, [t, c1]),
      ),
    ).toBe("23503");
    await admin.query(`DELETE FROM projects WHERE team_id = $1 AND id = $2`, [t, p]);
    expect(await count(`SELECT count(*) AS n FROM project_checkouts WHERE team_id = $1`, [t])).toBe(
      0,
    );
  });
});

describe("team_storage_quotas.max_objects", () => {
  it("is nullable (site default) and never negative", async () => {
    const t = await team();
    await admin.query(
      `INSERT INTO team_storage_quotas (team_id, max_bytes, updated_by) VALUES ($1, NULL, $2)`,
      [t, owner],
    );
    const set = (n: number | null) =>
      admin.query(`UPDATE team_storage_quotas SET max_objects = $2 WHERE team_id = $1`, [t, n]);
    expect(await errorCode(set(-1))).toBe("23514");
    expect(await errorCode(set(2_000_000))).toBeUndefined();
    expect(await errorCode(set(null))).toBeUndefined();
  });
});

describe("project history under a legal hold", () => {
  async function history(t: string) {
    const p = await project(t);
    const c1 = await commit(t, p);
    await entry(t, c1);
    const c2 = await commit(t, p, { seq: 2, parentId: c1 });
    await entry(t, c2);
    await setHead(t, p, c2);
    return { p, c1, c2 };
  }

  it("refuses pruning commits and tree entries, and truncating either, under any hold", async () => {
    const t = await team();
    const { c1 } = await history(t);
    await activeHold(t, owner);
    const pruneCommit = admin.query(`DELETE FROM project_commits WHERE team_id = $1 AND id = $2`, [
      t,
      c1,
    ]);
    expect(await errorCode(pruneCommit)).toBe(LEGAL_HOLD_SQLSTATE);
    expect(
      await errorCode(
        admin.query(`DELETE FROM project_tree_entries WHERE team_id = $1 AND commit_id = $2`, [
          t,
          c1,
        ]),
      ),
    ).toBe(LEGAL_HOLD_SQLSTATE);
    expect(await errorCode(admin.query(`TRUNCATE project_tree_entries`))).toBe(LEGAL_HOLD_SQLSTATE);
    expect(await errorCode(admin.query(`TRUNCATE project_commits CASCADE`))).toBe(
      LEGAL_HOLD_SQLSTATE,
    );
    expect(await count(`SELECT count(*) AS n FROM project_commits WHERE team_id = $1`, [t])).toBe(
      2,
    );
  });

  it("refuses the cascade of a project delete under a team-wide hold", async () => {
    const t = await team();
    const { p } = await history(t);
    await activeHold(t, null);
    expect(
      await errorCode(admin.query(`DELETE FROM projects WHERE team_id = $1 AND id = $2`, [t, p])),
    ).toBe(LEGAL_HOLD_SQLSTATE);
  });

  it("lets an unheld team prune while another team is held", async () => {
    const held = await team();
    await history(held);
    await activeHold(held, null);
    const t = await team();
    const { c1 } = await history(t);
    expect(
      await errorCode(
        admin.query(`DELETE FROM project_commits WHERE team_id = $1 AND id = $2`, [t, c1]),
      ),
    ).toBeUndefined();
  });
});
