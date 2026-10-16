import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam, type AgentScope } from "@kobe/db";
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
});
