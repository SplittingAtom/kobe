import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RULE_SET } from "@kobe/skill-scanner";
import { seedGalleryAgents } from "./gallery/seed.js";
import { skillSandboxRoutes } from "./skills/sandbox-routes.js";
import { draftBundlePrefix } from "./skills/drafts/test-bundle.js";
import { sweepOrphanDraftBundles } from "./skills/drafts/test-holds.js";
import { RawBody } from "./testing/browser.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { RunFixture, type FakeWorkspace, type RunStart } from "./testing/run-fixture.js";
import { must, type Person } from "./testing/event-stream-fixture.js";
import type { AuthResult, SandboxAuthenticator } from "./workspace-sync/auth.js";

/**
 * Workbench test chats (KOBE-323, SK13): an ordinary thread with the Kobe agent whose runs load
 * only the draft's current revision (no Required, agent-named, offered or personal skill), scanned
 * before the message is accepted; the Used-skill badge from a read of the draft's SKILL.md; the
 * draft's bundle served only to the run that listed it, and removed with the draft.
 */
const objects = new MemoryObjects();
const blobs = { objects, prefix: "kobe/" };
const f = new RunFixture();
const ANY = { "if-match": "*" };
type World = Awaited<ReturnType<RunFixture["world"]>>;

beforeAll(async () => {
  await f.setup({ blobs });
  await seedGalleryAgents(f.fx.db);
});
afterAll(async () => {
  await f.teardown();
});

const skillMd = (name: string, body = "Format reports as tables.") =>
  `---\nname: ${name}\ndescription: Formats ${name} reports. Use when asked for a ${name} report.\n---\n# ${name}\n${body}\n`;
const text = (t: string) => new RawBody(t, "text/plain; charset=utf-8");
const ifMatch = (rev: number) => ({ "if-match": `"${rev}"` });

async function catalog(w: World) {
  const admin = f.fx.admin;
  await admin.query(
    `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
     VALUES ('openai', 'openai', 'openai', 'v2.test.sealed-provider-key', $1) ON CONFLICT (id) DO NOTHING`,
    [w.owner.id],
  );
  await admin.query(
    `INSERT INTO model_catalog (alias, provider_id, model, created_by)
     VALUES ('fast', 'openai', 'fast-fake', $1) ON CONFLICT (alias) DO NOTHING`,
    [w.owner.id],
  );
  await admin.query(
    `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, 'fast', true, $2)`,
    [w.team, w.owner.id],
  );
}

async function world(): Promise<World> {
  const w = await f.world();
  await catalog(w);
  return w;
}

/** A draft of `p` named `name` with a SKILL.md; returns its id and revision. */
async function draftOf(p: Person, name: string, body?: string) {
  const b = f.on(0, p);
  const created = await b.post("/v1/skills/drafts", { name });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.draft.id as string;
  const rev = await put(
    p,
    id,
    "SKILL.md",
    created.json.draft.rev as number,
    text(skillMd(name, body)),
  );
  return { id, rev };
}

async function put(p: Person, id: string, path: string, rev: number, body: RawBody) {
  const res = await f
    .on(0, p)
    .request("PUT", `/v1/skills/drafts/${id}/files/${path}`, body, ifMatch(rev));
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json.rev as number;
}

async function testChat(p: Person, draftId: string): Promise<string> {
  const res = await f.on(0, p).post("/v1/threads", { skill_draft_id: draftId, title: "Test" });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  expect(res.json).toMatchObject({ skill_test: true, skill_draft_id: draftId });
  return res.json.thread_id as string;
}

/** A team skill every run of the team must load (Required, SK27), and a personal skill. */
async function otherSkills(w: World) {
  const team = await f.on(0, w.owner).post(
    "/v1/skills?scope=team",
    new RawBody(
      Buffer.from(
        (await import("fflate")).zipSync({
          "SKILL.md": new TextEncoder().encode(skillMd("house-rules")),
        }),
      ),
      "application/zip",
    ),
  );
  expect(team.status, JSON.stringify(team.json)).toBe(201);
  const skillId = team.json.skill.id as string;
  expect(
    (
      await f.on(0, w.owner).post(`/v1/team/skill-review/${skillId}/versions/1`, {
        decision: "approved",
      })
    ).status,
  ).toBe(200);
  await f.fx.admin.query(
    `UPDATE team_skills SET access = 'required' WHERE team_id = $1 AND id = $2`,
    [w.team, skillId],
  );
  const personal = await f.on(0, w.owner).post(
    "/v1/skills?scope=personal",
    new RawBody(
      Buffer.from(
        (await import("fflate")).zipSync({
          "SKILL.md": new TextEncoder().encode(skillMd("my-notes")),
        }),
      ),
      "application/zip",
    ),
  );
  expect(personal.status, JSON.stringify(personal.json)).toBe(201);
}

async function startOf(w: World, thread: string, ws?: FakeWorkspace) {
  const sandbox = ws ?? (await f.connect(w, 0));
  const run = await f.message(w.owner, thread, "Make me a sales report.");
  return { run, ws: sandbox, frame: await sandbox.started(run) };
}

const storePath = (hash: string) => `/run/kobe-skills/store/sk-${hash}/SKILL.md`;

function readCall(ws: FakeWorkspace, s: RunStart, id: string, path: string) {
  ws.event(s, { type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path } });
  ws.event(s, {
    type: "tool_execution_end",
    toolCallId: id,
    toolName: "read",
    isError: false,
    result: { content: [{ type: "text", text: "# Skill" }] },
  });
}

async function runRow(team: string, runId: string) {
  const { rows } = await f.fx.admin.query<{
    refs: { name: string; source: string; sha256: string }[];
    used: unknown[];
    failure: string | null;
  }>(
    `SELECT skill_refs AS refs, skills_used AS used,
            (SELECT payload -> 'error' ->> 'code' FROM run_events e
              WHERE e.team_id = r.team_id AND e.run_id = r.id AND e.type = 'run.failed' LIMIT 1) AS failure
       FROM runs r WHERE team_id = $1 AND id = $2`,
    [team, runId],
  );
  return must(rows[0], "run");
}

describe("ac-1: a test chat runs only the draft's current revision", () => {
  it("lists the draft alone: no Required, agent-named or personal skill", async () => {
    const w = await world();
    await otherSkills(w);
    const d = await draftOf(w.owner, "sales-report");
    const thread = await testChat(w.owner, d.id);
    const { run, ws, frame } = await startOf(w, thread);
    expect(frame.config?.skills).toEqual(["sales-report"]);
    expect(frame.config?.skill_bundles).toHaveLength(1);
    const refs = (await runRow(w.team, run)).refs;
    expect(refs).toEqual([
      { name: "sales-report", source: "draft", sha256: frame.config?.skill_bundles?.[0]?.sha256 },
    ]);
    ws.reply(frame, "ok");
    await f.until(w.team, run, "completed");

    // An edit is a new revision: the next message runs it, under a new hash.
    const draft = await f.on(0, w.owner).get(`/v1/skills/drafts/${d.id}`);
    await put(
      w.owner,
      d.id,
      "SKILL.md",
      draft.json.draft.rev as number,
      text(skillMd("sales-report", "Use charts.")),
    );
    const next = await f.message(w.owner, thread, "Again.");
    const second = await ws.started(next);
    expect(second.config?.skill_bundles?.[0]?.sha256).not.toBe(
      frame.config?.skill_bundles?.[0]?.sha256,
    );
    ws.reply(second, "ok");
    await f.until(w.team, next, "completed");
    // The control: an ordinary chat of the same member loads the team's Required skill.
    const plain = await f.message(w.owner, await f.thread(w.owner), "Hi");
    const usual = await ws.started(plain);
    expect(usual.config?.skills).toEqual(expect.arrayContaining(["house-rules"]));
    ws.reply(usual, "ok");
    await f.until(w.team, plain, "completed");
    // Every other policy is the ordinary chat's: approval mode, run kind (billed as chat), audit.
    const { rows } = await f.fx.admin.query<{ id: string; approval_mode: string; kind: string }>(
      `SELECT id, approval_mode, kind FROM runs WHERE team_id = $1 AND id = ANY($2)`,
      [w.team, [run, plain]],
    );
    const modes = new Set(rows.map((r) => `${r.approval_mode}/${r.kind}`));
    expect([rows.length, modes.size]).toEqual([2, 1]);
    expect([...modes][0]).toMatch(/\/message$/);
    ws.kill();
  });

  it("is an ordinary thread of the team (listed), with the Kobe agent only", async () => {
    const w = await world();
    const d = await draftOf(w.owner, "listed-skill");
    const thread = await testChat(w.owner, d.id);
    const list = await f.on(0, w.owner).get("/v1/threads");
    const row = (list.json.threads as { thread_id: string; skill_test?: boolean }[]).find(
      (t) => t.thread_id === thread,
    );
    expect(row).toMatchObject({ skill_test: true, skill_draft_id: d.id, is_test: false });
    const team = await f.on(0, w.owner).post("/v1/agents", {
      scope: "team",
      frontmatter: { name: "Other" },
      prompt: "Hi.",
    });
    const other = team.json.agent.id as string;
    expect(
      (await f.on(0, w.owner).request("POST", `/v1/agents/${other}/publish`, {}, ANY)).status,
    ).toBe(201);
    const wrong = await f
      .on(0, w.owner)
      .post("/v1/threads", { skill_draft_id: d.id, agent_id: other });
    expect([wrong.status, wrong.json.code]).toEqual([400, "test_chat_agent"]);
  });

  it("starts only from a draft the creator can see, in the same team", async () => {
    const w = await world();
    const other = await world();
    const member = await f.member(w.team);
    const d = await draftOf(w.owner, "private-draft");
    // Another member can't see a private draft; another team's member can't either.
    for (const p of [member, other.owner]) {
      const res = await f.on(0, p).post("/v1/threads", { skill_draft_id: d.id });
      expect([res.status, res.json.code]).toEqual([404, "draft_not_found"]);
    }
    const bad = await f.on(0, w.owner).post("/v1/threads", { skill_draft_id: d.id, test: true });
    expect(bad.status).toBe(400);
  });
});

describe("refusals, each with its own message", () => {
  it("refuses a message when the scan Blocks the draft, and starts no run", async () => {
    const w = await world();
    const d = await draftOf(w.owner, "blocked-draft");
    await put(
      w.owner,
      d.id,
      "lib/mod.pyc",
      d.rev,
      new RawBody(Buffer.from("\u0000compiled"), "application/octet-stream"),
    );
    const thread = await testChat(w.owner, d.id);
    const res = await f.send(w.owner, thread, "Hello");
    expect([res.status, res.json.code]).toEqual([409, "scan_blocked"]);
    expect(res.json.message).toMatch(/scan blocks this draft.*Fix the findings/);
    const { rows } = await f.fx.admin.query(
      `SELECT 1 FROM runs WHERE team_id = $1 AND thread_id = $2`,
      [w.team, thread],
    );
    expect(rows).toEqual([]);
  });

  it("refuses a message once the draft is deleted or no longer shared with the caller", async () => {
    const w = await world();
    const builder = await f.member(w.team);
    await f.fx.admin.query(
      `UPDATE team_members SET role = 'builder' WHERE team_id = $1 AND user_id = $2`,
      [w.team, builder.id],
    );
    const d = await draftOf(w.owner, "shared-draft");
    const share = await f
      .on(0, w.owner)
      .request("PATCH", `/v1/skills/drafts/${d.id}`, { shared: true }, ifMatch(d.rev));
    expect(share.status, JSON.stringify(share.json)).toBe(200);
    const theirs = await testChat(builder, d.id);
    const rev = (await f.on(0, w.owner).get(`/v1/skills/drafts/${d.id}`)).json.draft.rev as number;
    expect(
      (
        await f
          .on(0, w.owner)
          .request("PATCH", `/v1/skills/drafts/${d.id}`, { shared: false }, ifMatch(rev))
      ).status,
    ).toBe(200);
    const unshared = await f.send(builder, theirs, "Hi");
    expect([unshared.status, unshared.json.code]).toEqual([409, "skill_draft_unavailable"]);
    expect(unshared.json.message).toMatch(
      /draft isn't available: it was deleted, or it is no longer shared/,
    );

    const mine = await testChat(w.owner, d.id);
    expect((await f.on(0, w.owner).delete(`/v1/skills/drafts/${d.id}`)).status).toBe(204);
    const gone = await f.send(w.owner, mine, "Hi");
    expect([gone.status, gone.json.code]).toEqual([409, "skill_draft_unavailable"]);
  });

  it("fails a queued run whose draft changed after the send: send again", async () => {
    const w = await world();
    const d = await draftOf(w.owner, "changing-draft");
    const thread = await testChat(w.owner, d.id);
    const ws = await f.connect(w, 0);
    const first = await f.message(w.owner, thread, "One");
    const start = await ws.started(first);
    // Queued behind the first: scanned and stored now, started later.
    const queued = await f.message(w.owner, thread, "Two");
    const rev = (await f.on(0, w.owner).get(`/v1/skills/drafts/${d.id}`)).json.draft.rev as number;
    await put(w.owner, d.id, "SKILL.md", rev, text(skillMd("changing-draft", "Changed.")));
    ws.reply(start, "ok");
    await f.until(w.team, first, "completed");
    await f.until(w.team, queued, "failed");
    expect((await runRow(w.team, queued)).failure).toBe("skill_draft_changed");
    const events = await f.events(w.team, queued);
    const failed = events.find((e) => e.type === "run.failed");
    expect(JSON.stringify(failed?.payload)).toMatch(/draft changed after you sent the message/);
    ws.kill();
  });
});

describe("ac-2: the Used-skill badge", () => {
  it("records the draft on a prompt that reads its SKILL.md, nothing on an unrelated one", async () => {
    const w = await world();
    const d = await draftOf(w.owner, "badge-skill");
    const thread = await testChat(w.owner, d.id);
    const ws = await f.connect(w, 0);
    const matching = await f.message(w.owner, thread, "A badge-skill report, please.");
    const s1 = await ws.started(matching);
    const hash = must(s1.config?.skill_bundles?.[0], "bundle").sha256;
    readCall(ws, s1, "load", storePath(hash));
    ws.reply(s1, "Here it is.");
    await f.until(w.team, matching, "completed");
    expect((await runRow(w.team, matching)).used).toEqual([
      { tool_call_id: "load", name: "badge-skill", source: "draft" },
    ]);
    const unrelated = await f.message(w.owner, thread, "What is 2 + 2?");
    const s2 = await ws.started(unrelated);
    ws.reply(s2, "4");
    await f.until(w.team, unrelated, "completed");
    expect((await runRow(w.team, unrelated)).used).toEqual([]);
    const markers = await f.on(0, w.owner).get(`/v1/threads/${thread}/markers`);
    expect(markers.json.skills).toEqual([
      expect.objectContaining({ run_id: matching, name: "badge-skill", source: "draft" }),
    ]);
    ws.kill();
  });
});

describe("the draft bundle in the sandbox and in storage", () => {
  const as = (team: string, userId: string, sandboxId: string): SandboxAuthenticator => {
    const result: AuthResult = { ok: true, caller: { sandboxId, teamId: team, userId } };
    return Object.assign(() => Promise.resolve(result), { forget() {} });
  };
  const routes = (authenticate: SandboxAuthenticator) =>
    skillSandboxRoutes({ db: f.fx.db, blobs, authenticate, log: { error() {}, warn() {} } });

  it("serves it only to the run that listed it: not another sandbox, thread or team", async () => {
    const w = await world();
    const other = await world();
    const d = await draftOf(w.owner, "served-draft");
    const thread = await testChat(w.owner, d.id);
    const ws = await f.connect(w, 0);
    ws.sb.autoAnswer = false;
    const run = await f.message(w.owner, thread, "Go");
    const start = await ws.started(run);
    const hash = must(start.config?.skill_bundles?.[0], "bundle").sha256;
    const { rows } = await f.fx.admin.query<{ sandbox_id: string }>(
      `SELECT sandbox_id FROM sandbox_run_leases WHERE run_id = $1`,
      [run],
    );
    const sandboxId = must(rows[0], "lease").sandbox_id;
    const res = await routes(as(w.team, w.owner.id, sandboxId)).request(`/${hash}`);
    expect(res.status).toBe(200);
    expect(
      createHash("sha256")
        .update(Buffer.from(await res.arrayBuffer()))
        .digest("hex"),
    ).toBe(hash);
    expect((await routes(as(w.team, w.owner.id, randomUUID())).request(`/${hash}`)).status).toBe(
      404,
    );
    expect(
      (await routes(as(other.team, other.owner.id, sandboxId)).request(`/${hash}`)).status,
    ).toBe(404);

    // Another thread's run (an ordinary chat on another sandbox of the same member) didn't list it.
    const plain = await f.thread(w.owner);
    const ows = await f.connect(w, 0);
    ows.sb.autoAnswer = false;
    const plainRun = await f.message(w.owner, plain, "Go");
    await ows.started(plainRun);
    const leases = await f.fx.admin.query<{ sandbox_id: string }>(
      `SELECT sandbox_id FROM sandbox_run_leases WHERE run_id = $1`,
      [plainRun],
    );
    const plainSandbox = must(leases.rows[0], "lease").sandbox_id;
    expect((await routes(as(w.team, w.owner.id, plainSandbox)).request(`/${hash}`)).status).toBe(
      404,
    );
    ws.kill();
    ows.kill();
  });

  it("is deleted with the draft, and swept when its draft is gone; no row holds its key", async () => {
    const w = await world();
    const d = await draftOf(w.owner, "kept-draft");
    const thread = await testChat(w.owner, d.id);
    const ws = await f.connect(w, 0);
    const run = await f.message(w.owner, thread, "Go");
    const start = await ws.started(run);
    ws.reply(start, "ok");
    await f.until(w.team, run, "completed");
    ws.kill();
    const folder = draftBundlePrefix("kobe/", w.team, d.id);
    const stored = () => [...objects.objects.keys()].filter((k) => k.startsWith(folder));
    expect(stored()).toHaveLength(1);
    const key = must(stored()[0], "key");
    // Nothing in the database names the object (so no legal-hold history can refer to it).
    const { rows } = await f.fx.admin.query(
      `SELECT 1 FROM skill_drafts d WHERE d::text LIKE '%' || $1 || '%'
       UNION ALL SELECT 1 FROM skill_draft_files x WHERE x::text LIKE '%' || $1 || '%'
       UNION ALL SELECT 1 FROM threads t WHERE t::text LIKE '%' || $1 || '%'
       UNION ALL SELECT 1 FROM runs r WHERE r::text LIKE '%' || $1 || '%'`,
      [key],
    );
    expect(rows).toEqual([]);
    expect((await f.on(0, w.owner).delete(`/v1/skills/drafts/${d.id}`)).status).toBe(204);
    expect(stored()).toEqual([]);

    // A bundle whose draft is gone some other way (retention, offboarding) is swept per team.
    const orphan = `kobe/skills/drafts/${w.team}/${randomUUID()}/${"a".repeat(64)}`;
    objects.objects.set(orphan, Buffer.from("x"));
    const live = await draftOf(w.owner, "live-draft");
    const liveKey = `${draftBundlePrefix("kobe/", w.team, live.id)}${"b".repeat(64)}`;
    objects.objects.set(liveKey, Buffer.from("y"));
    expect(await sweepOrphanDraftBundles(f.fx.db, blobs, w.team)).toEqual({ drafts: 1 });
    expect(objects.objects.has(orphan)).toBe(false);
    expect(objects.objects.has(liveKey)).toBe(true);
  });
});

/** An active hold on `userId` in `teamId` (two Site admins, as the hold workflow needs). */
async function placeHold(teamId: string, userId: string) {
  const placer = await f.fx.person(`hp${randomUUID().slice(0, 4)}`);
  const approver = await f.fx.person(`ha${randomUUID().slice(0, 4)}`);
  for (const p of [placer, approver])
    await f.fx.admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [p.id]);
  const { rows } = await f.fx.admin.query<{ id: string }>(
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3) RETURNING id`,
    [teamId, userId, placer.id],
  );
  const id = must(rows[0], "hold").id;
  await f.fx.admin.query(
    `UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
    [id, approver.id],
  );
  return async () => {
    await f.fx.admin.query(
      `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(),
         release_reason = 'closed' WHERE id = $1`,
      [id, placer.id],
    );
    await f.fx.admin.query(
      `UPDATE legal_holds SET status = 'released', released_by = $2 WHERE id = $1`,
      [id, approver.id],
    );
  };
}

const bundlesOf = (teamId: string, draftId: string) =>
  [...objects.objects.keys()].filter((k) =>
    k.startsWith(draftBundlePrefix("kobe/", teamId, draftId)),
  );

async function asBuilder(w: World): Promise<Person> {
  const builder = await f.member(w.team);
  await f.fx.admin.query(
    `UPDATE team_members SET role = 'builder' WHERE team_id = $1 AND user_id = $2`,
    [w.team, builder.id],
  );
  return builder;
}

describe("review 323: the team's personal-skill gates (S1)", () => {
  it("lets only Builders and Team admins test while the team has personal skills off", async () => {
    const w = await world();
    const member = await f.member(w.team);
    const theirs = await testChat(member, (await draftOf(member, "member-draft")).id);
    const mine = await testChat(w.owner, (await draftOf(w.owner, "admin-draft")).id);
    await f.fx.admin.query(
      `INSERT INTO team_skill_settings (team_id, personal_skills_disabled, updated_by)
       VALUES ($1, true, $2) ON CONFLICT (team_id) DO UPDATE SET personal_skills_disabled = true`,
      [w.team, w.owner.id],
    );
    const refused = await f.send(member, theirs, "Hi");
    expect([refused.status, refused.json.code]).toEqual([403, "personal_skills_disabled"]);
    expect(refused.json.message).toMatch(/turned personal skills off.*Builders and Team admins/);
    expect((await f.send(w.owner, mine, "Hi")).status).toBe(201);
  });

  it("refuses a test of files the team declined as a personal skill", async () => {
    const w = await world();
    const d = await draftOf(w.owner, "declined-draft");
    const thread = await testChat(w.owner, d.id);
    const { run, ws, frame } = await startOf(w, thread);
    ws.reply(frame, "ok");
    await f.until(w.team, run, "completed");
    ws.kill();
    const hash = must(frame.config?.skill_bundles?.[0], "bundle").sha256;
    await f.fx.admin.query(
      `INSERT INTO team_skill_reviews (team_id, skill_id, version, scope, slug, content_hash, status,
         flagged, findings, scripts, skipped, reviewed_by, reviewed_at)
       VALUES ($1, $2, 1, 'personal', 'declined-draft', $3, 'rejected', false, '[]', '[]', '[]', $4, now())`,
      [w.team, randomUUID(), hash, w.owner.id],
    );
    const res = await f.send(w.owner, thread, "Again");
    expect([res.status, res.json.code]).toEqual([409, "skill_declined"]);
    expect(res.json.message).toMatch(/declined a personal skill with exactly these files/);
  });
});

describe("review 323: bundles under holds and over time (S2, S3)", () => {
  it("keeps a bundle a held tester's run loaded when the draft goes, until the hold ends", async () => {
    const w = await world();
    const tester = await asBuilder(w);
    const d = await draftOf(w.owner, "held-tester-draft");
    const share = await f
      .on(0, w.owner)
      .request("PATCH", `/v1/skills/drafts/${d.id}`, { shared: true }, ifMatch(d.rev));
    expect(share.status, JSON.stringify(share.json)).toBe(200);
    const thread = await testChat(tester, d.id);
    const tw = { ...w, owner: tester, target: { teamId: w.team, userId: tester.id } };
    const ws = await f.connect(tw, 0);
    const run = await f.message(tester, thread, "Go");
    const start = await ws.started(run);
    ws.reply(start, "ok");
    await f.until(w.team, run, "completed");
    ws.kill();
    expect(bundlesOf(w.team, d.id)).toHaveLength(1);
    const release = await placeHold(w.team, tester.id);
    expect((await f.on(0, w.owner).delete(`/v1/skills/drafts/${d.id}`)).status).toBe(204);
    expect(bundlesOf(w.team, d.id)).toHaveLength(1);
    expect(await sweepOrphanDraftBundles(f.fx.db, blobs, w.team)).toEqual({ drafts: 0 });
    expect(bundlesOf(w.team, d.id)).toHaveLength(1);
    await release();
    expect(await sweepOrphanDraftBundles(f.fx.db, blobs, w.team)).toEqual({ drafts: 1 });
    expect(bundlesOf(w.team, d.id)).toEqual([]);
  });

  it("keeps the newest five bundles per draft, keyed by the scanner's rule set", async () => {
    const w = await world();
    const d = await draftOf(w.owner, "many-revisions");
    const thread = await testChat(w.owner, d.id);
    let rev = d.rev;
    for (let i = 0; i < 7; i += 1) {
      rev = await put(
        w.owner,
        d.id,
        "SKILL.md",
        rev,
        text(skillMd("many-revisions", `Rule ${i}.`)),
      );
      expect((await f.send(w.owner, thread, `Try ${i}`)).status).toBe(201);
    }
    const keys = bundlesOf(w.team, d.id);
    expect(keys).toHaveLength(5);
    for (const k of keys) expect(k).toMatch(new RegExp(`/[0-9a-f]{64}\\.r${RULE_SET}$`));
  });
});
