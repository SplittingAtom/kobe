import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSkillRequest } from "@kobe/protocol";
import { RunFixture } from "./testing/run-fixture.js";
import type { Person } from "./testing/event-stream-fixture.js";
import { must } from "./testing/event-stream-fixture.js";

/**
 * KOBE-451 ac-4: the composer's Skills. The list is the run-start resolver's effective set; a
 * picked skill reaches the run as the server's line before the member's text; one outside the
 * set is refused at submit, and again at run start if it left the set while the message waited;
 * member text imitating the line is refused.
 */
const f = new RunFixture();
const ANY = { "if-match": "*" };

beforeAll(async () => {
  await f.setup();
});
afterAll(async () => {
  await f.teardown();
});

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
         storage_key, size_bytes, file_count, uncompressed_bytes, uploaded_by, semver, seq)
       VALUES ($1, $2, $3, '{}', 'zip', $4, 'k', 1, 1, 1, $5, '0.' || $3::int || '.0', $3::int)`,
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

async function world() {
  const w = await f.world(1);
  await catalog(w.team, w.owner.id);
  await seedTeamSkill(w.team, w.owner.id, "pretty-html");
  await seedTeamSkill(w.team, w.owner.id, "not-given");
  const agent = await publishAgent(w.owner, { skills: ["pretty-html"] });
  const thread = await threadWith(w.owner, agent);
  return { w, agent, thread };
}

const names = (json: Record<string, unknown>) =>
  (json.skills as { name: string }[]).map((s) => s.name);

describe("the composer's skills (KOBE-451)", () => {
  it("lists the effective skills for a thread and for a conversation not started yet", async () => {
    const { w, agent, thread } = await world();
    const b = f.on(0, w.owner);
    const mine = await b.get(`/v1/threads/${thread}/skills`);
    expect(mine.status).toBe(200);
    expect(names(mine.json)).toEqual(["pretty-html"]);
    expect(names((await b.get(`/v1/threads/skills?agent_id=${agent}`)).json)).toEqual([
      "pretty-html",
    ]);
    expect(names((await b.get("/v1/threads/skills")).json)).toEqual([]);
    const mate = must(w.others[0], "mate");
    expect((await f.on(0, mate).get(`/v1/threads/${thread}/skills`)).status).toBe(404);
  });

  it("a picked skill reaches the run as the server's line; one outside the set is refused", async () => {
    const { w, thread } = await world();
    const refused = await f.send(w.owner, thread, "Make it pretty", 0, { skill: "not-given" });
    expect(refused.status).toBe(422);
    expect(refused.json.code).toBe("skill_not_available");
    const imitated = await f.send(w.owner, thread, withSkillRequest("pretty-html", "x"));
    expect(imitated.status).toBe(422);
    expect(imitated.json.code).toBe("invalid_content");

    const ws = await f.connect(w, 0);
    const res = await f.send(w.owner, thread, "Make it pretty", 0, { skill: "pretty-html" });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const run = res.json.run_id as string;
    expect((await f.run(w.team, run)).input).toBe(
      withSkillRequest("pretty-html", "Make it pretty"),
    );
    const frame = await ws.started(run);
    expect(frame.message).toBe(withSkillRequest("pretty-html", "Make it pretty"));
    expect(frame.config?.skills).toEqual(["pretty-html"]);
    ws.reply(frame, "done");
    await f.until(w.team, run, "completed");
  });

  it("the run start checks again: a skill blocked while the message waited fails the run", async () => {
    const { w, thread } = await world();
    const ws = await f.connect(w, 0);
    const first = await f.message(w.owner, thread, "first");
    const frame = await ws.started(first);
    const queued = await f.send(w.owner, thread, "second", 0, { skill: "pretty-html" });
    expect(queued.status).toBe(201);
    expect(queued.json.queued).toBe(true);
    await f.fx.admin.query(
      `INSERT INTO skill_blocklist (content_hash, reason, added_by) VALUES ($1, 'test', $2)`,
      [hashOf(`${w.team}:pretty-html`), w.owner.id],
    );
    ws.reply(frame, "ok");
    await f.until(w.team, first, "completed");
    const second = queued.json.run_id as string;
    await f.until(w.team, second, "failed");
    const { rows } = await f.fx.admin.query<{ payload: { error?: { code?: string } } }>(
      `SELECT payload FROM run_events WHERE team_id = $1 AND run_id = $2 AND type = 'run.failed'`,
      [w.team, second],
    );
    expect(rows[0]?.payload.error?.code).toBe("skill_not_available");
  });
});
