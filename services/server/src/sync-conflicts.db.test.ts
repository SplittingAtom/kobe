import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { threadSyncConflictsResponseSchema, type ServerToSandboxFrame } from "@kobe/protocol";
import { runEvents, withTeam } from "@kobe/db";
import { ConflictRate, onWorkspaceConflict } from "./sandbox-wire/sync-conflict.js";
import {
  CONFLICTS_PER_MEMBER_MAX,
  recordConflict,
  takeAgentNotes,
} from "./sync-conflicts/store.js";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";

/**
 * KOBE-492 (ac-1, ac-2, ac-3): a sync conflict the sandbox reports is recorded for the thread
 * whose run last wrote the path (else no thread), audited with ids and hashes only, listed for the
 * thread's owner only, settled by resolve/dismiss, and told to the agent once: mid-run as a note
 * frame when that thread's run is active on the connection, else at its next run.start.
 */
const fx = new EventStreamFixture();
const M = "a".repeat(64);
const A = "b".repeat(64);

beforeAll(async () => {
  await fx.setup([{}]);
});

afterAll(async () => {
  await fx.teardown();
});

interface World {
  readonly team: string;
  readonly owner: Person;
  readonly reader: Person;
}

async function world(): Promise<World> {
  const owner = await fx.person(`o${randomBytes(2).toString("hex")}`);
  const reader = await fx.person(`r${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`sc-${randomBytes(3).toString("hex")}`, owner, [reader]);
  return { team, owner, reader };
}

async function threadRun(w: World): Promise<{ runId: string; threadId: string }> {
  const runId = await fx.run(w.team, w.owner);
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [w.team, runId],
  );
  return { runId, threadId: must(rows[0], "run").thread_id };
}

let clock = Date.now() - 60_000;
const tick = () => new Date((clock += 100));

async function wrote(w: World, runId: string, path: string, isError = false) {
  const id = `call_${randomBytes(3).toString("hex")}`;
  await withTeam(fx.db, w.team, (tx) =>
    tx.insert(runEvents).values([
      {
        teamId: w.team,
        runId,
        type: "tool.call",
        payload: { tool_call_id: id, tool: "write", input: { path, content: "x" }, risk: "write" },
        createdAt: tick(),
      },
      {
        teamId: w.team,
        runId,
        type: "tool.result",
        payload: {
          tool_call_id: id,
          tool: "write",
          is_error: isError,
          preview: "",
          truncated: false,
        },
        createdAt: tick(),
      },
    ]),
  );
}

const conflict = (path = "notes.md") => {
  const dot = path.lastIndexOf(".");
  return {
    path,
    conflict_path: `${path.slice(0, dot)}.conflict-20261023T120000Z${path.slice(dot)}`,
    member_sha256: M,
    agent_sha256: A,
  };
};

const owner = (w: World) => ({ teamId: w.team, userId: w.owner.id });

async function auditTargets(w: World): Promise<Record<string, unknown>[]> {
  const { rows } = await fx.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'workspace.sync_conflict' ORDER BY seq`,
    [w.team],
  );
  return rows.map((r) => r.target);
}

describe("sync conflicts (KOBE-492)", () => {
  it("records the conflict on the thread whose run last wrote the path, audited by ids", async () => {
    const w = await world();
    const a = await threadRun(w);
    const b = await threadRun(w);
    await wrote(w, a.runId, "/workspace/notes.md");
    await wrote(w, b.runId, "notes.md");
    await wrote(w, a.runId, "notes.md", true); // a failed write is not a write
    const recorded = await recordConflict(fx.db, owner(w), conflict());
    expect(recorded).toMatchObject({ threadId: b.threadId, runId: b.runId });
    const targets = await auditTargets(w);
    expect(targets).toEqual([
      {
        userId: w.owner.id,
        conflictId: recorded.id,
        threadId: b.threadId,
        runId: b.runId,
        memberSha256: M,
        agentSha256: A,
      },
    ]);
    expect(JSON.stringify(targets)).not.toContain("notes");
  });

  it("records a conflict no run wrote without a thread", async () => {
    const w = await world();
    const recorded = await recordConflict(fx.db, owner(w), conflict("orphan.txt"));
    expect(recorded.threadId).toBeUndefined();
    expect((await auditTargets(w))[0]).not.toHaveProperty("threadId");
  });

  it("lists the thread's open conflicts for its owner only; resolve and dismiss settle them", async () => {
    const w = await world();
    const t = await threadRun(w);
    await wrote(w, t.runId, "a.md");
    await wrote(w, t.runId, "b.md");
    const first = await recordConflict(fx.db, owner(w), conflict("a.md"));
    const second = await recordConflict(fx.db, owner(w), conflict("b.md"));
    const url = `/v1/threads/${t.threadId}/sync-conflicts`;
    const listed = await w.owner.browser.get(url);
    expect(listed.status).toBe(200);
    const body = threadSyncConflictsResponseSchema.parse(listed.json);
    expect(body.conflicts.map((c) => c.path)).toEqual(["b.md", "a.md"]);

    const shared = await w.owner.browser.post(`/v1/threads/${t.threadId}/share`, {
      visibility: "team",
    });
    expect(shared.status).toBe(200);
    expect((await w.reader.browser.get(url)).status).toBe(404);
    expect(
      (await w.reader.browser.post(`${url}/${first.id}`, { action: "dismissed" })).status,
    ).toBe(404);

    expect((await w.owner.browser.post(`${url}/${first.id}`, { action: "delete" })).status).toBe(
      400,
    );
    expect(
      (await w.owner.browser.post(`${url}/${randomUUID()}`, { action: "dismissed" })).status,
    ).toBe(404);
    expect((await w.owner.browser.post(`${url}/${first.id}`, { action: "dismissed" })).status).toBe(
      204,
    );
    expect((await w.owner.browser.post(`${url}/${second.id}`, { action: "resolved" })).status).toBe(
      204,
    );
    expect((await w.owner.browser.post(`${url}/${second.id}`, { action: "resolved" })).status).toBe(
      204,
    );
    const after = threadSyncConflictsResponseSchema.parse((await w.owner.browser.get(url)).json);
    expect(after.conflicts).toEqual([]);
  });

  it("tells the agent once: at the next run.start, newest few, oldest first", async () => {
    const w = await world();
    const t = await threadRun(w);
    for (const p of ["1.md", "2.md", "3.md", "4.md", "5.md", "6.md"]) {
      await wrote(w, t.runId, p);
      await recordConflict(fx.db, owner(w), conflict(p));
    }
    const notes = await takeAgentNotes(fx.db, owner(w), t.threadId);
    expect(notes.map((n) => n.path)).toEqual(["2.md", "3.md", "4.md", "5.md", "6.md"]);
    expect(await takeAgentNotes(fx.db, owner(w), t.threadId)).toEqual([]);
  });

  it("tells a run active on the connection at once with a note frame", async () => {
    const w = await world();
    const t = await threadRun(w);
    await wrote(w, t.runId, "live.md");
    const sent: ServerToSandboxFrame[] = [];
    const done = new Promise<void>((resolve) => {
      onWorkspaceConflict(
        {
          db: fx.db,
          target: owner(w),
          log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
          hasCapability: true,
          rate: new ConflictRate(),
          activeRun: (threadId) => (threadId === t.threadId ? t.runId : undefined),
          send: (f) => {
            sent.push(f);
            resolve();
            return true;
          },
        },
        { v: 1, type: "workspace.conflict", ...conflict("live.md"), at: new Date().toISOString() },
      );
    });
    await done;
    expect(sent).toEqual([
      {
        v: 1,
        type: "workspace.conflict_note",
        run_id: t.runId,
        thread_id: t.threadId,
        conflicts: [conflict("live.md")],
      },
    ]);
    expect(await takeAgentNotes(fx.db, owner(w), t.threadId)).toEqual([]);
  });

  it("keeps at most the per-member cap of rows", async () => {
    const w = await world();
    await fx.admin.query(
      `INSERT INTO workspace_sync_conflicts
         (team_id, user_id, path, conflict_path, member_sha256, agent_sha256, created_at)
       SELECT $1, $2, 'x.md', 'x.conflict-20261023T120000Z.md', $3, $3,
              now() - make_interval(secs => g)
         FROM generate_series(1, $4::int) g`,
      [w.team, w.owner.id, M, CONFLICTS_PER_MEMBER_MAX],
    );
    await recordConflict(fx.db, owner(w), conflict("y.md"));
    const { rows } = await fx.admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM workspace_sync_conflicts WHERE team_id = $1 AND user_id = $2`,
      [w.team, w.owner.id],
    );
    expect(Number(rows[0]?.n)).toBe(CONFLICTS_PER_MEMBER_MAX);
  });
});
