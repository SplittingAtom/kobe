import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";
import { NOTIFICATION_KINDS } from "./schema/schedule-notifications.js";
import {
  createTestDatabase,
  migrationsBefore,
  testServerUrl,
  type TestDatabase,
} from "./test-support/database.js";

/**
 * KOBE-645 (v1.3 Semantic Memory SMA13): every memory notification kind arrives at once over a
 * populated database at the previous migration; existing rows of every older shape survive and
 * the older kinds keep their rules. Memory rows name only what their kind allows. The pending
 * object registry `memory_reminders` is a team table under forced RLS with the canonical policy.
 */
const MARKER = 'CREATE TABLE "memory_reminders"';

const MEMORY_KINDS = [
  "memory.scope.near_full",
  "memory.review.reminder",
  "memory.review.digest",
  "memory.review.candidates_ready",
  "memory.proposal.received",
  "memory.proposal.accepted",
  "memory.proposal.dismissed",
  "memory.proposal.changes_requested",
  "memory.proposal.expired",
  "memory.suggestion.received",
  "memory.suggestion.accepted",
  "memory.suggestion.dismissed",
  "memory.suggestion.expired",
  "memory.site_proposal.received",
  "memory.site_proposal.confirmed",
  "memory.site_proposal.changes_requested",
  "memory.site_proposal.accepted",
  "memory.site_proposal.dismissed",
  "memory.site_proposal.expired",
];

let db: TestDatabase | undefined;
let older = "";
const teamA = randomUUID();
const teamB = randomUUID();
const ann = randomUUID();
const bob = randomUUID();
const scheduleId = randomUUID();
const threadId = randomUUID();
const runId = randomUUID();
const projectId = randomUUID();

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const database = (): TestDatabase => {
  if (!db) throw new Error("database not created");
  return db;
};
const asAdmin = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(database().adminUrl, fn);
const asApp = <T>(fn: (c: pg.Client) => Promise<T>) => withClient(database().appUrl, fn);

async function code(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

/** Inserts one notification row in team A for Ann; returns the error code or undefined. */
function insert(c: pg.Client, fields: Record<string, unknown>): Promise<string | undefined> {
  const row = { team_id: teamA, user_id: ann, ...fields };
  const cols = Object.keys(row);
  return code(() =>
    c.query(
      `INSERT INTO notifications (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(row),
    ),
  );
}

beforeAll(async () => {
  older = migrationsBefore(MARKER);
  db = await createTestDatabase(testServerUrl(), { migrationsFolder: older });
  await asAdmin(async (c) => {
    await c.query(`INSERT INTO users (id, name, email) VALUES ($1, 'Ann', $2), ($3, 'Bob', $4)`, [
      ann,
      `${ann}@example.test`,
      bob,
      `${bob}@example.test`,
    ]);
    await c.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, 'A'), ($3, $4, 'B')`, [
      teamA,
      `a-${teamA.slice(0, 8)}`,
      teamB,
      `b-${teamB.slice(0, 8)}`,
    ]);
    await c.query(
      `INSERT INTO team_members (team_id, user_id, role)
       VALUES ($1, $2, 'team_admin'), ($1, $3, 'member'), ($4, $3, 'member')`,
      [teamA, ann, bob, teamB],
    );
    await c.query(
      `INSERT INTO projects (team_id, id, slug, name, created_by) VALUES ($1, $2, 'notes', 'Notes', $3)`,
      [teamA, projectId, ann],
    );
    await c.query(
      `INSERT INTO schedules (team_id, id, user_id, agent_id, prompt, recurrence, tz)
       VALUES ($1, $2, $3, $4, 'p', '{"kind":"daily","at":"09:00"}', 'UTC')`,
      [teamA, scheduleId, ann, randomUUID()],
    );
    await c.query(
      `INSERT INTO threads (team_id, id, owner_user_id, title, schedule_id) VALUES ($1, $2, $3, 't', $4)`,
      [teamA, threadId, ann, scheduleId],
    );
    await c.query(
      `INSERT INTO runs (team_id, id, thread_id, trigger) VALUES ($1, $2, $3, 'schedule')`,
      [teamA, runId, threadId],
    );
    // One row of each older shape.
    await c.query(
      `INSERT INTO notifications (team_id, user_id, kind, schedule_id, thread_id, run_id)
       VALUES ($1, $2, 'schedule.run.succeeded', $3, $4, $5)`,
      [teamA, ann, scheduleId, threadId, runId],
    );
    await c.query(
      `INSERT INTO notifications (team_id, user_id, kind, schedule_id, paused_by)
       VALUES ($1, $2, 'schedule.paused', $3, 'deactivation')`,
      [teamA, ann, scheduleId],
    );
    await c.query(
      `INSERT INTO notifications (team_id, user_id, kind, actor_user_id, subject_user_id, team_role)
       VALUES ($1, $2, 'team.site_admin.member_added', $3, $3, 'member')`,
      [teamA, ann, bob],
    );
  });
  await runMigrations({ databaseUrl: database().ownerUrl, appRole: database().appRole });
}, 180_000);

afterAll(async () => {
  await db?.drop();
  if (older) rmSync(older, { recursive: true, force: true });
});

describe("memory notification kinds on upgrade (KOBE-645)", () => {
  it("keeps every existing row as it was (ac-1)", async () => {
    await asAdmin(async (c) => {
      const { rows } = await c.query<{ kind: string }>(
        `SELECT kind FROM notifications ORDER BY kind`,
      );
      expect(rows.map((r) => r.kind)).toEqual([
        "schedule.paused",
        "schedule.run.succeeded",
        "team.site_admin.member_added",
      ]);
    });
  });

  it("names exactly the memory kinds the schema lists (ac-1)", () => {
    expect(NOTIFICATION_KINDS.filter((k) => k.startsWith("memory."))).toEqual(MEMORY_KINDS);
  });

  it("accepts every memory kind with its own fields (ac-1)", async () => {
    await asAdmin(async (c) => {
      const object = { memory_object_id: randomUUID() };
      expect(await insert(c, { kind: "memory.scope.near_full", memory_scope: "team" })).toBe(
        undefined,
      );
      expect(await insert(c, { kind: "memory.scope.near_full", memory_scope: "site" })).toBe(
        undefined,
      );
      expect(
        await insert(c, {
          kind: "memory.review.digest",
          related_kind: "memory.proposal.received",
          item_count: 7,
        }),
      ).toBe(undefined);
      expect(await insert(c, { kind: "memory.review.reminder", ...object })).toBe(undefined);
      expect(
        await insert(c, {
          kind: "memory.review.candidates_ready",
          thread_id: threadId,
          item_count: 3,
          ...object,
        }),
      ).toBe(undefined);
      expect(
        await insert(c, {
          kind: "memory.review.reminder",
          related_kind: "memory.site_proposal.confirmed",
          memory_object_id: randomUUID(),
        }),
      ).toBe(undefined);
      expect(
        await insert(c, {
          kind: "memory.review.reminder",
          related_kind: "memory.suggestion.received",
          project_id: projectId,
          memory_object_id: randomUUID(),
        }),
      ).toBe(undefined);
      for (const kind of MEMORY_KINDS.filter((k) => /proposal|suggestion/.test(k))) {
        const suggestion = kind.startsWith("memory.suggestion.");
        expect(
          await insert(c, {
            kind,
            memory_object_id: randomUUID(),
            actor_user_id: bob,
            ...(suggestion ? { project_id: projectId } : {}),
          }),
          kind,
        ).toBe(undefined);
        // The actor is optional on these kinds.
        expect(
          await insert(c, {
            kind,
            memory_object_id: randomUUID(),
            ...(suggestion ? { project_id: projectId } : {}),
          }),
          kind,
        ).toBe(undefined);
      }
    });
  });

  it("refuses memory rows that carry what their kind does not name (ac-1)", async () => {
    await asAdmin(async (c) => {
      const bad: Record<string, unknown>[] = [
        { kind: "memory.unknown.kind" },
        { kind: "memory.scope.near_full" },
        { kind: "memory.scope.near_full", memory_scope: "user" },
        { kind: "memory.scope.near_full", memory_scope: "team", actor_user_id: bob },
        { kind: "memory.review.digest", item_count: 6 },
        { kind: "memory.review.digest", related_kind: "memory.review.digest", item_count: 6 },
        { kind: "memory.review.digest", related_kind: "memory.proposal.received", item_count: 0 },
        { kind: "memory.review.reminder" },
        { kind: "memory.review.candidates_ready", item_count: 3 },
        { kind: "memory.review.candidates_ready", thread_id: threadId },
        {
          kind: "memory.review.candidates_ready",
          thread_id: threadId,
          run_id: runId,
          item_count: 3,
        },
        { kind: "memory.proposal.received", thread_id: threadId, memory_object_id: randomUUID() },
        {
          kind: "memory.review.reminder",
          memory_object_id: randomUUID(),
          related_kind: "memory.proposal.accepted",
        },
        {
          kind: "memory.review.reminder",
          memory_object_id: randomUUID(),
          related_kind: "memory.suggestion.received",
        },
        { kind: "memory.proposal.received" },
        { kind: "memory.proposal.received", memory_object_id: randomUUID(), project_id: projectId },
        { kind: "memory.suggestion.received", memory_object_id: randomUUID() },
        {
          kind: "memory.proposal.received",
          memory_object_id: randomUUID(),
          thread_id: threadId,
          run_id: runId,
        },
        { kind: "memory.site_proposal.accepted", memory_object_id: randomUUID(), item_count: 1 },
        // Older kinds still refuse the memory columns.
        {
          kind: "schedule.paused",
          schedule_id: scheduleId,
          paused_by: "deactivation",
          memory_scope: "team",
        },
        { kind: "team.member.added", actor_user_id: bob, memory_object_id: randomUUID() },
        // ...and keep their own rules.
        { kind: "team.member.added" },
      ];
      for (const fields of bad)
        expect(await insert(c, fields), JSON.stringify(fields)).toBe("23514");
      // A project of another team cannot be named.
      expect(
        await code(() =>
          c.query(
            `INSERT INTO notifications (team_id, user_id, kind, memory_object_id, project_id)
             VALUES ($1, $2, 'memory.suggestion.received', $3, $4)`,
            [teamB, bob, randomUUID(), projectId],
          ),
        ),
      ).toBe("23503");
    });
  });

  it("creates memory_reminders empty, under forced RLS with the canonical policy", async () => {
    await asAdmin(async (c) => {
      const { rows } = await c.query<{ rls: boolean; force: boolean; n: number }>(
        `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
                (SELECT count(*)::int FROM memory_reminders) AS n
           FROM pg_class c WHERE c.relname = 'memory_reminders'`,
      );
      expect(rows).toEqual([{ rls: true, force: true, n: 0 }]);
      const policies = await c.query<{ name: string; qual: string }>(
        `SELECT policyname AS name, qual FROM pg_policies WHERE tablename = 'memory_reminders'`,
      );
      expect(policies.rows.map((p) => p.name)).toEqual(["team_isolation"]);
      // The cascading foreign keys (membership, project) have indexes.
      const idx = await c.query<{ name: string }>(
        `SELECT indexname AS name FROM pg_indexes WHERE tablename = 'memory_reminders' ORDER BY 1`,
      );
      expect(idx.rows.map((r) => r.name)).toEqual(
        expect.arrayContaining(["memory_reminders_user_idx", "memory_reminders_project_idx"]),
      );
      expect(policies.rows[0]?.qual).toContain("current_setting('kobe.team_id'::text, true)");
    });
  });

  it("confines reminders to the Workspace, once per object and recipient", async () => {
    const objectId = randomUUID();
    await asApp(async (c) => {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('kobe.team_id', $1, true)`, [teamA]);
      const add = (team: string, user: string) =>
        code(() =>
          c.query(
            `INSERT INTO memory_reminders (team_id, object_id, related_kind, user_id, due_at)
             VALUES ($1, $2, 'memory.proposal.received', $3, now() + interval '7 days')`,
            [team, objectId, user],
          ),
        );
      expect(await add(teamA, ann)).toBe(undefined);
      await c.query("SAVEPOINT s");
      expect(await add(teamA, ann)).toBe("23505");
      await c.query("ROLLBACK TO SAVEPOINT s");
      expect(await add(teamB, bob)).toBe("42501");
      await c.query("ROLLBACK");
    });
    await asAdmin(async (c) => {
      // The recipient must be a member of that Workspace; a suggestion names its project.
      expect(
        await code(() =>
          c.query(
            `INSERT INTO memory_reminders (team_id, object_id, user_id, due_at)
             VALUES ($1, $2, $3, now())`,
            [teamB, randomUUID(), ann],
          ),
        ),
      ).toBe("23503");
      expect(
        await code(() =>
          c.query(
            `INSERT INTO memory_reminders (team_id, object_id, related_kind, user_id, due_at)
             VALUES ($1, $2, 'memory.suggestion.received', $3, now())`,
            [teamA, randomUUID(), ann],
          ),
        ),
      ).toBe("23514");
    });
  });
});
