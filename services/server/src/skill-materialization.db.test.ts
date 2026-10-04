import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import type { AuthResult, SandboxAuthenticator } from "./workspace-sync/auth.js";
import { skillSandboxRoutes } from "./skills/sandbox-routes.js";
import { RawBody } from "./testing/browser.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { RunFixture } from "./testing/run-fixture.js";
import type { Person } from "./testing/event-stream-fixture.js";

/**
 * KOBE-82: only effective skills (approved, not blocklisted, not team-disabled) are listed in
 * `run.start` and served to the sandbox; a hash that stopped being effective is refused at once.
 */
const objects = new MemoryObjects();
const f = new RunFixture();
const ANY = { "if-match": "*" };

beforeAll(async () => {
  await f.setup({ blobs: { objects, prefix: "kobe/" } });
});
afterAll(async () => {
  await f.teardown();
});

const unique = () => randomUUID().slice(0, 8);
const zipOf = (name: string, note = "body") =>
  new RawBody(
    zipSync({
      "SKILL.md": strToU8(`---\nname: ${name}\ndescription: Skill ${name}\n---\n${note}\n`),
    }),
    "application/zip",
  );

async function upload(p: Person, scope: "team" | "personal", name: string) {
  const res = await f.on(0, p).post(`/v1/skills?scope=${scope}`, zipOf(name));
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return { skillId: res.json.skill.id as string, hash: res.json.version.contentHash as string };
}
const approve = async (p: Person, skillId: string) => {
  const res = await f.on(0, p).post(`/v1/team/skill-review/${skillId}/versions/1`, {
    decision: "approved",
  });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
};
/** Lists a hash on the install blocklist (KOBE-81's table; the admin route has its own tests). */
async function blockAs(owner: Person, hash: string) {
  await f.fx.admin.query(
    `INSERT INTO skill_blocklist (content_hash, reason, added_by) VALUES ($1, 'malware', $2)`,
    [hash, owner.id],
  );
}

async function pinnedThread(p: Person, skills: string[]) {
  const b = f.on(0, p);
  const created = await b.post("/v1/agents", {
    scope: "team",
    frontmatter: { name: "Skilled", skills },
    prompt: "You use skills.",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  expect((await b.request("POST", `/v1/agents/${id}/publish`, {}, ANY)).status).toBe(201);
  const thread = await b.post("/v1/threads", { agent_id: id });
  expect(thread.status, JSON.stringify(thread.json)).toBe(201);
  return thread.json.thread_id as string;
}

async function startConfig(w: Awaited<ReturnType<RunFixture["world"]>>, thread: string) {
  const ws = await f.connect(w, 0);
  const run = await f.message(w.owner, thread, "hello");
  const start = await ws.started(run);
  ws.reply(start, "ok");
  await f.until(w.team, run, "completed");
  ws.kill();
  return start.config ?? {};
}

describe("run.start lists only effective skills", () => {
  it("ac-1/ac-2: approved ones with their hash and size; pending, blocklisted and unknown ones never", async () => {
    const w = await f.world();
    const [ok, pending, blocked] = [`ok-${unique()}`, `pend-${unique()}`, `blk-${unique()}`];
    const a = await upload(w.owner, "team", ok);
    await upload(w.owner, "team", pending);
    const c = await upload(w.owner, "team", blocked);
    await approve(w.owner, a.skillId);
    await approve(w.owner, c.skillId);
    await blockAs(w.owner, c.hash);

    const thread = await pinnedThread(w.owner, [ok, pending, blocked, "nonexistent"]);
    const config = await startConfig(w, thread);
    const stored = [...objects.objects.values()].find(
      (b) => createHash("sha256").update(b).digest("hex") === a.hash,
    );
    expect(config.skills).toEqual([ok]);
    expect(config.skill_bundles).toEqual([{ name: ok, sha256: a.hash, size: stored?.length }]);
  });

  it("a team that switched personal skills off gets none of the user's personal skills", async () => {
    const w = await f.world();
    const mine = `mine-${unique()}`;
    await upload(w.owner, "personal", mine);
    const thread = await pinnedThread(w.owner, []);
    const before = await startConfig(w, thread);
    expect(before.skills).toEqual([mine]);

    const off = await f.on(0, w.owner).put("/v1/team/skill-review/settings", {
      personalSkillsDisabled: true,
    });
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    const after = await startConfig(w, await pinnedThread(w.owner, []));
    expect(after.skill_bundles).toBeUndefined();
    expect(after.skills).toBeUndefined();
  });

  it("an agent with no skills carries no bundle list", async () => {
    const w = await f.world();
    const config = await startConfig(w, await pinnedThread(w.owner, []));
    expect(config.skill_bundles).toBeUndefined();
  });
});

describe("agents that do not advertise skill support", () => {
  it("fails the run visibly instead of starting without its skills or sending fields it can't read", async () => {
    const w = await f.world();
    const name = `old-${unique()}`;
    const s = await upload(w.owner, "team", name);
    await approve(w.owner, s.skillId);
    const thread = await pinnedThread(w.owner, [name]);
    const old = await f.connect(w, 0, null);
    const run = await f.message(w.owner, thread, "hello");
    await f.until(w.team, run, "failed");
    expect((await f.events(w.team, run)).at(-1)?.payload).toMatchObject({
      error: { code: "skills_unsupported" },
    });
    expect(old.starts().map((x) => x.run_id)).not.toContain(run);
    old.kill();
  });

  it("starts a run without skills on an older agent, with no bundle field at all", async () => {
    const w = await f.world();
    const old = await f.connect(w, 0, null);
    const run = await f.message(w.owner, await pinnedThread(w.owner, []), "hello");
    const start = await old.started(run);
    expect(start.config).not.toHaveProperty("skill_bundles");
    old.reply(start, "ok");
    await f.until(w.team, run, "completed");
    old.kill();
  });
});

describe("sandbox bundle download", () => {
  /** A run whose run.start the sandbox has not answered yet: the window in which it fetches. */
  async function heldRun(w: Awaited<ReturnType<RunFixture["world"]>>, skills: string[]) {
    const ws = await f.connect(w, 0);
    ws.sb.autoAnswer = false;
    const run = await f.message(w.owner, await pinnedThread(w.owner, skills), "hello");
    const start = await ws.started(run);
    const { rows } = await f.fx.admin.query<{ sandbox_id: string }>(
      `SELECT sandbox_id FROM sandbox_run_leases WHERE run_id = $1`,
      [run],
    );
    return { ws, run, start, sandboxId: rows[0]?.sandbox_id as string };
  }
  const as = (w: { team: string }, userId: string, sandboxId: string): SandboxAuthenticator => {
    const result: AuthResult = { ok: true, caller: { sandboxId, teamId: w.team, userId } };
    return Object.assign(() => Promise.resolve(result), { forget() {} });
  };
  const routes = (authenticate: SandboxAuthenticator) =>
    skillSandboxRoutes({
      db: f.fx.db,
      blobs: { objects, prefix: "kobe/" },
      authenticate,
      log: { error() {}, warn() {} },
    });

  it("serves a bundle listed in the run's run.start, byte for byte; a blocklist entry stops it mid-run", async () => {
    const w = await f.world();
    const name = `dl-${unique()}`;
    const s = await upload(w.owner, "team", name);
    await approve(w.owner, s.skillId);
    const held = await heldRun(w, [name]);
    const app = routes(as(w, w.owner.id, held.sandboxId));
    const res = await app.request(`/${s.hash}`);
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(s.hash);
    expect(res.headers.get("content-length")).toBe(String(bytes.length));

    await blockAs(w.owner, s.hash);
    expect((await app.request(`/${s.hash}`)).status).toBe(404);
  });

  it("still serves a personal skill that was replaced after the run started", async () => {
    const w = await f.world();
    const name = `swap-${unique()}`;
    const first = await upload(w.owner, "personal", name);
    const held = await heldRun(w, []);
    expect(held.start.config?.skill_bundles?.map((b) => b.sha256)).toEqual([first.hash]);
    // A new version replaces it for later runs (new hash); this run keeps its own.
    const next = await f.on(0, w.owner).post("/v1/skills?scope=personal", zipOf(name, "changed"));
    expect(next.status, JSON.stringify(next.json)).toBe(201);
    expect(next.json.version.contentHash).not.toBe(first.hash);
    const app = routes(as(w, w.owner.id, held.sandboxId));
    expect((await app.request(`/${first.hash}`)).status).toBe(200);
    // Nor is the new version offered to this run.
    expect((await app.request(`/${next.json.version.contentHash}`)).status).toBe(404);
  });

  it("serves nothing that is not in this run's list, to another sandbox, or with no open run.start", async () => {
    const w = await f.world();
    const other = await f.world();
    const listed = `in-${unique()}`;
    const a = await upload(w.owner, "team", listed);
    await approve(w.owner, a.skillId);
    const unlisted = await upload(w.owner, "team", `out-${unique()}`);
    await approve(w.owner, unlisted.skillId);
    const pending = await upload(w.owner, "team", `pd-${unique()}`);
    const foreign = await upload(other.owner, "team", `ot-${unique()}`);
    const theirs = await upload(other.owner, "personal", `pr-${unique()}`);
    const held = await heldRun(w, [listed]);
    const app = routes(as(w, w.owner.id, held.sandboxId));
    for (const hash of [
      unlisted.hash,
      pending.hash,
      foreign.hash,
      theirs.hash,
      "f".repeat(64),
      "../etc",
      "A".repeat(64),
    ])
      expect((await app.request(`/${hash}`)).status, hash).toBe(404);
    // Same user and team, but another sandbox: its run.start is not open on that one.
    const stranger = routes(as(w, w.owner.id, randomUUID()));
    expect((await stranger.request(`/${a.hash}`)).status).toBe(404);
    // Another team's caller.
    const elsewhere = routes(as(other, other.owner.id, held.sandboxId));
    expect((await elsewhere.request(`/${a.hash}`)).status).toBe(404);
  });

  it("serves nothing once the run.start was answered", async () => {
    const w = await f.world();
    const name = `done-${unique()}`;
    const s = await upload(w.owner, "team", name);
    await approve(w.owner, s.skillId);
    const held = await heldRun(w, [name]);
    await f.fx.admin.query(`UPDATE sandbox_commands SET status = 'done' WHERE run_id = $1`, [
      held.run,
    ]);
    const app = routes(as(w, w.owner.id, held.sandboxId));
    expect((await app.request(`/${s.hash}`)).status).toBe(404);
  });

  it("refuses a caller that is not a live sandbox", async () => {
    const denied = Object.assign(
      () => Promise.resolve<AuthResult>({ ok: false, reason: "invalid" }),
      { forget() {} },
    );
    expect((await routes(denied).request(`/${"a".repeat(64)}`)).status).toBe(401);
  });
});
