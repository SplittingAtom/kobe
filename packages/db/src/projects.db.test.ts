import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { LEGAL_HOLD_SQLSTATE } from "./legal-hold/index.js";
import { BREAK_GLASS_ACTOR_SETTING, BREAK_GLASS_GRANT_SETTING } from "./settings.js";

/**
 * KOBE-160: projects, project_members, project_files and the project FKs; KOBE-577 (Workspaces):
 * visibility, roles owner|editor|reader, project_commits, project_tree_entries, project_checkouts,
 * the keys between them and the legal-hold guard over history (probe suite: probe.db.test).
 */
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
    `${id}@p.test`,
  ]);
  if (isAdmin)
    await admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [id]);
  return id;
}

async function team(): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T')`, [
    id,
    `prj-${id.slice(0, 8)}`,
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

interface ProjectOpts {
  id?: string;
  slug?: string;
  name?: string;
  instructions?: string;
  description?: string;
  visibility?: string;
}

async function project(teamId: string, o: ProjectOpts = {}): Promise<string> {
  const id = o.id ?? randomUUID();
  await admin.query(
    `INSERT INTO projects (team_id, id, slug, name, description, instructions, visibility, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      teamId,
      id,
      o.slug ?? `p-${id.slice(0, 8)}`,
      o.name ?? "P",
      o.description ?? "",
      o.instructions ?? "",
      o.visibility ?? "workspace",
      owner,
    ],
  );
  return id;
}

interface FileOpts {
  path?: string;
  size?: number;
  sha?: string;
  source?: string;
  addedBy?: string;
}

const file = (teamId: string, projectId: string, o: FileOpts = {}) =>
  admin.query(
    `INSERT INTO project_files (team_id, project_id, path, size_bytes, sha256, mime_type, blob_ref, source, added_by)
     VALUES ($1, $2, $3, $4, $5, 'text/plain', $6, $7, $8)`,
    [
      teamId,
      projectId,
      o.path ?? "a.txt",
      o.size ?? 5,
      o.sha ?? "a".repeat(64),
      `teams/${teamId}/projects/${projectId}/files/${randomUUID()}`,
      o.source ?? "upload",
      o.addedBy ?? owner,
    ],
  );

const thread = (teamId: string, projectId: string | null, extra = "") =>
  admin.query(
    `INSERT INTO threads (team_id, owner_user_id, project_id${extra ? ", " + extra.split("=")[0] : ""})
     VALUES ($1, $2, $3${extra ? ", " + extra.split("=")[1] : ""}) RETURNING id`,
    [teamId, owner, projectId],
  );

const memoryDoc = (teamId: string, projectId: string, path = "MEMORY.md") =>
  admin.query(
    `INSERT INTO memory_docs (team_id, scope, project_id, path) VALUES ($1, 'project', $2, $3)`,
    [teamId, projectId, path],
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

describe("projects", () => {
  it("accepts a project with visibility workspace, no head and zero storage by default", async () => {
    const t = await team();
    const id = randomUUID();
    await admin.query(
      `INSERT INTO projects (team_id, id, slug, name, created_by) VALUES ($1, $2, $3, 'P', $4)`,
      [t, id, `d-${id.slice(0, 8)}`, owner],
    );
    const { rows } = await admin.query(
      `SELECT visibility, archived_at, default_agent_id, head_commit_id, live_bytes, live_objects,
              history_bytes, history_objects
         FROM projects WHERE team_id = $1 AND id = $2`,
      [t, id],
    );
    expect(rows).toEqual([
      {
        visibility: "workspace",
        archived_at: null,
        default_agent_id: null,
        head_commit_id: null,
        live_bytes: "0",
        live_objects: 0,
        history_bytes: "0",
        history_objects: 0,
      },
    ]);
  });

  it("has no members_mode column any more (MG0)", async () => {
    expect(
      await count(
        `SELECT count(*) AS n FROM information_schema.columns
          WHERE table_name = 'projects' AND column_name = 'members_mode'`,
        [],
      ),
    ).toBe(0);
  });

  it("refuses negative storage counters", async () => {
    const t = await team();
    const p = await project(t);
    for (const col of ["live_bytes", "live_objects", "history_bytes", "history_objects"]) {
      expect(
        await errorCode(
          admin.query(`UPDATE projects SET ${col} = -1 WHERE team_id = $1 AND id = $2`, [t, p]),
        ),
        col,
      ).toBe("23514");
    }
  });

  it("keeps the slug unique per team, not across teams", async () => {
    const t = await team();
    expect(await errorCode(project(t, { slug: "alpha" }))).toBeUndefined();
    expect(await errorCode(project(t, { slug: "alpha" }))).toBe("23505");
    expect(await errorCode(project(await team(), { slug: "alpha" }))).toBeUndefined();
  });

  it("refuses slugs, names, descriptions and visibilities the contract refuses", async () => {
    const t = await team();
    for (const slug of ["", "-a", "A", "a_b", "a b", "a/b", "a".repeat(41)]) {
      expect(await errorCode(project(t, { slug })), slug).toBe("23514");
    }
    expect(await errorCode(project(t, { slug: "a".repeat(40) }))).toBeUndefined();
    expect(await errorCode(project(t, { name: "  " }))).toBe("23514");
    expect(await errorCode(project(t, { name: "n".repeat(101) }))).toBe("23514");
    expect(await errorCode(project(t, { description: "d".repeat(501) }))).toBe("23514");
    for (const visibility of ["everyone", "team", "selected"]) {
      expect(await errorCode(project(t, { visibility })), visibility).toBe("23514");
    }
    expect(await errorCode(project(t, { visibility: "restricted" }))).toBeUndefined();
  });

  it("caps instructions at 8 KiB of UTF-8 bytes", async () => {
    const t = await team();
    expect(await errorCode(project(t, { instructions: "a".repeat(8192) }))).toBeUndefined();
    expect(await errorCode(project(t, { instructions: "a".repeat(8193) }))).toBe("23514");
    // 4096 two-byte characters = 8192 bytes; one more is over.
    expect(await errorCode(project(t, { instructions: "é".repeat(4096) }))).toBeUndefined();
    expect(await errorCode(project(t, { instructions: "é".repeat(4097) }))).toBe("23514");
  });
});

describe("project_members", () => {
  const member = (t: string, p: string, userId: string, role = "editor") =>
    admin.query(
      `INSERT INTO project_members (team_id, project_id, user_id, role, added_by) VALUES ($1, $2, $3, $4, $5)`,
      [t, p, userId, role, owner],
    );

  it("accepts one row per user and project, roles owner|editor|reader only", async () => {
    const t = await team();
    const p = await project(t);
    expect(await errorCode(member(t, p, owner, "owner"))).toBeUndefined();
    expect(await errorCode(member(t, p, owner))).toBe("23505");
    for (const role of ["admin", "member"]) {
      expect(await errorCode(member(t, p, other, role)), role).toBe("23514");
    }
    expect(await errorCode(member(t, p, other, "reader"))).toBeUndefined();
    const third = await user();
    expect(await errorCode(member(t, p, third))).toBeUndefined();
  });

  it("defaults a row's role to editor", async () => {
    const t = await team();
    const p = await project(t);
    await admin.query(
      `INSERT INTO project_members (team_id, project_id, user_id, added_by) VALUES ($1, $2, $3, $3)`,
      [t, p, other],
    );
    const { rows } = await admin.query(`SELECT role FROM project_members WHERE team_id = $1`, [t]);
    expect(rows).toEqual([{ role: "editor" }]);
  });

  it("refuses a project of another team and goes with its project", async () => {
    const t = await team();
    const p = await project(t);
    expect(await errorCode(member(await team(), p, owner))).toBe("23503");
    await member(t, p, other);
    await admin.query(`DELETE FROM projects WHERE team_id = $1 AND id = $2`, [t, p]);
    expect(await count(`SELECT count(*) AS n FROM project_members WHERE team_id = $1`, [t])).toBe(
      0,
    );
  });
});

describe("project_files", () => {
  it("accepts files, unique per project and path", async () => {
    const t = await team();
    const p = await project(t);
    expect(await errorCode(file(t, p, { path: "docs/a.txt" }))).toBeUndefined();
    expect(await errorCode(file(t, p, { path: "docs/a.txt" }))).toBe("23505");
    expect(await errorCode(file(t, await project(t), { path: "docs/a.txt" }))).toBeUndefined();
    expect(await errorCode(file(t, p, { source: "proposal", path: "b.txt" }))).toBeUndefined();
  });

  it("refuses bad paths, sizes, hashes and sources", async () => {
    const t = await team();
    const p = await project(t);
    for (const path of ["", "/abs", "a//b", "a/", "../x", "a/../b", "./x", "a/.", "a\\b"]) {
      expect(await errorCode(file(t, p, { path })), path).toBe("23514");
    }
    for (const path of ["a.txt", "dir/sub/b.tar.gz", ".gitignore", "a..b/c"]) {
      expect(await errorCode(file(t, p, { path })), path).toBeUndefined();
    }
    expect(await errorCode(file(t, p, { path: "s1", size: -1 }))).toBe("23514");
    expect(await errorCode(file(t, p, { path: "s2", size: 50 * 1024 * 1024 + 1 }))).toBe("23514");
    expect(await errorCode(file(t, p, { path: "s3", size: 50 * 1024 * 1024 }))).toBeUndefined();
    expect(await errorCode(file(t, p, { path: "h", sha: "xyz" }))).toBe("23514");
    expect(await errorCode(file(t, p, { path: "o", source: "robot" }))).toBe("23514");
  });

  it("refuses a project of another team", async () => {
    const t = await team();
    expect(await errorCode(file(await team(), await project(t)))).toBe("23503");
  });

  it("goes with its project when no hold covers the team", async () => {
    const t = await team();
    const p = await project(t);
    await file(t, p);
    await admin.query(`DELETE FROM projects WHERE team_id = $1 AND id = $2`, [t, p]);
    expect(await count(`SELECT count(*) AS n FROM project_files WHERE team_id = $1`, [t])).toBe(0);
  });
});

describe("threads.project_id and memory_docs.project_id", () => {
  it("accepts null and a project of the same team, refuses another team's project", async () => {
    const t = await team();
    const p = await project(t);
    expect(await errorCode(thread(t, null))).toBeUndefined();
    expect(await errorCode(thread(t, p))).toBeUndefined();
    expect(await errorCode(thread(await team(), p))).toBe("23503");
    expect(await errorCode(thread(t, randomUUID()))).toBe("23503");
    expect(await errorCode(memoryDoc(t, p))).toBeUndefined();
    expect(await errorCode(memoryDoc(await team(), p))).toBe("23503");
    expect(await errorCode(memoryDoc(t, randomUUID(), "x.md"))).toBe("23503");
  });

  it("keeps test threads out of projects (existing CHECK)", async () => {
    const t = await team();
    const p = await project(t);
    expect(await errorCode(thread(t, p, "is_test=true"))).toBe("23514");
    expect(await errorCode(thread(t, null, "is_test=true"))).toBeUndefined();
  });

  it("refuses deleting a project that threads still point at (RESTRICT), then allows it once detached", async () => {
    const t = await team();
    const p = await project(t);
    await thread(t, p);
    const del = () => admin.query(`DELETE FROM projects WHERE team_id = $1 AND id = $2`, [t, p]);
    expect(await errorCode(del())).toBe("23503");
    await admin.query(`UPDATE threads SET project_id = NULL WHERE team_id = $1`, [t]);
    expect(await errorCode(del())).toBeUndefined();
    expect(await count(`SELECT count(*) AS n FROM threads WHERE team_id = $1`, [t])).toBe(1);
  });

  it("refuses deleting a project that memory docs still point at (RESTRICT), soft-deleted ones included", async () => {
    const t = await team();
    const p = await project(t);
    await memoryDoc(t, p);
    await admin.query(`UPDATE memory_docs SET deleted_at = now() WHERE team_id = $1`, [t]);
    const del = () => admin.query(`DELETE FROM projects WHERE team_id = $1 AND id = $2`, [t, p]);
    expect(await errorCode(del())).toBe("23503");
    await admin.query(`DELETE FROM memory_docs WHERE team_id = $1`, [t]);
    expect(await errorCode(del())).toBeUndefined();
  });

  it("leaves an existing project's data alone when a thread is deleted", async () => {
    const t = await team();
    const p = await project(t);
    await thread(t, p);
    await admin.query(`DELETE FROM threads WHERE team_id = $1`, [t]);
    expect(await count(`SELECT count(*) AS n FROM projects WHERE team_id = $1`, [t])).toBe(1);
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

describe("project files under a legal hold", () => {
  it("refuses deleting and truncating project files under any active hold in the team", async () => {
    const t = await team();
    const p = await project(t);
    await file(t, p);
    await activeHold(t, other);
    expect(await errorCode(admin.query(`DELETE FROM project_files WHERE team_id = $1`, [t]))).toBe(
      LEGAL_HOLD_SQLSTATE,
    );
    expect(await errorCode(admin.query(`TRUNCATE project_files`))).toBe(LEGAL_HOLD_SQLSTATE);
    expect(await count(`SELECT count(*) AS n FROM project_files WHERE team_id = $1`, [t])).toBe(1);
  });

  it("refuses the cascade of a project delete, and lets other teams' files go", async () => {
    const t = await team();
    const p = await project(t);
    await file(t, p);
    await activeHold(t, null);
    expect(
      await errorCode(admin.query(`DELETE FROM projects WHERE team_id = $1 AND id = $2`, [t, p])),
    ).toBe(LEGAL_HOLD_SQLSTATE);
    const t2 = await team();
    await file(t2, await project(t2));
    expect(
      await errorCode(admin.query(`DELETE FROM project_files WHERE team_id = $1`, [t2])),
    ).toBeUndefined();
  });
});

describe("project tables under break-glass", () => {
  async function approvedGrant(teamId: string, userId: string | null): Promise<string> {
    const { rows } = await appClient.query<{ id: string }>(
      `INSERT INTO break_glass_grants (team_id, user_id, admin_id, reason) VALUES ($1, $2, $3, 'probe') RETURNING id`,
      [teamId, userId, requester],
    );
    const id = rows[0]?.id ?? "";
    await appClient.query(
      `UPDATE break_glass_grants SET status = 'approved', approver_id = $2 WHERE id = $1`,
      [id, approver],
    );
    return id;
  }

  async function readAs(grant: string, _team: null, table: string): Promise<number> {
    await appClient.query("BEGIN");
    try {
      await appClient.query(
        `SELECT set_config('${BREAK_GLASS_GRANT_SETTING}', $1, true), set_config('${BREAK_GLASS_ACTOR_SETTING}', $2, true)`,
        [grant, requester],
      );
      const { rows } = await appClient.query(`SELECT 1 FROM ${table}`);
      return rows.length;
    } finally {
      await appClient.query("ROLLBACK");
    }
  }

  it("shows project files to a team grant, narrowed by user, never projects or members", async () => {
    const t = await team();
    const p = await project(t);
    await file(t, p, { path: "mine.txt", addedBy: owner });
    await file(t, p, { path: "theirs.txt", addedBy: other });
    await admin.query(
      `INSERT INTO project_members (team_id, project_id, user_id, added_by) VALUES ($1, $2, $3, $3)`,
      [t, p, other],
    );
    const teamGrant = await approvedGrant(t, null);
    expect(await readAs(teamGrant, null, "project_files")).toBe(2);
    expect(await readAs(teamGrant, null, "projects")).toBe(0);
    expect(await readAs(teamGrant, null, "project_members")).toBe(0);
    const userGrant = await approvedGrant(t, owner);
    expect(await readAs(userGrant, null, "project_files")).toBe(1);
  });

  it("shows nothing of another team", async () => {
    const t = await team();
    const t2 = await team();
    await file(t2, await project(t2));
    expect(await readAs(await approvedGrant(t, null), null, "project_files")).toBe(0);
  });
});
