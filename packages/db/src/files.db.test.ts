import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { LEGAL_HOLD_SQLSTATE } from "./legal-hold/index.js";

/** KOBE-142: files and team_storage_quotas constraints and cascades (probe suite: probe.db.test). */
const admin = new pg.Client({ connectionString: inject("adminUrl") });
const appClient = new pg.Client({ connectionString: inject("appUrl") });
let owner = "";
let requester = "";
let approver = "";

async function user(isAdmin = false): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO users (id, name, email) VALUES ($1, 'U', $2)`, [
    id,
    `${id}@a.test`,
  ]);
  if (isAdmin)
    await admin.query(`INSERT INTO install_roles (user_id, role) VALUES ($1, 'admin')`, [id]);
  return id;
}

async function team(): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'T')`, [
    id,
    `files-${id.slice(0, 8)}`,
  ]);
  return id;
}

async function thread(teamId: string): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO threads (team_id, id, owner_user_id, title) VALUES ($1, $2, $3, 't')`,
    [teamId, id, owner],
  );
  return id;
}

async function run(teamId: string, threadId: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO runs (team_id, thread_id, trigger, status, started_at, ended_at)
     VALUES ($1, $2, 'user', 'completed', now(), now()) RETURNING id`,
    [teamId, threadId],
  );
  return rows[0]?.id ?? "";
}

interface FileOpts {
  threadId?: string | null;
  kind?: string;
  scan?: string;
  runId?: string | null;
  toolCallId?: string | null;
  size?: number;
  sha?: string;
}

const file = (teamId: string, o: FileOpts = {}) =>
  admin.query(
    `INSERT INTO files (team_id, user_id, thread_id, kind, name, size_bytes, sha256, mime_type, blob_ref, scan_status, run_id, tool_call_id)
     VALUES ($1, $2, $3, $4, 'a.txt', $5, $6, 'text/plain', 'k', $7, $8, $9)`,
    [
      teamId,
      owner,
      o.threadId ?? null,
      o.kind ?? "upload",
      o.size ?? 3,
      o.sha ?? "a".repeat(64),
      o.scan ?? "none",
      o.runId ?? null,
      o.toolCallId ?? null,
    ],
  );

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

describe("files", () => {
  it("accept an unthreaded upload and a threaded shared file", async () => {
    const t = await team();
    const th = await thread(t);
    const r = await run(t, th);
    expect(await errorCode(file(t))).toBeUndefined();
    expect(
      await errorCode(file(t, { threadId: th, kind: "shared", runId: r, toolCallId: "c1" })),
    ).toBeUndefined();
  });

  it("refuse a bad kind, scan status, size and hash", async () => {
    const t = await team();
    expect(await errorCode(file(t, { kind: "other" }))).toBe("23514");
    expect(await errorCode(file(t, { scan: "pending" }))).toBe("23514");
    expect(await errorCode(file(t, { size: -1 }))).toBe("23514");
    expect(await errorCode(file(t, { sha: "xyz" }))).toBe("23514");
  });

  it("apply a tool call id once per team, and only where it is set", async () => {
    const t = await team();
    const u = await team();
    expect(await errorCode(file(t, { toolCallId: "dup" }))).toBeUndefined();
    expect(await errorCode(file(t, { toolCallId: "dup" }))).toBe("23505");
    expect(await errorCode(file(u, { toolCallId: "dup" }))).toBeUndefined();
    expect(await errorCode(file(t))).toBeUndefined();
    expect(await errorCode(file(t))).toBeUndefined();
  });

  it("refuse a thread or run of another team", async () => {
    const t = await team();
    const u = await team();
    const th = await thread(u);
    expect(await errorCode(file(t, { threadId: th }))).toBe("23503");
    expect(await errorCode(file(t, { runId: await run(u, th), toolCallId: "x" }))).toBe("23503");
  });

  it("go with their thread (cascade) and keep unthreaded files and other teams' files", async () => {
    const t = await team();
    const u = await team();
    const th = await thread(t);
    await file(t, { threadId: th });
    await file(t);
    await file(u, { threadId: await thread(u) });
    await admin.query(`DELETE FROM threads WHERE team_id = $1 AND id = $2`, [t, th]);
    expect(await count(`SELECT count(*) AS n FROM files WHERE team_id = $1`, [t])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM files WHERE team_id = $1`, [u])).toBe(1);
  });
});

describe("files under a legal hold", () => {
  it("are refused deletion and truncation", async () => {
    const t = await team();
    await file(t);
    const { rows } = await appClient.query<{ id: string }>(
      `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, NULL, 'matter', $2) RETURNING id`,
      [t, requester],
    );
    await appClient.query(
      `UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
      [rows[0]?.id, approver],
    );
    expect(await errorCode(admin.query(`DELETE FROM files WHERE team_id = $1`, [t]))).toBe(
      LEGAL_HOLD_SQLSTATE,
    );
    expect(await errorCode(admin.query(`TRUNCATE files`))).toBe(LEGAL_HOLD_SQLSTATE);
    expect(await count(`SELECT count(*) AS n FROM files WHERE team_id = $1`, [t])).toBe(1);
  });
});

describe("team_storage_quotas", () => {
  it("hold one row per team, with null meaning the install default, and no negative limit", async () => {
    const t = await team();
    const q = (max: number | null) =>
      admin.query(
        `INSERT INTO team_storage_quotas (team_id, max_bytes, updated_by) VALUES ($1, $2, $3)`,
        [t, max, owner],
      );
    expect(await errorCode(q(null))).toBeUndefined();
    expect(await errorCode(q(5))).toBe("23505");
    const u = await team();
    expect(
      await errorCode(
        admin.query(
          `INSERT INTO team_storage_quotas (team_id, max_bytes, updated_by) VALUES ($1, -1, $2)`,
          [u, owner],
        ),
      ),
    ).toBe("23514");
  });
});
