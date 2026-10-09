import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { BREAK_GLASS_ACTOR_SETTING, BREAK_GLASS_GRANT_SETTING } from "./settings.js";
import { LEGAL_HOLD_SQLSTATE } from "./legal-hold/index.js";

/** KOBE-154: memory_docs, memory_doc_versions and team_memory_settings (probe suite: probe.db.test). */
const admin = new pg.Client({ connectionString: inject("adminUrl") });
const appClient = new pg.Client({ connectionString: inject("appUrl") });
let owner = "";
let other = "";
let requester = "";
let approver = "";

async function user(isAdmin = false): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
    id,
    `${id}@m.test`,
  ]);
  if (isAdmin)
    await admin.query(`INSERT INTO install_roles (user_id, role) VALUES ($1, 'admin')`, [id]);
  return id;
}

async function team(): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T')`, [
    id,
    `mem-${id.slice(0, 8)}`,
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

interface DocOpts {
  scope?: string;
  owner?: string | null;
  project?: string | null;
  path?: string;
}

/** A project of `teamId` (project docs reference one since KOBE-160). */
async function project(teamId: string): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO projects (team_id, id, slug, name, created_by) VALUES ($1, $2, $3, 'P', $4)`,
    [teamId, id, `p-${id.slice(0, 8)}`, owner],
  );
  return id;
}

/** A personal doc of `owner` by default. */
async function doc(teamId: string, o: DocOpts = {}): Promise<string> {
  const scope = o.scope ?? "user";
  const projectId =
    o.project === undefined && scope === "project" ? await project(teamId) : o.project;
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO memory_docs (team_id, scope, owner_user_id, project_id, path)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      teamId,
      scope,
      o.owner === undefined ? (scope === "user" ? owner : null) : o.owner,
      projectId ?? null,
      o.path ?? "MEMORY.md",
    ],
  );
  return rows[0]?.id ?? "";
}

interface VersionOpts {
  version?: number;
  size?: number;
  sha?: string;
  actor?: string;
}

const version = (teamId: string, docId: string, o: VersionOpts = {}) =>
  admin.query(
    `INSERT INTO memory_doc_versions (team_id, doc_id, version, blob_ref, size_bytes, sha256, actor_kind, actor_user_id)
     VALUES ($1, $2, $3, 'k', $4, $5, $6, $7)`,
    [
      teamId,
      docId,
      o.version ?? 1,
      o.size ?? 10,
      o.sha ?? "a".repeat(64),
      o.actor ?? "user",
      owner,
    ],
  );

beforeAll(async () => {
  await admin.connect();
  await appClient.connect();
  owner = await user();
  other = await user();
  requester = await user(true);
  approver = await user(true);
});
afterAll(async () => {
  await appClient.end();
  await admin.end();
});

describe("memory_docs", () => {
  it("accept a personal doc and a project doc", async () => {
    const t = await team();
    expect(await errorCode(doc(t))).toBeUndefined();
    expect(await errorCode(doc(t, { scope: "project" }))).toBeUndefined();
  });

  it("tie the owner and project columns to the scope", async () => {
    const t = await team();
    expect(await errorCode(doc(t, { scope: "other" }))).toBe("23514");
    expect(await errorCode(doc(t, { owner: null }))).toBe("23514");
    expect(await errorCode(doc(t, { project: await project(t) }))).toBe("23514");
    expect(await errorCode(doc(t, { scope: "project", owner, project: await project(t) }))).toBe(
      "23514",
    );
    expect(await errorCode(doc(t, { scope: "project", project: null }))).toBe("23514");
  });

  it("refuse paths the memory contract refuses", async () => {
    const t = await team();
    for (const path of [
      "notes.txt",
      "/abs.md",
      "a/../b.md",
      "../b.md",
      "a/b/c/d/e.md",
      ".hidden.md",
      "sp ace.md",
      `${"a".repeat(198)}.md`,
    ]) {
      expect(await errorCode(doc(t, { path })), path).toBe("23514");
    }
    for (const path of ["MEMORY.md", "people/ann.md", "a/b/c/d.md", "v1.2-notes_x.md"]) {
      expect(await errorCode(doc(t, { path })), path).toBeUndefined();
    }
  });

  it("keep one doc per owner and path, and per project and path", async () => {
    const t = await team();
    expect(await errorCode(doc(t, { path: "x.md" }))).toBeUndefined();
    expect(await errorCode(doc(t, { path: "x.md" }))).toBe("23505");
    expect(await errorCode(doc(t, { path: "x.md", owner: other }))).toBeUndefined();
    const p = await project(t);
    expect(await errorCode(doc(t, { scope: "project", project: p, path: "x.md" }))).toBeUndefined();
    expect(await errorCode(doc(t, { scope: "project", project: p, path: "x.md" }))).toBe("23505");
    expect(
      await errorCode(doc(t, { scope: "project", project: await project(t), path: "x.md" })),
    ).toBeUndefined();
    // The same personal path in another team is another doc (memory is per user and team).
    expect(await errorCode(doc(await team(), { path: "x.md" }))).toBeUndefined();
  });

  it("refuse a version below 1", async () => {
    const t = await team();
    const id = await doc(t);
    expect(
      await errorCode(
        admin.query(`UPDATE memory_docs SET current_version = 0 WHERE team_id = $1 AND id = $2`, [
          t,
          id,
        ]),
      ),
    ).toBe("23514");
  });
});

describe("memory_doc_versions", () => {
  it("accept versions of a doc, with a run id that names no row", async () => {
    const t = await team();
    const id = await doc(t);
    expect(await errorCode(version(t, id))).toBeUndefined();
    expect(await errorCode(version(t, id, { version: 2, actor: "agent" }))).toBeUndefined();
    expect(await errorCode(version(t, id))).toBe("23505");
    expect(
      await errorCode(
        admin.query(
          `UPDATE memory_doc_versions SET run_id = $3 WHERE team_id = $1 AND doc_id = $2`,
          [t, id, randomUUID()],
        ),
      ),
    ).toBe("55000");
  });

  it("refuse an oversized file, a bad hash, a bad actor and version 0", async () => {
    const t = await team();
    const id = await doc(t);
    expect(await errorCode(version(t, id, { size: 65537 }))).toBe("23514");
    expect(await errorCode(version(t, id, { size: -1 }))).toBe("23514");
    expect(await errorCode(version(t, id, { sha: "xyz" }))).toBe("23514");
    expect(await errorCode(version(t, id, { actor: "robot" }))).toBe("23514");
    expect(await errorCode(version(t, id, { version: 0 }))).toBe("23514");
    expect(await errorCode(version(t, id, { size: 65536 }))).toBeUndefined();
  });

  it("refuse a doc of another team", async () => {
    const t = await team();
    const id = await doc(await team());
    expect(await errorCode(version(t, id))).toBe("23503");
  });

  it("are immutable but go with their doc", async () => {
    const t = await team();
    const id = await doc(t);
    await version(t, id);
    expect(
      await errorCode(
        admin.query(`UPDATE memory_doc_versions SET blob_ref = 'z' WHERE team_id = $1`, [t]),
      ),
    ).toBe("55000");
    await admin.query(`DELETE FROM memory_docs WHERE team_id = $1`, [t]);
    expect(
      await count(`SELECT count(*) AS n FROM memory_doc_versions WHERE team_id = $1`, [t]),
    ).toBe(0);
  });
});

describe("team_memory_settings", () => {
  it("default both switches to on, one row per team", async () => {
    const t = await team();
    await admin.query(`INSERT INTO team_memory_settings (team_id, updated_by) VALUES ($1, $2)`, [
      t,
      owner,
    ]);
    const { rows } = await admin.query(
      `SELECT memory_enabled, project_memory_enabled FROM team_memory_settings WHERE team_id = $1`,
      [t],
    );
    expect(rows).toEqual([{ memory_enabled: true, project_memory_enabled: true }]);
    expect(
      await errorCode(
        admin.query(`INSERT INTO team_memory_settings (team_id, updated_by) VALUES ($1, $2)`, [
          t,
          owner,
        ]),
      ),
    ).toBe("23505");
  });
});

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

describe("memory under a legal hold", () => {
  it("refuses deleting a held user's docs and versions, and truncation", async () => {
    const t = await team();
    const id = await doc(t);
    await version(t, id);
    await activeHold(t, owner);
    expect(await errorCode(admin.query(`DELETE FROM memory_docs WHERE team_id = $1`, [t]))).toBe(
      LEGAL_HOLD_SQLSTATE,
    );
    expect(
      await errorCode(admin.query(`DELETE FROM memory_doc_versions WHERE team_id = $1`, [t])),
    ).toBe(LEGAL_HOLD_SQLSTATE);
    expect(await errorCode(admin.query(`TRUNCATE memory_docs CASCADE`))).toBe(LEGAL_HOLD_SQLSTATE);
    expect(await errorCode(admin.query(`TRUNCATE memory_doc_versions`))).toBe(LEGAL_HOLD_SQLSTATE);
    expect(await count(`SELECT count(*) AS n FROM memory_docs WHERE team_id = $1`, [t])).toBe(1);
  });

  it("lets another user's docs go, but protects project docs under any hold in the team", async () => {
    const t = await team();
    await doc(t, { owner: other });
    await doc(t, { scope: "project" });
    await activeHold(t, owner);
    expect(
      await errorCode(
        admin.query(`DELETE FROM memory_docs WHERE team_id = $1 AND scope = 'user'`, [t]),
      ),
    ).toBeUndefined();
    expect(
      await errorCode(
        admin.query(`DELETE FROM memory_docs WHERE team_id = $1 AND scope = 'project'`, [t]),
      ),
    ).toBe(LEGAL_HOLD_SQLSTATE);
  });

  it("allows soft delete (deleted_at) under a hold: nothing is removed", async () => {
    const t = await team();
    await doc(t);
    await activeHold(t, null);
    expect(
      await errorCode(
        admin.query(`UPDATE memory_docs SET deleted_at = now() WHERE team_id = $1`, [t]),
      ),
    ).toBeUndefined();
  });
});

describe("memory break-glass read (spec D10, D24)", () => {
  async function grant(teamId: string, o: { userId?: string; threadId?: string } = {}) {
    const { rows } = await appClient.query<{ id: string }>(
      `INSERT INTO break_glass_grants (team_id, admin_id, user_id, thread_id, reason)
       VALUES ($1, $2, $3, $4, 'probe') RETURNING id`,
      [teamId, requester, o.userId ?? null, o.threadId ?? null],
    );
    const id = rows[0]?.id ?? "";
    await appClient.query(
      `UPDATE break_glass_grants SET status = 'approved', approver_id = $2 WHERE id = $1`,
      [id, approver],
    );
    return id;
  }

  async function visible(grantId: string | null, table: string): Promise<string[]> {
    await appClient.query("BEGIN");
    try {
      if (grantId)
        await appClient.query(
          `SELECT set_config('${BREAK_GLASS_GRANT_SETTING}', $1, true), set_config('${BREAK_GLASS_ACTOR_SETTING}', $2, true)`,
          [grantId, requester],
        );
      const { rows } = await appClient.query<{ path: string }>(
        table === "memory_docs"
          ? `SELECT path FROM memory_docs`
          : `SELECT d.path FROM memory_doc_versions v JOIN memory_docs d ON d.team_id = v.team_id AND d.id = v.doc_id`,
      );
      return rows.map((r) => r.path).sort();
    } finally {
      await appClient.query("ROLLBACK");
    }
  }

  it("shows a team grant all of the team's memory, a user grant that user's personal memory, a thread grant none", async () => {
    const t = await team();
    const o = await team();
    for (const [teamId, path, who] of [
      [t, "mine.md", owner],
      [t, "theirs.md", other],
      [o, "foreign.md", owner],
    ] as const) {
      await version(teamId, await doc(teamId, { path, owner: who }));
    }
    await version(t, await doc(t, { scope: "project", path: "proj.md" }));
    for (const table of ["memory_docs", "memory_doc_versions"]) {
      expect(await visible(await grant(t), table), table).toEqual([
        "mine.md",
        "proj.md",
        "theirs.md",
      ]);
      expect(await visible(await grant(t, { userId: owner }), table), table).toEqual(["mine.md"]);
      expect(await visible(null, table), table).toEqual([]);
    }
    const th = randomUUID();
    await admin.query(
      `INSERT INTO threads (team_id, id, owner_user_id, title) VALUES ($1, $2, $3, 't')`,
      [t, th, owner],
    );
    expect(await visible(await grant(t, { threadId: th }), "memory_docs")).toEqual([]);
  });

  it("does not expose the team switches", async () => {
    const t = await team();
    await admin.query(`INSERT INTO team_memory_settings (team_id, updated_by) VALUES ($1, $2)`, [
      t,
      owner,
    ]);
    await appClient.query("BEGIN");
    try {
      await appClient.query(
        `SELECT set_config('${BREAK_GLASS_GRANT_SETTING}', $1, true), set_config('${BREAK_GLASS_ACTOR_SETTING}', $2, true)`,
        [await grant(t), requester],
      );
      const { rows } = await appClient.query(`SELECT 1 FROM team_memory_settings`);
      expect(rows).toEqual([]);
    } finally {
      await appClient.query("ROLLBACK");
    }
  });
});
