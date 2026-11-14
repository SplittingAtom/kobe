import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql, withTeam } from "@kobe/db";
import {
  CAPABILITY_MEMORY,
  CAPABILITY_SEMANTIC_MEMORY,
  runMemoryContextSchema,
  threadContextMemoriesSchema,
  type RunMemoryContext,
} from "@kobe/protocol";
import { buildPolicyOnly, buildRunSemantic } from "./memory/items/run-memory.js";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";
import { MemoryObjects } from "./testing/memory-objects.js";

/**
 * KOBE-382 (v1.3 SMA7): `run.start.memory.semantic` picked per message from the runner's memory,
 * recorded per run, and shown to the thread's owner only. Walls: never another person's personal
 * or portable items, never another Workspace's; Site items only while the Workspace allows them,
 * Policy whatever the Workspace says. No block for test chats, `notes_only`, `off`, or an agent
 * without `semantic_memory`. The selector itself: memory/items/select.test.ts.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const sandboxes: FakeSandbox[] = [];
let listener: Awaited<ReturnType<typeof sandboxListener>>;

let runner: Person;
let other: Person;
let teamA: string;
let teamB: string;
const WORD = `zebra${randomBytes(3).toString("hex")}`;
const item: Record<string, string> = {};

beforeAll(async () => {
  await fx.setup([{}], () => ({
    blobs: { objects: new MemoryObjects(), prefix: "kobe/" },
    agents: { publishRate: { windowMs: 60_000, max: 10_000 } },
    sandboxWire: {
      sweep: false,
      tuning: { batchWindowMs: 20, resultPollMs: 200, lostGraceMs: 0, helloTimeoutMs: 1_000 },
    },
  }));
  listener = await sandboxListener(fx.replica(0).deps, auth);
  runner = await fx.person(`run${randomBytes(2).toString("hex")}`);
  other = await fx.person(`oth${randomBytes(2).toString("hex")}`);
  teamA = await fx.team(`sma-${randomBytes(3).toString("hex")}`, runner, [other]);
  teamB = await fx.team(`smb-${randomBytes(3).toString("hex")}`, runner, [other]);
  await fx.activate(runner, teamA);
  await fx.activate(other, teamA);
  const s = (label: string) => `${label} ${WORD} statement`;
  item.team = await seed({ scope: "team", team: teamA, statement: s("Workspace fact") });
  item.mine = await seed({ scope: "user", team: teamA, owner: runner.id, statement: s("My fact") });
  item.theirs = await seed({
    scope: "user",
    team: teamA,
    owner: other.id,
    statement: s("Their fact"),
  });
  item.otherTeam = await seed({ scope: "team", team: teamB, statement: s("Other workspace fact") });
  item.mineInB = await seed({
    scope: "user",
    team: teamB,
    owner: runner.id,
    statement: s("Mine in B"),
  });
  item.portable = await seed({ scope: "portable", owner: runner.id, statement: s("My portable") });
  item.theirPortable = await seed({
    scope: "portable",
    owner: other.id,
    statement: s("Their portable"),
  });
  item.site = await seed({ scope: "site", statement: s("Site fact") });
  item.policy = await seed({ scope: "site", policy: true, statement: "Never share customer data" });
  item.pinned = await seed({
    scope: "team",
    team: teamA,
    pinned: true,
    statement: "Pinned note unrelated",
  });
  item.unrelated = await seed({ scope: "team", team: teamA, statement: "Nothing to do with it" });
});

afterAll(async () => {
  for (const s of sandboxes) s.close();
  await listener.close();
  await fx.teardown();
});

/** One item and its first version, written as the database owner (one transaction). */
async function seed(o: {
  scope: "user" | "team" | "portable" | "site";
  statement: string;
  team?: string;
  owner?: string;
  pinned?: boolean;
  policy?: boolean;
}): Promise<string> {
  const id = randomUUID();
  const actor = o.owner ?? runner.id;
  const kind = o.scope === "portable" ? "preference" : "fact";
  const pinned = o.pinned ?? false;
  await fx.admin.query("BEGIN");
  try {
    if (o.scope === "user" || o.scope === "team") {
      await fx.admin.query(
        `INSERT INTO semantic_memory_items (team_id, id, scope, owner_user_id, kind, pinned)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [o.team, id, o.scope, o.scope === "user" ? o.owner : null, kind, pinned],
      );
      await fx.admin.query(
        `INSERT INTO semantic_memory_item_versions (team_id, item_id, version, statement, actor_user_id, actor_kind)
         VALUES ($1, $2, 1, $3, $4, 'user')`,
        [o.team, id, o.statement, actor],
      );
    } else if (o.scope === "portable") {
      await fx.admin.query(
        `INSERT INTO portable_memory_items (id, owner_user_id, kind, pinned) VALUES ($1, $2, $3, $4)`,
        [id, o.owner, kind, pinned],
      );
      await fx.admin.query(
        `INSERT INTO portable_memory_item_versions (item_id, version, statement, actor_user_id, actor_kind)
         VALUES ($1, 1, $2, $3, 'user')`,
        [id, o.statement, o.owner],
      );
    } else {
      await fx.admin.query(
        `INSERT INTO site_memory_items (id, kind, pinned, policy) VALUES ($1, $2, $3, $4)`,
        [id, kind, pinned, o.policy ?? false],
      );
      await fx.admin.query(
        `INSERT INTO site_memory_item_versions (item_id, version, statement, actor_user_id, actor_kind)
         VALUES ($1, 1, $2, $3, 'user')`,
        [id, o.statement, actor],
      );
    }
    await fx.admin.query("COMMIT");
  } catch (err) {
    await fx.admin.query("ROLLBACK");
    throw err;
  }
  return id;
}

type Run = { threadId: string; runId: string };

async function newRun(
  team: string,
  who: Person = runner,
  thread: { isTest?: boolean; agentId?: string; agentVersion?: number | null } = {},
): Promise<Run> {
  return withTeam(fx.db, team, async (tx) => {
    const t = await tx.execute<{ id: string }>(sql`
      INSERT INTO threads (team_id, owner_user_id, status, is_test, agent_scope, agent_id, agent_version)
      VALUES (${team}, ${who.id}, 'running', ${thread.isTest ?? false},
              ${thread.agentId ? "team" : null}, ${thread.agentId ?? null}, ${thread.agentVersion ?? null})
      RETURNING id`);
    const threadId = must(t.rows[0], "thread").id;
    const r = await tx.execute<{ id: string }>(sql`
      INSERT INTO runs (team_id, thread_id, trigger, status, started_at, agent_version)
      VALUES (${team}, ${threadId}, 'user', 'running', now(), ${thread.agentVersion ?? null})
      RETURNING id`);
    return { threadId, runId: must(r.rows[0], "run").id };
  });
}

async function addRun(team: string, threadId: string) {
  return withTeam(fx.db, team, async (tx) => {
    const r = await tx.execute<{ id: string }>(sql`
      INSERT INTO runs (team_id, thread_id, trigger, status, started_at, agent_version)
      VALUES (${team}, ${threadId}, 'user', 'running', now(), NULL)
      RETURNING id`);
    return must(r.rows[0], "run").id;
  });
}

/** The `run.start.memory` a fresh sandbox of `who` receives for `run`. */
async function memoryOf(
  team: string,
  run: Run,
  opts: { who?: Person; caps?: string[]; message?: string; accept?: boolean } = {},
): Promise<RunMemoryContext | undefined> {
  const who = opts.who ?? runner;
  const sandboxId = randomUUID();
  const sb = await FakeSandbox.connect(
    listener.url,
    auth.issue({ sandboxId, teamId: team, userId: who.id }),
  );
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  try {
    return await startAndRead(sb, sandboxId, team, run, who, opts);
  } finally {
    sb.close();
  }
}

async function startAndRead(
  sb: FakeSandbox,
  sandboxId: string,
  team: string,
  run: Run,
  who: Person,
  opts: { caps?: string[]; message?: string; accept?: boolean },
): Promise<RunMemoryContext | undefined> {
  sb.hello(sandboxId, [], undefined, opts.caps ?? [CAPABILITY_MEMORY, CAPABILITY_SEMANTIC_MEMORY]);
  await sb.ready();
  // The fake answers every command (an accepted start); a refusal is answered here instead.
  if (opts.accept === false) {
    sb.respond = (f) => {
      if (f.type !== "run.start") return undefined;
      queueMicrotask(() =>
        sb.result(f.command_id, false, { code: "pi_rejected", message: "refused" }),
      );
      return null;
    };
  }
  const started = fx.replica(0).deps.sandboxWire.router.startRun(
    { teamId: team, userId: who.id },
    {
      runId: run.runId,
      threadId: run.threadId,
      message: opts.message ?? `Tell me about ${WORD}`,
    },
  );
  const start = (await sb.until(() => sb.frames("run.start")[0])) as {
    command_id: string;
    memory?: unknown;
  };
  const memory =
    start.memory === undefined ? undefined : runMemoryContextSchema.parse(start.memory);
  if (opts.accept === false) {
    // Refused: nothing may be recorded (L2).
    await started;
  } else {
    // Accepted (answered by the fake): the run's memories are recorded now (L2), never before.
    expect(await started).toEqual({ ok: true });
    const given = memory?.semantic?.items.length ?? 0;
    await vi.waitFor(async () => expect((await records(team, run.runId)).length).toBe(given), {
      timeout: 5_000,
    });
  }
  return memory;
}

/** Ends a run so the thread takes another (or can move). */
async function finish(run: Run) {
  await fx.admin.query(`UPDATE runs SET status = 'completed', ended_at = now() WHERE id = $1`, [
    run.runId,
  ]);
  await fx.admin.query(`UPDATE threads SET status = 'idle' WHERE id = $1`, [run.threadId]);
}

const idsOf = (m: RunMemoryContext | undefined) => (m?.semantic?.items ?? []).map((i) => i.id);

async function records(team: string, runId: string) {
  const res = await fx.admin.query<{ t: string; item_id: string; version: number }>(
    `SELECT 'w' AS t, item_id, version FROM run_memory_items WHERE team_id = $1 AND run_id = $2
     UNION ALL SELECT 'p', item_id, version FROM run_portable_memory_items WHERE team_id = $1 AND run_id = $2
     UNION ALL SELECT 's', item_id, version FROM run_site_memory_items WHERE team_id = $1 AND run_id = $2`,
    [team, runId],
  );
  return res.rows;
}

async function setWorkspace(team: string, memory: Record<string, boolean>) {
  await fx.admin.query(
    `UPDATE teams SET settings = jsonb_set(settings, '{memory}', $2::jsonb) WHERE id = $1`,
    [team, JSON.stringify(memory)],
  );
}

describe("run.start.memory.semantic (ac-1, ac-2)", () => {
  it("gives the runner's own, the Workspace's, Site and Policy items, Policy first, pinned next", async () => {
    const run = await newRun(teamA);
    const memory = await memoryOf(teamA, run);
    const ids = idsOf(memory);
    for (const k of ["team", "mine", "portable", "site", "policy", "pinned"])
      expect(ids).toContain(item[k]);
    expect(ids[0]).toBe(item.policy);
    expect(ids[1]).toBe(item.pinned);
    expect(ids).not.toContain(item.unrelated);
    expect(memory?.semantic?.omitted_count).toBe(0);
    // Every item the run was given is recorded, with its version, in the table of its scope.
    const rows = await records(teamA, run.runId);
    expect(rows.map((r) => r.item_id).sort()).toEqual([...ids].sort());
    expect(rows.find((r) => r.item_id === item.portable)?.t).toBe("p");
    expect(rows.find((r) => r.item_id === item.policy)?.t).toBe("s");
    expect(rows.find((r) => r.item_id === item.mine)?.t).toBe("w");
    expect(rows.every((r) => r.version === 1)).toBe(true);
  });

  it("never gives another person's personal or portable items, or another Workspace's", async () => {
    const ids = idsOf(await memoryOf(teamA, await newRun(teamA)));
    for (const k of ["theirs", "theirPortable", "otherTeam", "mineInB"])
      expect(ids).not.toContain(item[k]);
    // The other person's run in the same Workspace gets theirs, never the runner's.
    const theirs = idsOf(await memoryOf(teamA, await newRun(teamA, other), { who: other }));
    expect(theirs).toContain(item.theirs);
    expect(theirs).toContain(item.theirPortable);
    expect(theirs).not.toContain(item.mine);
    expect(theirs).not.toContain(item.portable);
    // In Workspace B the runner gets B's items and their portable ones.
    const inB = idsOf(await memoryOf(teamB, await newRun(teamB)));
    expect(inB).toEqual(expect.arrayContaining([item.otherTeam, item.mineInB, item.portable]));
    expect(inB).not.toContain(item.team);
    expect(inB).not.toContain(item.mine);
  });

  it("re-picks for each message of a thread", async () => {
    const run = await newRun(teamA);
    expect(idsOf(await memoryOf(teamA, run, { message: `about ${WORD}` }))).toContain(item.team);
    await finish(run);
    const next = { threadId: run.threadId, runId: await addRun(teamA, run.threadId) };
    const ids = idsOf(await memoryOf(teamA, next, { message: "lorem ipsum dolor" }));
    // Policy and pins stay; the per-message picks follow the new message: what the previous run
    // got is only a bonus for items that match again, never a reason on its own (M1).
    expect(ids.slice(0, 2)).toEqual([item.policy, item.pinned]);
    expect(ids).not.toContain(item.unrelated);
    for (const k of ["team", "mine", "site"]) expect(ids).not.toContain(item[k]);
    // Preferences are always candidates in the person lanes.
    expect(ids).toContain(item.portable);
  });

  it("gives a start delivered again exactly what was recorded, with no second set (L2)", async () => {
    const run = await newRun(teamA);
    const first = idsOf(await memoryOf(teamA, run));
    const input = { teamId: teamA, userId: runner.id, threadId: run.threadId, runId: run.runId };
    const again = await withTeam(fx.db, teamA, (tx) =>
      buildRunSemantic(tx, { ...input, message: "lorem ipsum dolor" }),
    );
    expect(again?.fresh).toBe(false);
    expect(again?.semantic.items.map((i) => i.id)).toEqual(first);
    expect((await records(teamA, run.runId)).length).toBe(first.length);
  });

  it("records nothing for a start the sandbox never accepted (L2)", async () => {
    const run = await newRun(teamA);
    expect(idsOf(await memoryOf(teamA, run, { accept: false }))).toContain(item.team);
    await new Promise((r) => setTimeout(r, 300));
    expect(await records(teamA, run.runId)).toEqual([]);
  });

  it("reads earlier messages on the run's branch only (L3)", async () => {
    const onPath = `kiwi${randomBytes(3).toString("hex")}`;
    const sibling = `mango${randomBytes(3).toString("hex")}`;
    const pathItem = await seed({ scope: "team", team: teamA, statement: `About ${onPath}` });
    const siblingItem = await seed({ scope: "team", team: teamA, statement: `About ${sibling}` });
    const run = await newRun(teamA);
    const user = (text: string) =>
      JSON.stringify({ message: { role: "user", content: [{ type: "text", text }] } });
    await fx.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload) VALUES
         ($1, $2, 'root', NULL, 'message', $3::jsonb),
         ($1, $2, 'side', 'root', 'message', $4::jsonb),
         ($1, $2, 'main', 'root', 'message', $5::jsonb)`,
      [teamA, run.threadId, user("hello"), user(`tell me ${sibling}`), user(`and ${onPath}`)],
    );
    await fx.admin.query(`UPDATE runs SET parent_entry_id = 'main' WHERE id = $1`, [run.runId]);
    // The selection itself (the wire would first restore this hand-made session into Pi).
    const built = await withTeam(fx.db, teamA, (tx) =>
      buildRunSemantic(tx, {
        teamId: teamA,
        userId: runner.id,
        threadId: run.threadId,
        runId: run.runId,
        message: "lorem ipsum dolor",
      }),
    );
    const ids = (built?.semantic.items ?? []).map((i) => i.id);
    expect(ids).toContain(pathItem);
    expect(ids).not.toContain(siblingItem);
  });

  it("falls back to Site Policy alone when the full build fails (L5)", async () => {
    const run = await newRun(teamA);
    const input = {
      teamId: teamA,
      userId: runner.id,
      threadId: run.threadId,
      runId: run.runId,
      message: `about ${WORD}`,
    };
    const policy = await withTeam(fx.db, teamA, (tx) => buildPolicyOnly(tx, input));
    expect(policy?.items.map((i) => i.id)).toEqual([item.policy]);
  });

  it("follows the switches: Site memories off keep Policy; Workspace memory off leaves Policy only", async () => {
    await setWorkspace(teamA, { site_memories_enabled: false });
    let ids = idsOf(await memoryOf(teamA, await newRun(teamA)));
    expect(ids).toContain(item.policy);
    expect(ids).not.toContain(item.site);
    expect(ids).toContain(item.team);
    await setWorkspace(teamA, {});
    await fx.admin.query(
      `INSERT INTO team_memory_settings (team_id, memory_enabled, project_memory_enabled, updated_by)
       VALUES ($1, false, true, $2)`,
      [teamA, runner.id],
    );
    try {
      const memory = await memoryOf(teamA, await newRun(teamA));
      expect(memory?.scopes).toEqual([]);
      ids = idsOf(memory);
      expect(ids).toEqual([item.policy]);
    } finally {
      await fx.admin.query(`DELETE FROM team_memory_settings WHERE team_id = $1`, [teamA]);
    }
    await fx.admin.query(
      `INSERT INTO site_settings (key, value) VALUES ('memory.enabled', 'false')
       ON CONFLICT (key) DO UPDATE SET value = 'false'`,
    );
    try {
      const memory = await memoryOf(teamA, await newRun(teamA));
      expect(memory?.semantic).toBeUndefined();
    } finally {
      await fx.admin.query(`DELETE FROM site_settings WHERE key = 'memory.enabled'`);
    }
  });
});

describe("exclusions (ac-3)", () => {
  it("sends no semantic block to an agent without semantic_memory", async () => {
    const run = await newRun(teamA);
    const memory = await memoryOf(teamA, run, { caps: [CAPABILITY_MEMORY] });
    expect(memory).toBeDefined();
    expect(memory?.semantic).toBeUndefined();
    expect(await records(teamA, run.runId)).toEqual([]);
  });

  it("sends none in a builder test chat", async () => {
    const agentId = await createAgent("Tester");
    const run = await newRun(teamA, runner, { isTest: true, agentId, agentVersion: null });
    const memory = await memoryOf(teamA, run);
    expect(memory).toBeDefined();
    expect(memory?.semantic).toBeUndefined();
    expect(await records(teamA, run.runId)).toEqual([]);
  });

  it("honours the agent version's memory setting with the runner's memory", async () => {
    const agentId = await createAgent("Setter");
    await publish(agentId);
    const all = await newRun(teamA, other, { agentId, agentVersion: 1 });
    const allIds = idsOf(await memoryOf(teamA, all, { who: other }));
    expect(allIds).toContain(item.theirs);
    expect(allIds).not.toContain(item.mine);
    const notes = await setMemory(agentId, "notes_only");
    const notesRun = await newRun(teamA, runner, { agentId, agentVersion: notes });
    const notesMemory = await memoryOf(teamA, notesRun);
    // Notes as before; of the memories only Site Policy (Chris 2026-11-13, Info 1).
    expect(notesMemory?.scopes).toEqual(["user"]);
    expect(idsOf(notesMemory)).toEqual([item.policy]);
    const off = await setMemory(agentId, "off");
    const offRun = await newRun(teamA, runner, { agentId, agentVersion: off });
    const offMemory = await memoryOf(teamA, offRun);
    expect(offMemory).toMatchObject({ scopes: [], indexes: [] });
    expect(idsOf(offMemory)).toEqual([item.policy]);
    expect((await records(teamA, offRun.runId)).map((r) => r.item_id)).toEqual([item.policy]);
  });
});

async function createAgent(name: string): Promise<string> {
  const res = await runner.browser.post("/v1/agents", {
    scope: "team",
    frontmatter: { name: `${name} ${randomBytes(2).toString("hex")}` },
    prompt: `You are ${name}.`,
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return (res.json as { agent: { id: string } }).agent.id;
}

async function publish(id: string) {
  const res = await runner.browser.request(
    "POST",
    `/v1/agents/${id}/publish`,
    {},
    { "if-match": "*" },
  );
  expect(res.status, JSON.stringify(res.json)).toBe(201);
}

async function setMemory(id: string, memory: string): Promise<number> {
  const res = await runner.browser.post(`/v1/agents/${id}/memory`, { memory });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return (res.json as { version: { version: number } }).version.version;
}

describe("GET /v1/threads/{id}/context/memories (ac-2, CV2)", () => {
  const url = (threadId: string) => `/v1/threads/${threadId}/context/memories`;

  it("shows the owner what the latest run was given, per lane, in render order", async () => {
    const run = await newRun(teamA);
    const given = idsOf(await memoryOf(teamA, run));
    const res = await runner.browser.get(url(run.threadId));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const body = threadContextMemoriesSchema.parse(res.json);
    expect(body).toMatchObject({ run_id: run.runId, latest: true });
    expect(body.items.map((i) => i.id)).toEqual(given);
    expect(body.items[0]).toMatchObject({ id: item.policy, lane: "policy" });
    expect(body.items.find((i) => i.id === item.portable)?.lane).toBe("portable");
    expect(body.items.find((i) => i.id === item.mine)?.lane).toBe("user");
  });

  it("shows the latest run with records, labelled, while a newer one is queued (L4)", async () => {
    const run = await newRun(teamA);
    const given = idsOf(await memoryOf(teamA, run));
    await finish(run);
    const queued = await addRun(teamA, run.threadId);
    const res = await runner.browser.get(url(run.threadId));
    const body = threadContextMemoriesSchema.parse(res.json);
    expect(body).toMatchObject({ run_id: run.runId, latest: false });
    expect(body.items.map((i) => i.id)).toEqual(given);
    expect(queued).not.toBe(run.runId);
  });

  it("answers an empty list before any run", async () => {
    const threadId = await withTeam(fx.db, teamA, async (tx) => {
      const t = await tx.execute<{ id: string }>(sql`
        INSERT INTO threads (team_id, owner_user_id, status) VALUES (${teamA}, ${runner.id}, 'idle')
        RETURNING id`);
      return must(t.rows[0], "thread").id;
    });
    const res = await runner.browser.get(url(threadId));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ thread_id: threadId, run_id: null, latest: true, items: [] });
  });

  it("refuses a shared reader (403 not_owner) and hides the thread from others (404)", async () => {
    const run = await newRun(teamA);
    await memoryOf(teamA, run);
    await finish(run);
    expect((await other.browser.get(url(run.threadId))).status).toBe(404);
    const project = await runner.browser.post("/v1/projects", {
      name: `P ${randomUUID().slice(0, 6)}`,
      member_user_ids: [other.id],
    });
    expect(project.status, JSON.stringify(project.json)).toBe(201);
    const moved = await runner.browser.post(`/v1/threads/${run.threadId}/move`, {
      project_id: (project.json as { id: string }).id,
    });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);
    const shared = await runner.browser.post(`/v1/threads/${run.threadId}/share`, {
      visibility: "project",
    });
    expect(shared.status, JSON.stringify(shared.json)).toBe(200);
    const res = await other.browser.get(url(run.threadId));
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "not_owner" });
  });
});
