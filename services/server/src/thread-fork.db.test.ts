import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Person } from "./testing/event-stream-fixture.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { RunFixture } from "./testing/run-fixture.js";
import type { BlobStore } from "./retention/index.js";

/**
 * KOBE-216 (CE16): "Fork to a new thread" from a message. The fork copies the entries from the
 * root to the chosen entry into a new thread in the same project, with provenance
 * (forked_from_thread_id / forked_at_entry_id, KOBE-215) that the summary resolves for the viewer
 * only (review-280 L2). A fork needs no sandbox: its Pi session is rebuilt from the copied entries
 * (`session.restore`) when it first runs.
 */
const f = new RunFixture();
const objects = new MemoryObjects();
const PREFIX = "kobe/";
const blobs: BlobStore = { objects, prefix: PREFIX };

beforeAll(async () => {
  await f.setup({ blobs });
});
afterAll(async () => {
  await f.teardown();
});

const as = (p: Person) => f.on(0, p);

type Entry = { id: string; parent: string | null; type: string; payload: Record<string, unknown> };

const AT = "2026-10-14T10:00:00.000Z";

const message = (id: string, parent: string | null, role: "user" | "assistant", text: string) => ({
  id,
  parent,
  type: "message",
  payload: {
    type: "message",
    id,
    parentId: parent,
    timestamp: AT,
    message:
      role === "user"
        ? { role, content: text }
        : {
            role,
            content: [{ type: "text", text }],
            usage: { input: 900, output: 100, totalTokens: 1000 },
          },
  },
});

/**
 * A Pi-shaped history: a settings root (Pi 1.0 writes one), a compacted first turn and a second
 * turn after the compaction, and a sibling root branch (`kobe.branch` under the root, KOBE-214).
 */
const HISTORY: readonly Entry[] = [
  {
    id: "s0",
    parent: null,
    type: "thinking_level_change",
    payload: {
      type: "thinking_level_change",
      id: "s0",
      parentId: null,
      timestamp: AT,
      thinkingLevel: "off",
    },
  },
  message("u1", "s0", "user", "first question"),
  message("a1", "u1", "assistant", "first answer"),
  {
    id: "c1",
    parent: "a1",
    type: "compaction",
    payload: {
      type: "compaction",
      id: "c1",
      parentId: "a1",
      timestamp: AT,
      summary: "We talked about the first question.",
      firstKeptEntryId: "a1",
      tokensBefore: 5000,
    },
  },
  message("u2", "c1", "user", "second question"),
  message("a2", "u2", "assistant", "second answer"),
  {
    id: "k1",
    parent: "s0",
    type: "custom",
    payload: {
      type: "custom",
      id: "k1",
      parentId: "s0",
      timestamp: AT,
      customType: "kobe.branch",
      data: {},
    },
  },
  message("u1b", "k1", "user", "first question, edited"),
  message("a1b", "u1b", "assistant", "another first answer"),
];

/** A team with a selected-mode project (author + reader) and a thread in it holding HISTORY. */
async function world() {
  const w = await f.world();
  const author = w.owner;
  const reader = await f.member(w.team);
  const project = await as(author).post("/v1/projects", {
    name: "Forks",
    members_mode: "selected",
    member_user_ids: [reader.id],
  });
  expect(project.status, JSON.stringify(project.json)).toBe(201);
  const made = await as(author).post("/v1/threads", { project_id: project.json.id, title: "plan" });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const threadId = made.json.thread_id as string;
  for (const e of HISTORY) {
    await f.fx.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [w.team, threadId, e.id, e.parent, e.type, e.payload],
    );
  }
  await f.fx.admin.query(`UPDATE threads SET leaf_entry_id = 'a2' WHERE team_id = $1 AND id = $2`, [
    w.team,
    threadId,
  ]);
  return { w, author, reader, projectId: project.json.id as string, threadId };
}

const entryIds = (detail: { entries: { entry_id: string }[] }) =>
  detail.entries.map((e) => e.entry_id);

describe("fork to a new thread (ac-1, ac-3)", () => {
  it("copies the entries up to the chosen message into the same project, with provenance", async () => {
    const x = await world();
    const res = await as(x.author).post(`/v1/threads/${x.threadId}/fork`, {
      entry_id: "a1b",
      title: "Edited take",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const id = res.json.thread_id as string;
    const provenance = {
      forked_from_thread_id: x.threadId,
      forked_at_entry_id: "a1b",
      forked_from_title: "plan",
    };
    // The sibling root: only its own branch is copied, and the fork ends at the chosen entry.
    const detail = (await as(x.author).get(`/v1/threads/${id}`)).json;
    expect(entryIds(detail)).toEqual(["s0", "k1", "u1b", "a1b"]);
    expect(detail).toMatchObject({
      title: "Edited take",
      leaf_entry_id: "a1b",
      project_id: x.projectId,
      ...provenance,
    });

    // The rail list carries it; the source is not a fork.
    const list = (await as(x.author).get(`/v1/threads?project_id=${x.projectId}`)).json.threads;
    expect(list.find((t: { thread_id: string }) => t.thread_id === id)).toMatchObject(provenance);
    expect(list.find((t: { thread_id: string }) => t.thread_id === x.threadId)).toMatchObject({
      forked_from_thread_id: null,
      forked_at_entry_id: null,
      forked_from_title: null,
    });
    const { rows } = await f.fx.admin.query(
      `SELECT forked_from_thread_id, forked_at_entry_id FROM threads WHERE team_id = $1 AND id = $2`,
      [x.w.team, id],
    );
    expect(rows).toEqual([{ forked_from_thread_id: x.threadId, forked_at_entry_id: "a1b" }]);
  });

  it("forks inside a compacted history: the compaction comes along, and the source is untouched", async () => {
    const x = await world();
    const res = await as(x.author).post(`/v1/threads/${x.threadId}/fork`, { entry_id: "u2" });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const detail = (await as(x.author).get(`/v1/threads/${res.json.thread_id}`)).json;
    expect(entryIds(detail)).toEqual(["s0", "u1", "a1", "c1", "u2"]);
    expect(detail).toMatchObject({ title: "plan", forked_at_entry_id: "u2" });
    const source = (await as(x.author).get(`/v1/threads/${x.threadId}`)).json;
    expect(source).toMatchObject({ leaf_entry_id: "a2", forked_from_thread_id: null });
    expect(source.entries).toHaveLength(HISTORY.length);
  });
});

describe("a fork wakes like any thread (ac-2)", () => {
  it("forks with no sandbox running, then runs on the copied session", async () => {
    const x = await world();
    // No sandbox is connected: the source's sandbox is hibernated.
    const res = await as(x.author).post(`/v1/threads/${x.threadId}/fork`, { entry_id: "a2" });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const fork = res.json.thread_id as string;

    const ws = await f.connect(x.w);
    const runId = await f.message(x.author, fork, "and a third?");
    const start = await ws.started(runId);
    // Pi had no session for the fork: it was rebuilt from the copied entries, ending at a2.
    expect(ws.sessions.get(fork)?.map((e) => e.id)).toEqual(["s0", "u1", "a1", "c1", "u2", "a2"]);
    expect(start.thread_id).toBe(fork);
    const reply = ws.reply(start, "third answer");
    await ws.acked(runId);
    await f.until(x.w.team, runId, "completed");
    const detail = (await as(x.author).get(`/v1/threads/${fork}`)).json;
    expect(detail.leaf_entry_id).toBe(reply.assistant);
    expect(detail.entries.at(-2)).toMatchObject({ entry_id: reply.user, parent_id: "a2" });
    // The source never ran.
    expect(ws.sessions.has(x.threadId)).toBe(false);
  });
});

describe("the back-link is resolved for the viewer only (ac-6)", () => {
  it("names the source while the viewer can open it, and only the fork point once they can't", async () => {
    const x = await world();
    const url = `/v1/threads/${x.threadId}`;
    await as(x.author).post(`${url}/share`, { visibility: "project" });
    const res = await as(x.reader).post(`${url}/fork`, { entry_id: "a1" });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const fork = res.json.thread_id as string;
    expect((await as(x.reader).get(`/v1/threads/${fork}`)).json).toMatchObject({
      owner_user_id: x.reader.id,
      forked_from_thread_id: x.threadId,
      forked_from_title: "plan",
    });

    const hit = async () =>
      ((await as(x.reader).get(`/v1/threads?q=plan`)).json.threads as { thread_id: string }[]).find(
        (t) => t.thread_id === fork,
      );
    expect(await hit()).toMatchObject({
      forked_from_thread_id: x.threadId,
      forked_from_title: "plan",
    });

    // Unshared: the reader's fork keeps its fork point but no longer names the source.
    await as(x.author).post(`${url}/share`, { visibility: "private" });
    const neutral = {
      forked_from_thread_id: null,
      forked_from_title: null,
      forked_at_entry_id: "a1",
    };
    expect((await as(x.reader).get(`/v1/threads/${fork}`)).json).toMatchObject(neutral);
    const list = (await as(x.reader).get(`/v1/threads`)).json.threads;
    expect(list.find((t: { thread_id: string }) => t.thread_id === fork)).toMatchObject(neutral);
    expect(await hit()).toMatchObject(neutral);
    const renamed = await as(x.reader).patch(`/v1/threads/${fork}`, { title: "mine" });
    expect(renamed.json).toMatchObject(neutral);

    // The column still holds the link: only the response hides it.
    const { rows } = await f.fx.admin.query(
      `SELECT forked_from_thread_id FROM threads WHERE team_id = $1 AND id = $2`,
      [x.w.team, fork],
    );
    expect(rows).toEqual([{ forked_from_thread_id: x.threadId }]);
  });

  it("shows only the fork point once the source is purged", async () => {
    const x = await world();
    const res = await as(x.author).post(`/v1/threads/${x.threadId}/fork`, {});
    const fork = res.json.thread_id as string;
    await f.fx.admin.query(`DELETE FROM threads WHERE team_id = $1 AND id = $2`, [
      x.w.team,
      x.threadId,
    ]);
    expect((await as(x.author).get(`/v1/threads/${fork}`)).json).toMatchObject({
      forked_from_thread_id: null,
      forked_from_title: null,
      forked_at_entry_id: "a2",
    });
  });
});

/**
 * While it exists, a fork titled "race" deletes its source right before its own row is written
 * (after every access check), so the insert's check on threads_forked_from_fk fails (23503).
 */
async function withPurgeRace(fn: () => Promise<void>): Promise<void> {
  await f.fx.admin.query(`
    CREATE FUNCTION test_purge_fork_source() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.title = 'race' THEN
        DELETE FROM threads WHERE team_id = NEW.team_id AND id = NEW.forked_from_thread_id;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_purge_fork_source BEFORE INSERT ON threads
      FOR EACH ROW EXECUTE FUNCTION test_purge_fork_source();`);
  try {
    await fn();
  } finally {
    await f.fx.admin.query(`
      DROP TRIGGER test_purge_fork_source ON threads;
      DROP FUNCTION test_purge_fork_source();`);
  }
}

/** An offloaded entry `big` under a2 whose body sits in the source's tree. */
async function offloaded(team: string, threadId: string): Promise<string> {
  const key = `${PREFIX}teams/${team}/threads/${threadId}/entries/big`;
  objects.objects.set(key, Buffer.from("{}"));
  await f.fx.admin.query(
    `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload, blob_ref)
     VALUES ($1, $2, 'big', 'a2', 'message', '{}', $3)`,
    [team, threadId, key],
  );
  return key;
}

describe("a fork racing its source's purge (ac-5)", () => {
  it("answers thread_not_found on the fork-link 23503 in the single transaction", async () => {
    const x = await world();
    await withPurgeRace(async () => {
      const res = await as(x.author).post(`/v1/threads/${x.threadId}/fork`, { title: "race" });
      expect([res.status, res.json.code]).toEqual([404, "thread_not_found"]);
    });
  });

  it("answers thread_not_found and removes the copied bodies on the fork-link 23503", async () => {
    const x = await world();
    await offloaded(x.w.team, x.threadId);
    await withPurgeRace(async () => {
      const before = new Set(objects.objects.keys());
      const res = await as(x.author).post(`/v1/threads/${x.threadId}/fork`, {
        entry_id: "big",
        title: "race",
      });
      expect([res.status, res.json.code]).toEqual([404, "thread_not_found"]);
      expect(new Set(objects.objects.keys())).toEqual(before);
    });
  });

  it("answers thread_not_found when the source and its bodies go while they are copied", async () => {
    const x = await world();
    await offloaded(x.w.team, x.threadId);
    const before = new Set(objects.objects.keys());
    const real = objects.copy.bind(objects);
    objects.copy = async () => {
      await f.fx.admin.query(`DELETE FROM threads WHERE team_id = $1 AND id = $2`, [
        x.w.team,
        x.threadId,
      ]);
      throw new Error("NoSuchKey");
    };
    try {
      const res = await as(x.author).post(`/v1/threads/${x.threadId}/fork`, { entry_id: "big" });
      expect([res.status, res.json.code]).toEqual([404, "thread_not_found"]);
      expect(new Set(objects.objects.keys())).toEqual(before);
    } finally {
      objects.copy = real;
    }
  });
});

describe("fork limits (review-281 L1, L3)", () => {
  it("refuses a title with control characters like create and rename", async () => {
    const x = await world();
    for (const title of ["a\u0000b", "line\nbreak"]) {
      const res = await as(x.author).post(`/v1/threads/${x.threadId}/fork`, { title });
      expect(res.status, JSON.stringify(title)).toBe(400);
    }
  });

  it("copies a path longer than one INSERT can hold", async () => {
    const x = await world();
    // 2,500 more entries after a2 (one INSERT of 8 columns caps out near 8,190 rows).
    await f.fx.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
       SELECT $1, $2, 'n' || i, CASE WHEN i = 1 THEN 'a2' ELSE 'n' || (i - 1) END, 'custom',
              jsonb_build_object('type', 'custom', 'id', 'n' || i, 'timestamp', '2026-10-14T10:00:00Z',
                                 'parentId', CASE WHEN i = 1 THEN 'a2' ELSE 'n' || (i - 1) END)
         FROM generate_series(1, 2500) AS i`,
      [x.w.team, x.threadId],
    );
    const res = await as(x.author).post(`/v1/threads/${x.threadId}/fork`, { entry_id: "n2500" });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const { rows } = await f.fx.admin.query<{ n: string; last: string }>(
      `SELECT count(*) AS n, (array_agg(entry_id ORDER BY seq DESC))[1] AS last
         FROM thread_entries WHERE team_id = $1 AND thread_id = $2`,
      [x.w.team, res.json.thread_id],
    );
    expect(rows[0]).toEqual({ n: "2506", last: "n2500" });
  });

  it("refuses to fork a thread with nothing in it", async () => {
    const x = await world();
    const empty = await as(x.author).post("/v1/threads", { title: "empty" });
    const res = await as(x.author).post(`/v1/threads/${empty.json.thread_id}/fork`, {});
    expect([res.status, res.json.code]).toEqual([409, "nothing_to_fork"]);
  });

  it("rate-limits forks per user", async () => {
    const x = await world();
    const url = `/v1/threads/${x.threadId}/fork`;
    for (let i = 0; i < 30; i += 1) {
      expect((await as(x.author).post(url, { entry_id: "u1" })).status).toBe(201);
    }
    const res = await as(x.author).post(url, { entry_id: "u1" });
    expect([res.status, res.json.code]).toEqual([429, "rate_limited"]);
    // Another member is not affected.
    await as(x.author).post(`/v1/threads/${x.threadId}/share`, { visibility: "project" });
    expect((await as(x.reader).post(url, { entry_id: "u1" })).status).toBe(201);
  });
});
