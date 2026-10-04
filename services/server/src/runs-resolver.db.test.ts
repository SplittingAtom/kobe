import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { PINNED_AGENTS } from "./runs/agents.js";
import { RunFixture } from "./testing/run-fixture.js";
import type { Person } from "./testing/event-stream-fixture.js";

/**
 * KOBE-76: run start gathers the resolver's inputs inside `withTeam()` and the run uses what
 * `resolveEffective` returns (model, approval mode, connectors), through a real published agent.
 */
const f = new RunFixture();
const ANY = { "if-match": "*" };

beforeAll(async () => {
  await f.setup();
});
afterAll(async () => {
  await f.teardown();
});

async function catalog(team: string, ownerId: string, enabled: [string, boolean][]) {
  const admin = f.fx.admin;
  await admin.query(
    `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
     VALUES ('openai', 'openai', 'openai', 'v2.test.sealed-provider-key', $1) ON CONFLICT (id) DO NOTHING`,
    [ownerId],
  );
  for (const alias of ["fast", "smart"]) {
    await admin.query(
      `INSERT INTO model_catalog (alias, provider_id, model, created_by)
       VALUES ($1, 'openai', $2, $3) ON CONFLICT (alias) DO NOTHING`,
      [alias, `${alias}-fake`, ownerId],
    );
  }
  for (const [alias, isDefault] of enabled) {
    await admin.query(
      `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, $2, $3, $4)`,
      [team, alias, isDefault, ownerId],
    );
  }
}

/** Publishes a team agent with `frontmatter` and returns a thread of `p` pinned to it. */
async function pinnedThread(p: Person, frontmatter: Record<string, unknown>) {
  const b = f.on(0, p);
  const created = await b.post("/v1/agents", {
    scope: "team",
    frontmatter: { name: "Resolved", ...frontmatter },
    prompt: "You are resolved.",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  const pub = await b.request("POST", `/v1/agents/${id}/publish`, {}, ANY);
  expect(pub.status, JSON.stringify(pub.json)).toBe(201);
  const thread = await b.post("/v1/threads", { agent_id: id });
  expect(thread.status, JSON.stringify(thread.json)).toBe(201);
  return thread.json.thread_id as string;
}

async function enableConnector(team: string, ownerId: string, name: string) {
  const { rows } = await f.fx.admin.query<{ id: string }>(
    `INSERT INTO connectors (name, url) VALUES ($1, 'https://mcp.example/x') RETURNING id`,
    [name],
  );
  await f.fx.admin.query(
    `INSERT INTO team_connectors (team_id, connector_id, enabled_by) VALUES ($1, $2, $3)`,
    [team, rows[0]?.id, ownerId],
  );
}

describe("run start uses the resolver (KOBE-76)", () => {
  it("ac-1: the run uses the resolved model and approval mode", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id, [
      ["fast", true],
      ["smart", false],
    ]);
    const ws = await f.connect(w, 0);
    const pinned = await pinnedThread(w.owner, { model: "smart", approval_mode: "ask-all" });
    const run = await f.message(w.owner, pinned, "hello");
    const start = await ws.started(run);
    expect(start.config).toMatchObject({
      model: { alias: "smart", gateway_model: "openai/smart-fake" },
      approval_mode: "ask-all",
    });
    expect((await f.run(w.team, run)).approval_mode).toBe("ask-all");
    ws.reply(start, "ok");
    await f.until(w.team, run, "completed");

    // No pin: the team default and the agent default mode (ask-on-write).
    const plain = await pinnedThread(w.owner, {});
    const second = await f.message(w.owner, plain, "again");
    const start2 = await ws.started(second);
    expect(start2.config).toMatchObject({
      model: { alias: "fast" },
      approval_mode: "ask-on-write",
    });
    ws.reply(start2, "ok");
    await f.until(w.team, second, "completed");
  });

  it("ac-2: a pinned alias the team did not enable fails the run with the agreed error", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id, [["fast", true]]);
    const ws = await f.connect(w, 0);
    const thread = await pinnedThread(w.owner, { model: "smart" });
    const run = await f.message(w.owner, thread, "hello");
    await f.until(w.team, run, "failed");
    expect((await f.events(w.team, run)).at(-1)?.payload).toEqual({
      error: {
        code: "agent_model_not_enabled",
        message:
          "This agent's model (smart) isn't enabled for your team. Ask your team admin to enable it.",
      },
    });
    expect(ws.starts().map((s) => s.run_id)).not.toContain(run);
  });

  it("returns omissions: a team-enabled connector the user has not connected is left out", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id, [["fast", true]]);
    const name = `gh-${randomBytes(3).toString("hex")}`;
    await enableConnector(w.team, w.owner.id, name);
    const thread = await pinnedThread(w.owner, { connectors: [name, "unlisted"] });
    const db = f.fx.replica(0).deps.database.db;
    const res = await withTeam(db, w.team, async (tx) => {
      const { rows } = await tx.execute<{ agent_scope: string; agent_id: string; v: number }>(
        `SELECT agent_scope, agent_id, agent_version AS v FROM threads WHERE id = '${thread}'`,
      );
      const t = rows[0];
      if (t === undefined) throw new Error("thread row missing");
      return PINNED_AGENTS.resolve(tx, {
        teamId: w.team,
        ownerUserId: w.owner.id,
        threadId: thread,
        runId: "00000000-0000-4000-8000-000000000000",
        trigger: "user",
        agentScope: t.agent_scope as "team",
        agentId: t.agent_id,
        agentVersion: t.v,
        approvalMode: "auto",
      });
    });
    expect(res.ok && res.omissions).toEqual([
      { kind: "connector", name, reason: "not_user_connected" },
      { kind: "connector", name: "unlisted", reason: "not_team_enabled" },
    ]);
    expect(res.ok && res.config?.mcp_servers).toBeUndefined();
  });

  it("KOBE-77: omissions are a context.omitted event right after run.started; none, no event", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id, [["fast", true]]);
    const ws = await f.connect(w, 0);
    const thread = await pinnedThread(w.owner, { connectors: ["unlisted"] });
    const run = await f.message(w.owner, thread, "hello");
    const start = await ws.started(run);
    ws.reply(start, "ok");
    await f.until(w.team, run, "completed");
    const types = (await f.events(w.team, run)).map((e) => e.type);
    const at = types.indexOf("run.started");
    expect(types[at + 1]).toBe("context.omitted");
    expect(types.filter((t) => t === "context.omitted")).toHaveLength(1);
    const event = (await f.events(w.team, run)).find((e) => e.type === "context.omitted");
    expect(event?.payload).toEqual({
      items: [{ kind: "connector", name: "unlisted", reason: "not_team_enabled" }],
    });

    const plain = await pinnedThread(w.owner, {});
    const second = await f.message(w.owner, plain, "again");
    ws.reply(await ws.started(second), "ok");
    await f.until(w.team, second, "completed");
    expect((await f.events(w.team, second)).map((e) => e.type)).not.toContain("context.omitted");
  });

  it("a pinned agent ignores the thread's chosen model; an unpinned one uses it over the default", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id, [
      ["fast", true],
      ["smart", false],
    ]);
    const ws = await f.connect(w, 0);
    const choose = (thread: string, alias: string) =>
      f.fx.admin.query(`UPDATE threads SET model_alias = $2 WHERE id = $1`, [thread, alias]);

    const pinned = await pinnedThread(w.owner, { model: "fast" });
    await choose(pinned, "smart");
    const run = await f.message(w.owner, pinned, "hello");
    const start = await ws.started(run);
    expect(start.config?.model?.alias).toBe("fast");
    ws.reply(start, "ok");
    await f.until(w.team, run, "completed");

    const unpinned = await pinnedThread(w.owner, {});
    await choose(unpinned, "smart");
    const second = await f.message(w.owner, unpinned, "hello");
    const start2 = await ws.started(second);
    expect(start2.config?.model?.alias).toBe("smart");
    ws.reply(start2, "ok");
    await f.until(w.team, second, "completed");
  });
});

async function seedTeamSkill(
  team: string,
  userId: string,
  slug: string,
  versions: readonly ("pending" | "approved" | "rejected" | "none")[],
) {
  const admin = f.fx.admin;
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO team_skills (team_id, owner_user_id, slug, description, latest_version)
     VALUES ($1, $2, $3, 'd', $4) RETURNING id`,
    [team, userId, slug, versions.length],
  );
  const skillId = rows[0]?.id;
  for (const [i, status] of versions.entries()) {
    await admin.query(
      `INSERT INTO team_skill_versions (team_id, skill_id, version, frontmatter, source, content_hash,
         storage_key, size_bytes, file_count, uncompressed_bytes, uploaded_by)
       VALUES ($1, $2, $3, '{}', 'zip', $4, 'k', 1, 1, 1, $5)`,
      [team, skillId, i + 1, `${slug.length}${i}`.padEnd(64, "a"), userId],
    );
    if (status === "none") continue;
    await admin.query(
      `INSERT INTO team_skill_reviews (team_id, skill_id, version, scope, slug, content_hash, status,
         flagged, findings, scripts, skipped, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, 'team', $7, $8, $4, false, '[]', '[]', '[]', $5, $6)`,
      [
        team,
        skillId,
        i + 1,
        status,
        status === "pending" ? null : userId,
        status === "pending" ? null : new Date(),
        slug,
        `${slug.length}${i}`.padEnd(64, "a"),
      ],
    );
  }
}

async function seedPersonalSkill(userId: string, slug: string, flagged = false) {
  const { rows } = await f.fx.admin.query<{ id: string }>(
    `INSERT INTO install_skills (owner_user_id, slug, description) VALUES ($1, $2, 'd') RETURNING id`,
    [userId, slug],
  );
  await f.fx.admin.query(
    `INSERT INTO install_skill_versions (skill_id, version, frontmatter, source, content_hash,
       storage_key, size_bytes, file_count, uncompressed_bytes, uploaded_by)
     VALUES ($1, 1, '{}', 'zip', $2, 'k', 1, 1, 1, $3)`,
    [rows[0]?.id, "b".repeat(64), userId],
  );
  await f.fx.admin.query(
    `INSERT INTO install_skill_scans (skill_id, version, flagged, findings, scripts, skipped)
     VALUES ($1, 1, $2, '[]', '[]', '[]')`,
    [rows[0]?.id, flagged],
  );
}

/** Starts a run on `thread` and returns the skills the sandbox is told to load and omissions. */
async function skillsOfRun(w: Awaited<ReturnType<typeof f.world>>, thread: string) {
  const ws = await f.connect(w, 0);
  const run = await f.message(w.owner, thread, "hello");
  const start = await ws.started(run);
  ws.reply(start, "ok");
  await f.until(w.team, run, "completed");
  const omitted = (await f.events(w.team, run)).find((e) => e.type === "context.omitted");
  return {
    skills: start.config?.skills ?? [],
    omitted: (omitted?.payload as { items: unknown[] } | undefined)?.items ?? [],
  };
}

describe("run start resolves skills (KOBE-80)", () => {
  it("ac-1: only approved team skill versions resolve; unreviewed and rejected ones don't", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id, [["fast", true]]);
    await seedTeamSkill(w.team, w.owner.id, "approved-one", ["approved"]);
    await seedTeamSkill(w.team, w.owner.id, "pending-one", ["pending"]);
    await seedTeamSkill(w.team, w.owner.id, "rejected-one", ["rejected"]);
    await seedTeamSkill(w.team, w.owner.id, "no-review", ["none"]);
    // Newer pending/rejected versions never hide the older approved one.
    await seedTeamSkill(w.team, w.owner.id, "kept-old", ["approved", "pending", "rejected"]);
    const thread = await pinnedThread(w.owner, {
      skills: ["approved-one", "pending-one", "rejected-one", "no-review", "kept-old"],
    });
    const { skills, omitted } = await skillsOfRun(w, thread);
    expect([...skills].sort()).toEqual(["approved-one", "kept-old"]);
    // KOBE-99: the dropped ones are named in the notice.
    expect(
      [...(omitted as { name: string; reason: string }[])].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    ).toEqual(
      ["no-review", "pending-one", "rejected-one"].map((name) => ({
        kind: "skill",
        name,
        reason: "not_approved",
      })),
    );
  });

  it("ac-2: disabling personal skills hides them for that team, with a visible notice", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id, [["fast", true]]);
    await seedPersonalSkill(w.owner.id, "my-helper");
    const thread = await pinnedThread(w.owner, {});
    expect((await skillsOfRun(w, thread)).skills).toEqual(["my-helper"]);

    await f.fx.admin.query(
      `INSERT INTO team_skill_settings (team_id, personal_skills_disabled, updated_by) VALUES ($1, true, $2)`,
      [w.team, w.owner.id],
    );
    const hidden = await skillsOfRun(w, thread);
    expect(hidden.skills).toEqual([]);
    expect(hidden.omitted).toEqual([{ kind: "skill", name: "my-helper", reason: "team_disabled" }]);
  });

  it("a flagged personal skill is unusable in the team until its admin approves it there", async () => {
    const w = await f.world();
    await catalog(w.team, w.owner.id, [["fast", true]]);
    await seedPersonalSkill(w.owner.id, "clean-helper");
    await seedPersonalSkill(w.owner.id, "risky-helper", true);
    const thread = await pinnedThread(w.owner, {});
    const first = await skillsOfRun(w, thread);
    expect(first.skills).toEqual(["clean-helper"]);
    expect(first.omitted).toEqual([
      { kind: "skill", name: "risky-helper", reason: "not_approved" },
    ]);
    // The blocked version is now in this team's queue, pending.
    const { rows } = await f.fx.admin.query(
      `SELECT slug, scope, status, flagged FROM team_skill_reviews WHERE team_id = $1`,
      [w.team],
    );
    expect(rows).toEqual([
      { slug: "risky-helper", scope: "personal", status: "pending", flagged: true },
    ]);
    await f.fx.admin.query(
      `UPDATE team_skill_reviews SET status = 'approved', reviewed_by = $2, reviewed_at = now() WHERE team_id = $1`,
      [w.team, w.owner.id],
    );
    const approved = await skillsOfRun(w, thread);
    expect([...approved.skills].sort()).toEqual(["clean-helper", "risky-helper"]);
    expect(approved.omitted).toEqual([]);
  });
});
