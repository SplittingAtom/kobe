import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, withTeam, type AgentScope } from "@kobe/db";
import { skillUsageQuery } from "./skills/usage.js";
import { PINNED_AGENTS } from "./runs/agents.js";
import { RunFixture, type FakeWorkspace, type RunStart } from "./testing/run-fixture.js";
import type { Person } from "./testing/event-stream-fixture.js";
import { must } from "./testing/event-stream-fixture.js";

/**
 * KOBE-297: the server records a skill use when the run reads one of its own skills' SKILL.md
 * (ac-1), and a team skill set to "Offer to all agents" reaches every non-exclusive agent's runs in
 * that team only (ac-2).
 */
const f = new RunFixture();
const ANY = { "if-match": "*" };

beforeAll(async () => {
  await f.setup();
});
afterAll(async () => {
  await f.teardown();
});

type World = Awaited<ReturnType<typeof f.world>>;

const hashOf = (slug: string, version = 1) =>
  createHash("sha256").update(`${slug}:${version}`).digest("hex");

async function catalog(team: string, ownerId: string) {
  const admin = f.fx.admin;
  await admin.query(
    `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
     VALUES ('openai', 'openai', 'openai', 'v2.test.sealed-provider-key', $1) ON CONFLICT (id) DO NOTHING`,
    [ownerId],
  );
  await admin.query(
    `INSERT INTO model_catalog (alias, provider_id, model, created_by)
     VALUES ('fast', 'openai', 'fast-fake', $1) ON CONFLICT (alias) DO NOTHING`,
    [ownerId],
  );
  await admin.query(
    `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, 'fast', true, $2)`,
    [team, ownerId],
  );
}

/** A team skill with one version per status; returns its id. */
async function seedTeamSkill(
  team: string,
  ownerId: string,
  slug: string,
  statuses: readonly ("pending" | "approved")[] = ["approved"],
  offerToAll = false,
): Promise<string> {
  const admin = f.fx.admin;
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO team_skills (team_id, owner_user_id, slug, description, latest_version, offer_to_all)
     VALUES ($1, $2, $3, 'd', $4, $5) RETURNING id`,
    [team, ownerId, slug, statuses.length, offerToAll],
  );
  const skillId = must(rows[0], "skill").id;
  for (const [i, status] of statuses.entries()) {
    const hash = hashOf(`${team}:${slug}`, i + 1);
    await admin.query(
      `INSERT INTO team_skill_versions (team_id, skill_id, version, frontmatter, source, content_hash,
         storage_key, size_bytes, file_count, uncompressed_bytes, uploaded_by)
       VALUES ($1, $2, $3, '{}', 'zip', $4, 'k', 1, 1, 1, $5)`,
      [team, skillId, i + 1, hash, ownerId],
    );
    await admin.query(
      `INSERT INTO team_skill_reviews (team_id, skill_id, version, scope, slug, content_hash, status,
         flagged, findings, scripts, skipped, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, 'team', $4, $5, $6, false, '[]', '[]', '[]', $7, $8)`,
      [
        team,
        skillId,
        i + 1,
        slug,
        hash,
        status,
        status === "pending" ? null : ownerId,
        status === "pending" ? null : new Date(),
      ],
    );
  }
  return skillId;
}

/** Publishes an agent of `p` with `frontmatter`; returns its id. */
async function publishAgent(p: Person, frontmatter: Record<string, unknown>): Promise<string> {
  const b = f.on(0, p);
  const created = await b.post("/v1/agents", {
    scope: "team",
    frontmatter: { name: `Agent ${randomBytes(2).toString("hex")}`, ...frontmatter },
    prompt: "You help.",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  const pub = await b.request("POST", `/v1/agents/${id}/publish`, {}, ANY);
  expect(pub.status, JSON.stringify(pub.json)).toBe(201);
  return id;
}

async function threadWith(p: Person, agentId: string): Promise<string> {
  const thread = await f.on(0, p).post("/v1/threads", { agent_id: agentId });
  expect(thread.status, JSON.stringify(thread.json)).toBe(201);
  return thread.json.thread_id as string;
}

/** Starts a run; returns the run.start frame and the sandbox. */
async function start(w: World, thread: string, ws?: FakeWorkspace) {
  const sandbox = ws ?? (await f.connect(w, 0));
  const run = await f.message(w.owner, thread, "hello");
  return { run, ws: sandbox, frame: await sandbox.started(run) };
}

function readCall(ws: FakeWorkspace, s: RunStart, id: string, path: string, isError = false) {
  ws.event(s, { type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path } });
  ws.event(s, {
    type: "tool_execution_end",
    toolCallId: id,
    toolName: "read",
    isError,
    result: { content: [{ type: "text", text: isError ? "ENOENT" : "# Skill" }] },
  });
}

async function skillsUsed(team: string, runId: string) {
  const { rows } = await f.fx.admin.query<{ used: unknown[]; refs: unknown[] }>(
    `SELECT skills_used AS used, skill_refs AS refs FROM runs WHERE team_id = $1 AND id = $2`,
    [team, runId],
  );
  return must(rows[0], "run");
}

const storePath = (hash: string) => `/run/kobe-skills/store/sk-${hash}/SKILL.md`;

describe("ac-1: the server records a skill use from the run's own SKILL.md read", () => {
  it("counts the run's skill, not a forged hash, a workspace SKILL.md or a failed read", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id);
    await seedTeamSkill(w.team, w.owner.id, "pretty-html");
    const other = await seedTeamSkill(w.team, w.owner.id, "not-given");
    expect(other).toBeTruthy();
    const agent = await publishAgent(w.owner, { skills: ["pretty-html"] });
    const thread = await threadWith(w.owner, agent);
    const { run, ws, frame } = await start(w, thread);
    const given = hashOf(`${w.team}:pretty-html`);
    expect(frame.config?.skill_bundles?.map((b) => b.sha256)).toEqual([given]);
    expect((await skillsUsed(w.team, run)).refs).toEqual([
      { name: "pretty-html", source: "team", sha256: given },
    ]);

    readCall(ws, frame, "forged", storePath(hashOf(`${w.team}:not-given`)));
    readCall(ws, frame, "workspace", "/workspace/pretty-html/SKILL.md");
    readCall(ws, frame, "failed", storePath(given), true);
    readCall(ws, frame, "real", storePath(given));
    ws.reply(frame, "done");
    await f.until(w.team, run, "completed");
    expect((await skillsUsed(w.team, run)).used).toEqual([
      { tool_call_id: "real", name: "pretty-html", source: "team" },
    ]);

    // After a reload: the markers carry the use with the run's prompt entry.
    const markers = await f.on(0, w.owner).get(`/v1/threads/${thread}/markers`);
    expect(markers.status).toBe(200);
    const { user_entry_id } = await f.run(w.team, run);
    expect(markers.json.skills).toEqual([
      {
        run_id: run,
        user_entry_id,
        tool_call_id: "real",
        name: "pretty-html",
        source: "team",
      },
    ]);
  });

  it("matches a successful result whose call came in an earlier batch", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id);
    await seedTeamSkill(w.team, w.owner.id, "slow-skill");
    const thread = await threadWith(
      w.owner,
      await publishAgent(w.owner, { skills: ["slow-skill"] }),
    );
    const { run, ws, frame } = await start(w, thread);
    const path = storePath(hashOf(`${w.team}:slow-skill`));
    ws.event(frame, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "read",
      args: { path },
    });
    await ws.acked(run);
    ws.event(frame, {
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "read",
      isError: false,
      result: { content: [{ type: "text", text: "ok" }] },
    });
    ws.reply(frame, "done");
    await f.until(w.team, run, "completed");
    expect((await skillsUsed(w.team, run)).used).toEqual([
      { tool_call_id: "t1", name: "slow-skill", source: "team" },
    ]);
  });

  it("shows per-skill usage to the skill's owner and team admins only", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id);
    const builder = await f.member(w.team);
    const bystander = await f.member(w.team);
    const skillId = await seedTeamSkill(w.team, builder.id, "counted");
    const agent = await publishAgent(w.owner, { name: "Counter", skills: ["counted"] });
    const thread = await threadWith(w.owner, agent);
    const { run, ws, frame } = await start(w, thread);
    readCall(ws, frame, "a", storePath(hashOf(`${w.team}:counted`)));
    readCall(ws, frame, "b", storePath(hashOf(`${w.team}:counted`)));
    ws.reply(frame, "done");
    await f.until(w.team, run, "completed");

    for (const p of [w.owner, builder]) {
      const usage = await f.on(0, p).get(`/v1/skills/${skillId}/usage`);
      expect(usage.status, JSON.stringify(usage.json)).toBe(200);
      expect(usage.json).toMatchObject({
        uses: 2,
        agents: [{ agentId: agent, scope: "team", name: "Counter", uses: 2 }],
      });
      expect(typeof usage.json.lastUsedAt).toBe("string");
    }
    expect((await f.on(0, bystander).get(`/v1/skills/${skillId}/usage`)).status).toBe(403);
  });
});

describe("ac-2: Offer to all agents", () => {
  /** The skill names a run of `thread` is started with (the run is then completed). */
  async function skillsOf(w: World, thread: string): Promise<string[]> {
    const { run, ws, frame } = await start(w, thread);
    ws.reply(frame, "ok");
    await f.until(w.team, run, "completed");
    ws.kill();
    return [...(frame.config?.skills ?? [])].sort();
  }

  it("reaches every non-exclusive agent of the team, approved versions only, blocklist respected", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id);
    await seedTeamSkill(w.team, w.owner.id, "house-style", ["approved"], true);
    await seedTeamSkill(w.team, w.owner.id, "unreviewed", ["pending"], true);
    await seedTeamSkill(w.team, w.owner.id, "blocked", ["approved"], true);
    await seedTeamSkill(w.team, w.owner.id, "not-offered", ["approved"], false);
    await f.fx.admin.query(
      `INSERT INTO skill_blocklist (content_hash, reason, added_by) VALUES ($1, 'malware', $2)`,
      [hashOf(`${w.team}:blocked`), w.owner.id],
    );
    const plain = await threadWith(w.owner, await publishAgent(w.owner, {}));
    expect(await skillsOf(w, plain)).toEqual(["house-style"]);
    // Named and offered: listed once.
    const named = await threadWith(
      w.owner,
      await publishAgent(w.owner, { skills: ["house-style"] }),
    );
    expect(await skillsOf(w, named)).toEqual(["house-style"]);
    const exclusive = await threadWith(
      w.owner,
      await publishAgent(w.owner, { skills: { exclusive: ["not-offered"] } }),
    );
    expect(await skillsOf(w, exclusive)).toEqual(["not-offered"]);
  });

  it("never reaches another team, even one with a skill of the same name", async () => {
    const w = await f.world();
    const other = await f.world();
    await catalog(w.team, w.owner.id);
    await catalog(other.team, other.owner.id);
    const skillId = await seedTeamSkill(w.team, w.owner.id, "shared-name", ["approved"], true);
    await seedTeamSkill(other.team, other.owner.id, "shared-name", ["approved"], false);
    const thread = await threadWith(other.owner, await publishAgent(other.owner, {}));
    expect(await skillsOf(other, thread)).toEqual([]);
    // The other team's admin can neither see nor switch the first team's skill.
    const b = f.on(0, other.owner);
    expect((await b.get(`/v1/skills/${skillId}/reach`)).status).toBe(404);
    expect((await b.get(`/v1/skills/${skillId}/usage`)).status).toBe(404);
    expect(
      (await b.request("PUT", `/v1/skills/${skillId}/offer`, { offerToAll: false })).status,
    ).toBe(404);
  });

  it("applies to scheduled runs: the resolver is the same for every trigger", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id);
    await seedTeamSkill(w.team, w.owner.id, "nightly", ["approved"], true);
    const agentId = await publishAgent(w.owner, {});
    const thread = await threadWith(w.owner, agentId);
    const { rows } = await f.fx.admin.query<{ agent_scope: AgentScope; agent_version: number }>(
      `SELECT agent_scope, agent_version FROM threads WHERE team_id = $1 AND id = $2`,
      [w.team, thread],
    );
    const pin = must(rows[0], "thread");
    const resolved = await withTeam(f.fx.db, w.team, (tx) =>
      PINNED_AGENTS.resolve(tx, {
        teamId: w.team,
        ownerUserId: w.owner.id,
        threadId: thread,
        runId: "00000000-0000-4000-8000-000000000001",
        trigger: "schedule",
        agentScope: pin.agent_scope,
        agentId,
        agentVersion: pin.agent_version,
        approvalMode: "auto",
      }),
    );
    expect(resolved.ok && resolved.config?.skills).toEqual(["nightly"]);
    expect(resolved.ok && resolved.skillRefs).toEqual([
      { name: "nightly", source: "team", sha256: hashOf(`${w.team}:nightly`) },
    ]);
  });

  it("team admins switch it (audited); the skill page lists the agents it reaches", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id);
    const member = await f.member(w.team);
    const skillId = await seedTeamSkill(w.team, w.owner.id, "reachy");
    const named = await publishAgent(w.owner, { name: "Named", skills: ["reachy"] });
    const plain = await publishAgent(w.owner, { name: "Plain" });
    const exclusive = await publishAgent(w.owner, { name: "Solo", skills: "exclusive" });

    const refused = await f.on(0, member).request("PUT", `/v1/skills/${skillId}/offer`, {
      offerToAll: true,
    });
    expect(refused.status).toBe(403);
    const before = await f.on(0, w.owner).get(`/v1/skills/${skillId}/reach`);
    expect(before.status, JSON.stringify(before.json)).toBe(200);
    const via = (json: { agents: { id: string; via: string | null }[] }) =>
      Object.fromEntries(
        json.agents
          .filter((a) => [named, plain, exclusive].includes(a.id))
          .map((a) => [a.id, a.via]),
      );
    expect(before.json).toMatchObject({ offerToAll: false, approved: true });
    expect(via(before.json)).toEqual({ [named]: "named", [plain]: null, [exclusive]: null });

    const on = await f.on(0, w.owner).request("PUT", `/v1/skills/${skillId}/offer`, {
      offerToAll: true,
    });
    expect(on.status, JSON.stringify(on.json)).toBe(200);
    expect(on.json).toEqual({ offerToAll: true });
    const after = await f.on(0, w.owner).get(`/v1/skills/${skillId}/reach`);
    expect(via(after.json)).toEqual({ [named]: "named", [plain]: "offer", [exclusive]: null });
    // The owner may edit all three team agents; a member none.
    expect(
      after.json.agents.filter((a: { canEdit: boolean; scope: string }) => a.canEdit).length,
    ).toBe(3);
    const asMember = await f.on(0, member).get(`/v1/skills/${skillId}/reach`);
    expect(asMember.json.agents.some((a: { canEdit: boolean }) => a.canEdit)).toBe(false);
    expect(await f.auditActions(w.team)).toContain("skill.offer.changed");
  });

  it("a member without builder rights sees published names only, never drafts or exclusivity", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id);
    const member = await f.member(w.team);
    const skillId = await seedTeamSkill(w.team, w.owner.id, "private-detail");
    const named = await publishAgent(w.owner, { name: "Named", skills: ["private-detail"] });
    const solo = await publishAgent(w.owner, { name: "Solo", skills: "exclusive" });
    // A draft that was never published, naming the skill.
    const draft = await f.on(0, w.owner).post("/v1/agents", {
      scope: "team",
      frontmatter: { name: "Secret draft", skills: ["private-detail"] },
      prompt: "x",
    });
    expect(draft.status).toBe(201);
    type Row = { id: string; via: string | null; exclusive: boolean; inDraft: boolean };
    const seen = async () =>
      ((await f.on(0, member).get(`/v1/skills/${skillId}/reach`)).json.agents as Row[]).filter(
        (a) => a.id !== undefined,
      );
    const off = await seen();
    expect(off.map((a) => a.id)).not.toContain(draft.json.agent.id);
    expect(off.find((a) => a.id === named)).toMatchObject({ via: null, inDraft: false });
    expect(off.some((a) => a.exclusive || a.inDraft || a.via === "named")).toBe(false);
    await f.on(0, w.owner).request("PUT", `/v1/skills/${skillId}/offer`, { offerToAll: true });
    const on = await seen();
    expect(on.find((a) => a.id === named)?.via).toBe("offer");
    expect(on.find((a) => a.id === solo)?.via).toBeNull();
    // The admin (a builder) still sees the draft and how each agent names it.
    const admin = (await f.on(0, w.owner).get(`/v1/skills/${skillId}/reach`)).json.agents as Row[];
    expect(admin.find((a) => a.id === draft.json.agent.id)).toMatchObject({ inDraft: true });
    expect(admin.find((a) => a.id === named)?.via).toBe("named");
  });

  it("refuses to offer more than 32 skills in a team, and turning one off makes room", async () => {
    const w = await f.world();
    const ids: string[] = [];
    for (let i = 0; i < 33; i += 1) {
      ids.push(await seedTeamSkill(w.team, w.owner.id, `cap-${String(i).padStart(2, "0")}`));
    }
    const put = (id: string, offerToAll: boolean) =>
      f.on(0, w.owner).request("PUT", `/v1/skills/${id}/offer`, { offerToAll });
    for (const id of ids.slice(0, 32)) expect((await put(id, true)).status).toBe(200);
    const refused = await put(must(ids[32], "33rd"), true);
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ code: "offer_limit" });
    expect(refused.json.message).toMatch(/at most 32/);
    expect((await put(must(ids[0], "first"), false)).status).toBe(200);
    expect((await put(must(ids[32], "33rd"), true)).status).toBe(200);
  });

  it("H1: a run over the run.start cap starts with 64 skills; the rest are skill_limit omissions", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id);
    const named = Array.from({ length: 32 }, (_, i) => `named-${String(i).padStart(2, "0")}`);
    const offered = Array.from({ length: 33 }, (_, i) => `offered-${String(i).padStart(2, "0")}`);
    for (const slug of named) await seedTeamSkill(w.team, w.owner.id, slug);
    // 33 offered: one past the route's cap, set directly to test the resolver's own cap.
    for (const slug of offered) await seedTeamSkill(w.team, w.owner.id, slug, ["approved"], true);
    const thread = await threadWith(w.owner, await publishAgent(w.owner, { skills: named }));
    const { run, ws, frame } = await start(w, thread);
    expect(frame.config?.skills).toHaveLength(64);
    expect(frame.config?.skill_bundles).toHaveLength(64);
    expect(frame.config?.skills?.slice(0, 32)).toEqual(named);
    ws.reply(frame, "ok");
    await f.until(w.team, run, "completed");
    const omitted = (await f.events(w.team, run)).find((e) => e.type === "context.omitted");
    expect(omitted?.payload).toEqual({
      items: [{ kind: "skill", name: "offered-32", reason: "skill_limit" }],
    });
  });

  it("M1: the usage read uses runs_skill_uses_idx for the app role under RLS", async () => {
    const w = await f.world();
    // A team with many threads and runs, few of which used a skill: the shape the index is for.
    await f.fx.admin.query(
      `INSERT INTO threads (team_id, id, owner_user_id, title)
       SELECT $1, gen_random_uuid(), $2, 't' FROM generate_series(1, 500)`,
      [w.team, w.owner.id],
    );
    await f.fx.admin.query(
      `INSERT INTO runs (team_id, thread_id, trigger, status, started_at, ended_at, skills_used)
       SELECT t.team_id, t.id, 'user', 'completed', now(), now(),
              CASE WHEN g = 1 AND random() < 0.05
                   THEN '[{"tool_call_id":"t","name":"x","source":"team"}]'::jsonb
                   ELSE '[]'::jsonb END
         FROM threads t CROSS JOIN generate_series(1, 20) g
        WHERE t.team_id = $1`,
      [w.team],
    );
    await f.fx.admin.query(`ANALYZE runs; ANALYZE threads`);
    const plan = await withTeam(f.fx.db, w.team, async (tx) => {
      const res = await tx.execute<{ "QUERY PLAN": string }>(
        sql`EXPLAIN ${skillUsageQuery(w.team, { source: "team", name: "x" })}`,
      );
      return res.rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    console.info(`usage plan:\n${plan}`);
    expect(plan).toMatch(
      /Index Scan using runs_skill_uses_idx on runs r|Bitmap Index Scan on runs_skill_uses_idx/,
    );
    expect(plan).toMatch(/Index Cond: \(\(team_id = .*\) AND \(created_at > /s);
  });
});
