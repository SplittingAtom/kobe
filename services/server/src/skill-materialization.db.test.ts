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

describe("sandbox bundle download", () => {
  const caller = (w: { team: string }, userId: string): SandboxAuthenticator => {
    const result: AuthResult = {
      ok: true,
      caller: { sandboxId: randomUUID(), teamId: w.team, userId },
    };
    return Object.assign(() => Promise.resolve(result), { forget() {} });
  };
  const routes = (authenticate: SandboxAuthenticator) =>
    skillSandboxRoutes({
      db: f.fx.db,
      blobs: { objects, prefix: "kobe/" },
      authenticate,
      log: { error() {}, warn() {} },
    });

  it("serves an effective bundle byte for byte, and a blocklisted one stops at once", async () => {
    const w = await f.world();
    const s = await upload(w.owner, "team", `dl-${unique()}`);
    await approve(w.owner, s.skillId);
    const app = routes(caller(w, w.owner.id));
    const res = await app.request(`/${s.hash}`, { headers: { authorization: "Bearer x" } });
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(s.hash);
    expect(res.headers.get("content-length")).toBe(String(bytes.length));

    await blockAs(w.owner, s.hash);
    expect((await app.request(`/${s.hash}`)).status).toBe(404);
  });

  it("never serves a pending version, another team's skill, another user's personal skill or junk", async () => {
    const w = await f.world();
    const other = await f.world();
    const pending = await upload(w.owner, "team", `pd-${unique()}`);
    const approved = await upload(other.owner, "team", `ot-${unique()}`);
    await approve(other.owner, approved.skillId);
    const theirs = await upload(other.owner, "personal", `pr-${unique()}`);
    const app = routes(caller(w, w.owner.id));
    for (const hash of [
      pending.hash,
      approved.hash,
      theirs.hash,
      "f".repeat(64),
      "../etc",
      "A".repeat(64),
    ])
      expect((await app.request(`/${hash}`)).status, hash).toBe(404);
  });

  it("serves the caller's own personal skill, unless the team switched them off", async () => {
    const w = await f.world();
    const mine = await upload(w.owner, "personal", `own-${unique()}`);
    const app = routes(caller(w, w.owner.id));
    expect((await app.request(`/${mine.hash}`)).status).toBe(200);
    await f.on(0, w.owner).put("/v1/team/skill-review/settings", {
      personalSkillsDisabled: true,
    });
    expect((await app.request(`/${mine.hash}`)).status).toBe(404);
  });

  it("refuses a caller that is not a live sandbox", async () => {
    const denied = Object.assign(
      () => Promise.resolve<AuthResult>({ ok: false, reason: "invalid" }),
      { forget() {} },
    );
    expect((await routes(denied).request(`/${"a".repeat(64)}`)).status).toBe(401);
  });
});
