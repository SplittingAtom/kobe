import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, withTeam } from "@kobe/db";
import {
  AGENT_MEMORY_SETTINGS,
  CAPABILITY_MEMORY,
  MEMORY_TOOLS,
  agentVersionMemoryFieldSchema,
  runMemoryContextSchema,
  type AgentMemorySetting,
  type PolicyEngine,
} from "@kobe/protocol";
import { readRunMemoryPlan } from "./agents/run-memory.js";
import { loadRunAgentTools } from "./policy/run-agent-tools.js";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";
import { MemoryObjects } from "./testing/memory-objects.js";

/**
 * KOBE-646 (v1.3 SMA14, Chris Q3): an agent version's memory setting, `all | notes_only | off`.
 * The agent editor's API republishes the current version with a new setting (a new version, so
 * pins and "follow latest" behave as for any version); run assembly gives the **runner's** memory
 * as the run's version says: `off` → no `run.start.memory` and the memory tools denied by the
 * agent's own deny list; `notes_only` → Notes as today (semantic memory comes with KOBE-382).
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const objects = new MemoryObjects();
const sandboxes: FakeSandbox[] = [];
let listener: Awaited<ReturnType<typeof sandboxListener>>;

const engine: PolicyEngine = {
  decide: () =>
    Promise.resolve({
      effect: "allow" as const,
      risk: "read" as const,
      reasons: [{ code: "team_allow_rule" as const, stage: "user_allow" as const, message: "ok" }],
    }),
};

let owner: Person;
let runner: Person;
let team: string;

beforeAll(async () => {
  await fx.setup([{}], () => ({
    blobs: { objects, prefix: "kobe/" },
    agents: { publishRate: { windowMs: 60_000, max: 10_000 } },
    sandboxWire: {
      engine,
      sweep: false,
      tuning: { batchWindowMs: 20, resultPollMs: 200, lostGraceMs: 0, helloTimeoutMs: 1_000 },
    },
  }));
  listener = await sandboxListener(fx.replica(0).deps, auth);
  owner = await fx.person(`own${randomBytes(2).toString("hex")}`);
  runner = await fx.person(`run${randomBytes(2).toString("hex")}`);
  team = await fx.team(`agm-${randomBytes(3).toString("hex")}`, owner, [runner]);
  // Each person's own Notes: the run must carry the runner's, never the agent owner's.
  for (const [who, content] of [
    [owner, "- owner notes"],
    [runner, "- runner notes"],
  ] as const) {
    const res = await who.browser.put("/v1/memory", { scope: "user", path: "MEMORY.md", content });
    expect(res.status, JSON.stringify(res.json)).toBeLessThan(300);
  }
});

afterAll(async () => {
  for (const s of sandboxes) s.close();
  await listener.close();
  await fx.teardown();
});

const json = (res: { json: unknown }) => JSON.stringify(res.json);

async function createAgent(name: string, scope: "team" | "personal" = "team"): Promise<string> {
  const res = await owner.browser.post("/v1/agents", {
    scope,
    frontmatter: { name },
    prompt: `You are ${name}.`,
  });
  expect(res.status, json(res)).toBe(201);
  return (res.json as { agent: { id: string } }).agent.id;
}

async function publish(id: string): Promise<number> {
  const res = await owner.browser.request(
    "POST",
    `/v1/agents/${id}/publish`,
    {},
    { "if-match": "*" },
  );
  expect(res.status, json(res)).toBe(201);
  return (res.json as { version: { version: number } }).version.version;
}

const setMemory = (id: string, memory: unknown, who: Person = owner) =>
  who.browser.post(`/v1/agents/${id}/memory`, { memory });

async function setMemoryOk(id: string, memory: AgentMemorySetting) {
  const res = await setMemory(id, memory);
  expect(res.status, json(res)).toBe(201);
  return (res.json as { version: { version: number; memory: string } }).version;
}

/** A run of `who` in a thread pinned to `version` of team agent `agentId` (null: a test chat). */
async function pinnedRun(agentId: string, version: number | null, who: Person = runner) {
  return withTeam(fx.db, team, async (tx) => {
    const thread = await tx.execute<{ id: string }>(
      sql`
        INSERT INTO threads (team_id, owner_user_id, status, agent_scope, agent_id, agent_version, is_test)
        VALUES (${team}, ${who.id}, 'running', 'team', ${agentId}, ${version}, ${version === null})
        RETURNING id`,
    );
    const threadId = must(thread.rows[0], "thread").id;
    const run = await tx.execute<{ id: string }>(
      sql`
        INSERT INTO runs (team_id, thread_id, trigger, status, started_at, agent_version)
        VALUES (${team}, ${threadId}, 'user', 'running', now(), ${version})
        RETURNING id`,
    );
    return { threadId, runId: must(run.rows[0], "run").id };
  });
}

async function runStart(run: { threadId: string; runId: string }, who: Person = runner) {
  const sandboxId = randomUUID();
  const sb = await FakeSandbox.connect(
    listener.url,
    auth.issue({ sandboxId, teamId: team, userId: who.id }),
  );
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(sandboxId, [], undefined, [CAPABILITY_MEMORY]);
  await sb.ready();
  const res = await fx
    .replica(0)
    .deps.sandboxWire.router.startRun(
      { teamId: team, userId: who.id },
      { runId: run.runId, threadId: run.threadId, message: "hi" },
    );
  expect(res).toEqual({ ok: true });
  const start = await sb.until(() => sb.frames("run.start")[0]);
  sb.close();
  return start as { memory?: unknown };
}

const plan = (runId: string) =>
  withTeam(fx.db, team, (tx) => readRunMemoryPlan(tx, { teamId: team, runId }));
const deny = (runId: string) =>
  withTeam(fx.db, team, (tx) => loadRunAgentTools(tx, { teamId: team, runId }));

describe("agent version memory setting over the API (ac-2)", () => {
  it("publishes v1 with all; a change republishes the current version as a new one, audited", async () => {
    const id = await createAgent("Keeper");
    expect(await publish(id)).toBe(1);
    const v2 = await setMemoryOk(id, "notes_only");
    expect(v2).toMatchObject({
      version: 2,
      memory: "notes_only",
      republishedFrom: 1,
      draftRevision: null,
      prompt: "You are Keeper.",
    });
    // The API's field is the contract's (KOBE-377).
    expect(agentVersionMemoryFieldSchema.parse({ memory: v2.memory })).toEqual({
      memory: "notes_only",
    });
    const list = await owner.browser.get(`/v1/agents/${id}/versions`);
    expect(
      (list.json as { versions: { version: number; memory: string }[] }).versions.map((v) => [
        v.version,
        v.memory,
      ]),
    ).toEqual([
      [2, "notes_only"],
      [1, "all"],
    ]);
    const { rows } = await fx.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE action = 'agent.memory_changed' AND target->>'agentId' = $1`,
      [id],
    );
    expect(rows.map((r) => r.target)).toEqual([
      {
        agentId: id,
        scope: "team",
        slug: "keeper",
        version: 2,
        fromVersion: 1,
        memory: "notes_only",
      },
    ]);
  });

  it("a publish from the draft keeps the setting; a rollback restores the version's own", async () => {
    const id = await createAgent("Carrier");
    await publish(id);
    await setMemoryOk(id, "off");
    const edited = await owner.browser.put(
      `/v1/agents/${id}`,
      { frontmatter: { name: "Carrier" }, prompt: "Changed." },
      { "if-match": "*" },
    );
    expect(edited.status, json(edited)).toBe(200);
    expect(await publish(id)).toBe(3);
    const v3 = await owner.browser.get(`/v1/agents/${id}/versions/3`);
    expect(v3.json).toMatchObject({ version: { memory: "off", prompt: "Changed." } });
    const rolled = await owner.browser.post(`/v1/agents/${id}/rollback`, { version: 1 });
    expect(rolled.status, json(rolled)).toBe(201);
    expect(rolled.json).toMatchObject({ version: { version: 4, memory: "all" } });
  });

  it("refuses the same setting, a bad value, an unpublished agent and a member without publish rights", async () => {
    const id = await createAgent("Picky");
    expect((await setMemory(id, "off")).json).toMatchObject({ code: "not_published" });
    await publish(id);
    const same = await setMemory(id, "all");
    expect(same.status).toBe(409);
    expect(same.json).toMatchObject({ code: "unchanged" });
    for (const bad of ["semantic_only", null, 1])
      expect((await setMemory(id, bad)).status).toBe(400);
    // The runner is a plain member: may not publish the owner's team agent.
    expect((await setMemory(id, "off", runner)).status).toBe(403);
  });

  it("works for personal agents too", async () => {
    const id = await createAgent("Mine", "personal");
    await publish(id);
    expect(await setMemoryOk(id, "off")).toMatchObject({ version: 2, memory: "off" });
  });
});

describe("run assembly uses the runner's memory as the version says (ac-3)", () => {
  let agentId: string;
  const versions = {} as Record<AgentMemorySetting, number>;

  beforeAll(async () => {
    agentId = await createAgent("Runner");
    versions.all = await publish(agentId);
    versions.notes_only = (await setMemoryOk(agentId, "notes_only")).version;
    versions.off = (await setMemoryOk(agentId, "off")).version;
  });

  it.each(AGENT_MEMORY_SETTINGS)("%s", async (setting) => {
    const run = await pinnedRun(agentId, versions[setting]);
    const resolved = await plan(run.runId);
    expect(resolved).toEqual({
      setting,
      notes: setting !== "off",
      semantic: setting === "all",
    });
    const start = await runStart(run);
    const tools = (await deny(run.runId)).toolsDeny;
    if (setting === "off") {
      expect(start).not.toHaveProperty("memory");
      for (const tool of MEMORY_TOOLS) expect(tools).toContain(tool);
    } else {
      // The runner's Notes, never the agent owner's.
      expect(runMemoryContextSchema.parse(start.memory)).toMatchObject({
        scopes: ["user"],
        indexes: [{ scope: "user", content: "- runner notes" }],
      });
      for (const tool of MEMORY_TOOLS) expect(tools).not.toContain(tool);
    }
  });

  it("a test chat runs with the current version's setting and never gets semantic memory", async () => {
    // The agent's current version is `off`.
    const run = await pinnedRun(agentId, null);
    expect(await plan(run.runId)).toEqual({ setting: "off", notes: false, semantic: false });
    expect((await deny(run.runId)).toolsDeny).toEqual(expect.arrayContaining([...MEMORY_TOOLS]));
    const fresh = await createAgent("Fresh");
    const unpublished = await pinnedRun(fresh, null);
    expect(await plan(unpublished.runId)).toEqual({ setting: "all", notes: true, semantic: false });
  });

  it("a thread without an agent is all", async () => {
    const runId = await fx.run(team, runner);
    expect(await plan(runId)).toEqual({ setting: "all", notes: true, semantic: true });
  });
});
