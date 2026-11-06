import { randomUUID } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportZip } from "./retention/export.js";
import type { Person } from "./testing/event-stream-fixture.js";
import { RunFixture, type RunWorld } from "./testing/run-fixture.js";

/**
 * The conversation tree's server side (KOBE-543, docs/specs/conversation-tree.md CT2, CT3, CT9,
 * CT12-CT14): branch labels (owner only, refused in Trash and on test threads, idempotent, never
 * activity, not audited, rate-limited, copied by a fork), the branches read for owner and reader,
 * the hover card's junction count, the leaf rules, the leaf on the wire, and every branch in the
 * export.
 */
const f = new RunFixture();

beforeAll(async () => {
  await f.setup();
});
afterAll(async () => {
  await f.teardown();
});

const as = (p: Person) => f.on(0, p);

const AT = "2026-11-05T10:00:00.000Z";

type Entry = { id: string; parent: string | null; type: string; payload: Record<string, unknown> };

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
      role === "user" ? { role, content: text } : { role, content: [{ type: "text", text }] },
  },
});

const settings: Entry = {
  id: "s0",
  parent: null,
  type: "thinking_level_change",
  payload: { type: "thinking_level_change", id: "s0", parentId: null, timestamp: AT },
};

/**
 * Two first messages under the hidden root (u1 and u1b), and a second turn edited (u2 and u2b
 * under a1): junctions s0 and a1. The leaf is a2.
 */
const TREE: readonly Entry[] = [
  settings,
  message("u1", "s0", "user", "first question"),
  message("a1", "u1", "assistant", "first answer"),
  message("u1b", "s0", "user", "another opening"),
  message("a1b", "u1b", "assistant", "another answer"),
  message("u2", "a1", "user", "second question"),
  message("a2", "u2", "assistant", "second answer"),
  message("u2b", "a1", "user", "edited second question"),
  message("a2b", "u2b", "assistant", "edited second answer"),
];

const STRAIGHT: readonly Entry[] = [
  settings,
  message("u1", "s0", "user", "only question"),
  message("a1", "u1", "assistant", "only answer"),
];

/** A scheduled run's skipped-actions note under the leaf, beside the next prompt (server-written). */
const SKIPPED_NOTE: Entry = {
  id: "ks-00000000-0000-4000-8000-000000000001",
  parent: "a1",
  type: "custom_message",
  payload: {
    type: "custom_message",
    customType: "kobe.skipped_actions",
    content: "Skipped actions",
    display: true,
    timestamp: AT,
  },
};
/** The next prompt, under the same answer as the note. */
const AFTER_NOTE: readonly Entry[] = [
  ...STRAIGHT,
  SKIPPED_NOTE,
  message("u2", "a1", "user", "next question"),
  message("a2", "u2", "assistant", "next answer"),
];

async function seed(team: string, threadId: string, entries: readonly Entry[], leaf: string) {
  for (const e of entries) {
    await f.fx.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [team, threadId, e.id, e.parent, e.type, e.payload],
    );
  }
  await f.fx.admin.query(`UPDATE threads SET leaf_entry_id = $3 WHERE team_id = $1 AND id = $2`, [
    team,
    threadId,
    leaf,
  ]);
}

/** A team with the thread's owner, a reader (the thread is shared to the team) and an outsider. */
async function world(entries: readonly Entry[] = TREE, leaf = "a2") {
  const w = await f.world();
  const reader = await f.member(w.team);
  const threadId = await f.thread(w.owner);
  await seed(w.team, threadId, entries, leaf);
  const shared = await as(w.owner).post(`/v1/threads/${threadId}/share`, { visibility: "team" });
  expect(shared.status, JSON.stringify(shared.json)).toBe(200);
  const other = await f.world();
  const outsider = await f.member(other.team);
  return { w, reader, outsider, threadId };
}

const label = (p: Person, threadId: string, entryId: string, value: string | null) =>
  as(p).put(`/v1/threads/${threadId}/labels/${entryId}`, { label: value });

async function activity(team: string, threadId: string): Promise<string> {
  const { rows } = await f.fx.admin.query<{ at: string }>(
    `SELECT last_activity_at::text AS at FROM threads WHERE team_id = $1 AND id = $2`,
    [team, threadId],
  );
  return rows[0]?.at ?? "";
}

/** Uses up `max` hits of a member's window for `key` (rate_limits is shared with Better Auth). */
async function exhaust(key: string, userId: string, max: number) {
  await f.fx.admin.query(
    `INSERT INTO rate_limits (key, count, last_request) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET count = EXCLUDED.count, last_request = EXCLUDED.last_request`,
    [`kobe:${key}:${userId}`, max, Date.now()],
  );
}

describe("labels (ac-2)", () => {
  it("the owner labels any node; idempotent, null removes, never activity, not audited", async () => {
    const { w, threadId } = await world();
    const before = await activity(w.team, threadId);
    const first = await label(w.owner, threadId, "u1b", "  try 5% cut ");
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json).toEqual({ labels: [{ entry_id: "u1b", label: "try 5% cut" }], runs: [] });
    // The same label again changes nothing; a new one replaces it.
    expect((await label(w.owner, threadId, "u1b", "try 5% cut")).json).toEqual(first.json);
    const renamed = await label(w.owner, threadId, "u1b", "the good answer");
    expect(renamed.json.labels).toEqual([{ entry_id: "u1b", label: "the good answer" }]);
    expect((await label(w.owner, threadId, "a2", "main")).json.labels).toHaveLength(2);
    const removed = await label(w.owner, threadId, "u1b", null);
    expect(removed.json.labels).toEqual([{ entry_id: "a2", label: "main" }]);
    // Removing a label that is not there is fine too.
    expect((await label(w.owner, threadId, "u1b", null)).status).toBe(200);
    expect(await activity(w.team, threadId)).toBe(before);
    expect((await f.auditActions(w.team)).filter((a) => a.includes("label"))).toEqual([]);
  });

  it("refuses readers, foreign entries, Trash, test threads and bad labels", async () => {
    const { w, reader, outsider, threadId } = await world();
    const byReader = await label(reader, threadId, "u1", "mine");
    expect([byReader.status, byReader.json.code]).toEqual([403, "read_only"]);
    const byOutsider = await label(outsider, threadId, "u1", "x");
    expect([byOutsider.status, byOutsider.json.code]).toEqual([404, "thread_not_found"]);

    // An entry of another thread of the same owner is not this thread's.
    const otherThread = await f.thread(w.owner);
    await seed(w.team, otherThread, [{ ...settings, id: "elsewhere" }], "elsewhere");
    const foreign = await label(w.owner, threadId, "elsewhere", "x");
    expect([foreign.status, foreign.json.code]).toEqual([404, "entry_not_found"]);

    for (const bad of ["", "   ", "x".repeat(61), "two\nlines"]) {
      expect((await label(w.owner, threadId, "u1", bad)).status).toBe(400);
    }

    const test = await f.thread(w.owner);
    await seed(w.team, test, STRAIGHT, "a1");
    await f.fx.admin.query(`UPDATE threads SET is_test = true WHERE team_id = $1 AND id = $2`, [
      w.team,
      test,
    ]);
    const onTest = await label(w.owner, test, "u1", "x");
    expect([onTest.status, onTest.json.code]).toEqual([409, "test_thread"]);
    // A Workbench test chat is a test thread too; an eval's thread is refused by the eval guard.
    await f.fx.admin.query(
      `UPDATE threads SET is_test = false, skill_test = true WHERE team_id = $1 AND id = $2`,
      [w.team, test],
    );
    const onWorkbench = await label(w.owner, test, "u1", "x");
    expect([onWorkbench.status, onWorkbench.json.code]).toEqual([409, "test_thread"]);
    // skill_eval never changes after insert: an eval's thread is made as one.
    const evalThread = randomUUID();
    await f.fx.admin.query(
      `INSERT INTO threads (team_id, id, owner_user_id, title, skill_eval)
       VALUES ($1, $2, $3, 'eval', true)`,
      [w.team, evalThread, w.owner.id],
    );
    await seed(w.team, evalThread, STRAIGHT, "a1");
    const onEval = await label(w.owner, evalThread, "u1", "x");
    expect([onEval.status, onEval.json.code]).toEqual([409, "skill_eval_thread"]);

    expect((await as(w.owner).delete(`/v1/threads/${threadId}`)).status).toBe(200);
    const inTrash = await label(w.owner, threadId, "u1", "x");
    expect([inTrash.status, inTrash.json.code]).toEqual([409, "thread_in_trash"]);
  });

  it("stops at 200 labels per thread", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    const chain: Entry[] = [settings];
    for (let i = 1; i <= 201; i += 1) {
      chain.push({ ...settings, id: `e${i}`, parent: chain.at(-1)?.id ?? null });
    }
    await seed(w.team, threadId, chain, "e201");
    await f.fx.admin.query(
      `INSERT INTO thread_branch_labels (team_id, thread_id, entry_id, label, created_by)
       SELECT $1, $2, 'e' || g, 'label ' || g, $3 FROM generate_series(1, 200) g`,
      [w.team, threadId, w.owner.id],
    );
    const over = await label(w.owner, threadId, "e201", "one too many");
    expect([over.status, over.json.code]).toEqual([409, "label_limit"]);
    // Changing an existing label is not a new one.
    expect((await label(w.owner, threadId, "e1", "renamed")).status).toBe(200);
  });

  it("rate-limits label writes per member (60 per 10 minutes)", async () => {
    const { w, threadId } = await world();
    await exhaust("thread-label", w.owner.id, 60);
    const res = await label(w.owner, threadId, "u1", "x");
    expect([res.status, res.json.code]).toEqual([429, "rate_limited"]);
  });

  it("a fork carries the labels of the copied path, same entry ids", async () => {
    const { w, reader, threadId } = await world();
    for (const [entry, text] of [
      ["u1", "opening"],
      ["u2b", "edited"],
      ["a2", "main"],
      ["u1b", "other root"],
    ] as const) {
      expect((await label(w.owner, threadId, entry, text)).status).toBe(200);
    }
    // A reader forks the owner's thread at a2: the path s0-u1-a1-u2-a2.
    const fork = await as(reader).post(`/v1/threads/${threadId}/fork`, { entry_id: "a2" });
    expect(fork.status, JSON.stringify(fork.json)).toBe(201);
    const forkId = fork.json.thread_id as string;
    const read = await as(reader).get(`/v1/threads/${forkId}/branches`);
    expect(read.json.labels).toEqual([
      { entry_id: "a2", label: "main" },
      { entry_id: "u1", label: "opening" },
    ]);
    // The fork's owner may change them.
    expect((await label(reader, forkId, "a2", "mine now")).status).toBe(200);
  });
});

describe("branches read (ac-3)", () => {
  async function rememberedRun(w: RunWorld, threadId: string, userEntryId: string) {
    const runId = await f.message(w.owner, threadId, "go");
    await f.fx.admin.query(
      `UPDATE runs SET status = 'completed', queue_pos = NULL, started_at = coalesce(started_at, now()),
              ended_at = now(), user_entry_id = $3
        WHERE team_id = $1 AND id = $2`,
      [w.team, runId, userEntryId],
    );
    await f.fx.admin.query(
      `INSERT INTO approvals (team_id, id, run_id, thread_id, user_id, connection_id, tool_call_id,
                              tool, input_canonical, risk, reasons, status, decided_at, decided_by,
                              expires_at, token_kid, token_expires_at, input_hmac, remembered)
       VALUES ($1, gen_random_uuid(), $2, $3, $4, gen_random_uuid(), $5, 'bash', '{}', 'write',
               '[]', 'allowed', now(), $4, now() + interval '1 hour', 'k1',
               now() + interval '1 hour', repeat('a', 43), true)`,
      [w.team, runId, threadId, w.owner.id, `tc-${randomUUID()}`],
    );
    return runId;
  }

  it("lists labels and remembered-rule runs for the owner and a reader; 404 for others", async () => {
    const { w, reader, outsider, threadId } = await world();
    const empty = await as(w.owner).get(`/v1/threads/${threadId}/branches`);
    expect(empty.json).toEqual({ labels: [], runs: [] });
    await label(w.owner, threadId, "u2b", "edited");
    await rememberedRun(w, threadId, "u2b");
    const body = { labels: [{ entry_id: "u2b", label: "edited" }], runs: [] as unknown[] };
    body.runs = [{ user_entry_id: "u2b", remembered_rule: true }];
    expect((await as(w.owner).get(`/v1/threads/${threadId}/branches`)).json).toEqual(body);
    expect((await as(reader).get(`/v1/threads/${threadId}/branches`)).json).toEqual(body);
    const hidden = await as(outsider).get(`/v1/threads/${threadId}/branches`);
    expect([hidden.status, hidden.json.code]).toEqual([404, "thread_not_found"]);
    // A member of the same team the thread is not shared with doesn't see it either.
    const unshared = await f.thread(w.owner);
    const nosy = await as(reader).get(`/v1/threads/${unshared}/branches`);
    expect([nosy.status, nosy.json.code]).toEqual([404, "thread_not_found"]);
  });
});

describe("hover card junctions (ac-4)", () => {
  it("counts parents with more than one child; a straight thread has none", async () => {
    const { w, reader, threadId } = await world();
    const card = await as(reader).get(`/v1/threads/${threadId}/card`);
    expect(card.json).toMatchObject({ branches: 2, branches_capped: false });

    const twoFirst = await f.thread(w.owner);
    await seed(w.team, twoFirst, TREE.slice(0, 5), "a1");
    expect((await as(w.owner).get(`/v1/threads/${twoFirst}/card`)).json).toMatchObject({
      branches: 1,
      branches_capped: false,
    });
    const straight = await f.thread(w.owner);
    await seed(w.team, straight, STRAIGHT, "a1");
    expect((await as(w.owner).get(`/v1/threads/${straight}/card`)).json).toMatchObject({
      branches: 0,
      branches_capped: false,
    });
  });

  it("a server-written note beside the next prompt is no junction", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    await seed(w.team, threadId, AFTER_NOTE, "a2");
    expect((await as(w.owner).get(`/v1/threads/${threadId}/card`)).json).toMatchObject({
      branches: 0,
      branches_capped: false,
    });
  });

  it("stops at 1,000 junctions", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    await seed(w.team, threadId, [settings], "s0");
    // 1,001 parents under the root, each with two children: 1,002 junctions with the root.
    await f.fx.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type)
       SELECT $1, $2, 'p' || g, 's0', 'custom' FROM generate_series(1, 1001) g`,
      [w.team, threadId],
    );
    await f.fx.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type)
       SELECT $1, $2, 'c' || g || s, 'p' || g, 'custom'
         FROM generate_series(1, 1001) g, (VALUES ('a'), ('b')) v(s)`,
      [w.team, threadId],
    );
    expect((await as(w.owner).get(`/v1/threads/${threadId}/card`)).json).toMatchObject({
      branches: 1000,
      branches_capped: true,
    });
  });
});

describe("leaf rules (ac-5)", () => {
  it("refuses a leaf move while a run is queued", async () => {
    const { w, threadId } = await world();
    await f.fx.admin.query(
      `INSERT INTO runs (team_id, thread_id, trigger, status, queue_pos)
       VALUES ($1, $2, 'user', 'queued', 1)`,
      [w.team, threadId],
    );
    const res = await as(w.owner).post(`/v1/threads/${threadId}/leaf`, { entry_id: "a2b" });
    expect([res.status, res.json.code]).toEqual([409, "thread_busy"]);
  });

  it("moves the leaf, and answers 429 past 120 moves per 10 minutes per member", async () => {
    const { w, reader, threadId } = await world();
    const moved = await as(w.owner).post(`/v1/threads/${threadId}/leaf`, { entry_id: "a2b" });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    expect(moved.json.leaf_entry_id).toBe("a2b");
    await exhaust("thread-leaf", w.owner.id, 120);
    const limited = await as(w.owner).post(`/v1/threads/${threadId}/leaf`, { entry_id: "a2" });
    expect([limited.status, limited.json.code]).toEqual([429, "rate_limited"]);
    // A reader never moves it (and is not counted against the owner).
    const byReader = await as(reader).post(`/v1/threads/${threadId}/leaf`, { entry_id: "a2" });
    expect([byReader.status, byReader.json.code]).toEqual([403, "read_only"]);
  });

  it("a send's commit carries the new leaf in thread.updated, without a title", async () => {
    const w = await f.world();
    const ws = await f.connect(w, 0);
    const threadId = await f.thread(w.owner);
    const runId = await f.message(w.owner, threadId, "hello");
    const start = await ws.started(runId);
    const entries = ws.reply(start, "hi there");
    await ws.acked(runId);
    await f.until(w.team, runId, "completed");
    const leafEvents = (await f.events(w.team, runId)).filter(
      (e) => e.type === "thread.updated" && "leaf_entry_id" in e.payload,
    );
    expect(leafEvents.map((e) => e.payload)).toEqual([
      { thread_id: threadId, leaf_entry_id: entries.assistant },
    ]);
  });
});

describe("export: every branch (ac-6)", () => {
  async function zipOf(w: RunWorld) {
    const chunks: Uint8Array[] = [];
    for await (const c of exportZip(f.fx.db, { teamId: w.team, userId: w.owner.id }, undefined)) {
      chunks.push(c);
    }
    return unzipSync(Buffer.concat(chunks));
  }

  it("writes each other leaf's path with its Branched-from line; labels in the metadata", async () => {
    const { w, threadId } = await world();
    await label(w.owner, threadId, "u1b", "try 5% cut");
    const straight = await f.thread(w.owner);
    await seed(w.team, straight, STRAIGHT, "a1");
    const zip = await zipOf(w);
    const index = JSON.parse(strFromU8(zip["threads.json"] ?? new Uint8Array())) as {
      threads: {
        id: string;
        transcript: string;
        labels?: unknown;
        branches?: string[];
      }[];
    };
    const tree = index.threads.find((t) => t.id === threadId);
    const dir = tree?.transcript.replace(/^transcripts\//u, "").replace(/\.md$/u, "");
    expect(tree?.labels).toEqual([{ entry_id: "u1b", label: "try 5% cut" }]);
    expect(tree?.branches).toEqual([
      `branches/${dir}/1-try-5-cut.md`,
      `branches/${dir}/2-edited-second-question.md`,
    ]);
    const main = strFromU8(zip[tree?.transcript ?? ""] ?? new Uint8Array());
    expect(main).toContain("second answer");
    expect(main).not.toContain("edited second");
    const root = strFromU8(zip[`branches/${dir}/1-try-5-cut.md`] ?? new Uint8Array());
    expect(root.split("\n")[0]).toBe("Branched from the start of the main transcript.");
    expect(root).toContain("another answer");
    expect(root).not.toContain("first question");
    const edited = strFromU8(
      zip[`branches/${dir}/2-edited-second-question.md`] ?? new Uint8Array(),
    );
    expect(edited.split("\n")[0]).toBe(
      "Branched from message 2 of the main transcript: “first answer”",
    );
    expect(edited).toContain("edited second answer");
    expect(edited).not.toContain("first question");

    // A straight thread adds nothing.
    const plain = index.threads.find((t) => t.id === straight);
    expect(plain).not.toHaveProperty("labels");
    expect(plain).not.toHaveProperty("branches");
    const plainDir = plain?.transcript.replace(/^transcripts\//u, "").replace(/\.md$/u, "");
    expect(Object.keys(zip).filter((k) => k.startsWith(`branches/${plainDir}`))).toEqual([]);
  });

  it("a server-written note is no branch; at most 200 branch files, then branches_capped", async () => {
    const w = await f.world();
    const noted = await f.thread(w.owner);
    await seed(w.team, noted, AFTER_NOTE, "a2");
    const many = await f.thread(w.owner);
    await seed(w.team, many, STRAIGHT, "a1");
    // 201 edits of the first question: 201 branches off the main transcript.
    await f.fx.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
       SELECT $1, $2, 'b' || g, 's0', 'message',
              jsonb_build_object('type', 'message', 'id', 'b' || g, 'parentId', 's0',
                                 'message', jsonb_build_object('role', 'user', 'content', 'edit ' || g))
         FROM generate_series(1, 201) g`,
      [w.team, many],
    );
    const zip = await zipOf(w);
    const index = JSON.parse(strFromU8(zip["threads.json"] ?? new Uint8Array())) as {
      threads: { id: string; branches?: string[]; branches_capped?: boolean }[];
    };
    const plain = index.threads.find((t) => t.id === noted);
    expect(plain).not.toHaveProperty("branches");
    const capped = index.threads.find((t) => t.id === many);
    expect(capped?.branches).toHaveLength(200);
    expect(capped?.branches_capped).toBe(true);
    expect(capped?.branches?.[0]).toMatch(/\/1-edit-1\.md$/u);
  });
});
