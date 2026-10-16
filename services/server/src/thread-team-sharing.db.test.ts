import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunFixture, type RunWorld } from "./testing/run-fixture.js";
import { SseReader } from "./testing/sse.js";
import type { Person } from "./testing/event-stream-fixture.js";

/**
 * KOBE-221 (CE20): share scope none / project / team. The author is a plain member; `w.owner` is
 * the team admin, who reads only what is shared like anyone else. Readers never write; revoking
 * takes effect at once, including open event streams (the periodic revalidation is set far away
 * here, so only the access hint can end them in time).
 */
const f = new RunFixture();

beforeAll(async () => {
  await f.setup({ streamTimings: { keepaliveMs: 50, revalidateMs: 60_000 } });
});
afterAll(async () => {
  await f.teardown();
});

const as = (p: Person) => f.on(0, p);

/** A team: admin (`w.owner`), author and reader (plain members), one finished run by the author. */
async function world(settle = true) {
  const w = await f.world();
  const author = await f.member(w.team);
  const reader = await f.member(w.team);
  const made = await as(author).post("/v1/threads", { title: "plan" });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const threadId = made.json.thread_id as string;
  const authorWorld: RunWorld = {
    team: w.team,
    owner: author,
    target: { teamId: w.team, userId: author.id },
  };
  const ws = await f.connect(authorWorld, 0);
  const runId = await f.message(author, threadId, "hello wombat");
  const start = await ws.started(runId);
  const entries = ws.reply(start, "world", settle);
  await ws.acked(runId);
  if (settle) await f.until(w.team, runId, "completed");
  return { w, admin: w.owner, author, reader, threadId, runId, entries };
}

async function audit(team: string) {
  const { rows } = await f.fx.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'thread.sharing_changed'
      ORDER BY seq`,
    [team],
  );
  return rows.map((r) => r.target);
}

const share = (p: Person, threadId: string, visibility: string) =>
  as(p).post(`/v1/threads/${threadId}/share`, { visibility });

const sharedIds = async (p: Person) => {
  const res = await as(p).get("/v1/threads/shared");
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return (res.json.threads as { thread_id: string }[]).map((t) => t.thread_id);
};

const searchIds = async (p: Person, q: string) => {
  const res = await as(p).get(`/v1/threads?q=${q}`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return (res.json.threads as { thread_id: string }[]).map((t) => t.thread_id);
};

/** Every read path of a thread, as `p`: the statuses in order. */
async function readStatuses(p: Person, threadId: string, runId: string) {
  const t = `/v1/threads/${threadId}`;
  const b = as(p);
  return [
    (await b.get(t)).status,
    (await b.get(`${t}/entries`)).status,
    (await b.get(`${t}/card`)).status,
    (await b.get(`${t}/markers`)).status,
    (await b.get(`${t}/runs`)).status,
    (await b.get(`${t}/usage`)).status,
    (await b.get(`/v1/artifacts?thread_id=${threadId}`)).status,
    (await b.get(`/v1/runs/${runId}`)).status,
  ];
}

const ALL_OK = [200, 200, 200, 200, 200, 200, 200, 200];
const ALL_GONE = [404, 404, 404, 404, 404, 404, 404, 404];

/** Waits up to `ms` for the stream to end. */
async function endsWithin(sse: SseReader, ms: number): Promise<boolean> {
  return Promise.race([
    sse.rest().then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms)),
  ]);
}

describe("team share (ac-1)", () => {
  it("shares with the team, read-only with the author's name, forkable, and revoked everywhere", async () => {
    const x = await world();
    const t = `/v1/threads/${x.threadId}`;
    expect(await readStatuses(x.reader, x.threadId, x.runId)).toEqual(ALL_GONE);

    const shared = await share(x.author, x.threadId, "team");
    expect(shared.status, JSON.stringify(shared.json)).toBe(200);
    expect(shared.json).toMatchObject({ visibility: "team", shared_to_project: false });

    expect(await readStatuses(x.reader, x.threadId, x.runId)).toEqual(ALL_OK);
    const seen = await as(x.reader).get(t);
    expect(seen.json).toMatchObject({ read_only: true, visibility: "team" });
    expect(seen.json.owner_name).toEqual(expect.any(String));
    expect((await as(x.author).get(t)).json).toMatchObject({ read_only: false, owner_name: null });
    expect(await sharedIds(x.reader)).toContain(x.threadId);
    expect(await sharedIds(x.author)).not.toContain(x.threadId);
    expect(await searchIds(x.reader, "wombat")).toContain(x.threadId);

    const fork = await as(x.reader).post(`${t}/fork`, {});
    expect(fork.status, JSON.stringify(fork.json)).toBe(201);
    const mine = await as(x.reader).get(`/v1/threads/${fork.json.thread_id}`);
    expect(mine.json).toMatchObject({ read_only: false, visibility: "private" });
    expect((await as(x.author).get(`/v1/threads/${fork.json.thread_id}`)).status).toBe(404);

    const back = await share(x.author, x.threadId, "private");
    expect(back.json.visibility).toBe("private");
    expect(await readStatuses(x.reader, x.threadId, x.runId)).toEqual(ALL_GONE);
    expect(await sharedIds(x.reader)).not.toContain(x.threadId);
    expect(await searchIds(x.reader, "wombat")).not.toContain(x.threadId);
    expect((await as(x.reader).post(`${t}/fork`, {})).status).toBe(404);
    // The fork keeps its own copy but no longer names the source.
    const after = await as(x.reader).get(`/v1/threads/${fork.json.thread_id}`);
    expect(after.json.forked_from_thread_id).toBeNull();

    expect(await audit(x.w.team)).toEqual([
      { threadId: x.threadId, projectId: null, shared: true, visibility: "team", from: "private" },
      { threadId: x.threadId, projectId: null, shared: false, visibility: "private", from: "team" },
    ]);
  });

  it("switches between project and team scope, one scope at a time, each audited", async () => {
    const x = await world();
    const outsider = x.reader;
    const member = await f.member(x.w.team);
    const project = await as(x.admin).post("/v1/projects", {
      name: `P${randomBytes(2).toString("hex")}`,
      members_mode: "selected",
      member_user_ids: [x.author.id, member.id],
    });
    expect(project.status, JSON.stringify(project.json)).toBe(201);
    const projectId = project.json.id as string;
    const moved = await as(x.author).post(`/v1/threads/${x.threadId}/move`, {
      project_id: projectId,
    });
    expect(moved.status, JSON.stringify(moved.json)).toBe(200);

    await share(x.author, x.threadId, "project");
    expect(await sharedIds(member)).toContain(x.threadId);
    expect(await sharedIds(outsider)).not.toContain(x.threadId);
    const inProject = await as(member).get(`/v1/threads?project_id=${projectId}`);
    expect(inProject.json.threads.map((r: { thread_id: string }) => r.thread_id)).toContain(
      x.threadId,
    );

    const team = await share(x.author, x.threadId, "team");
    expect(team.json).toMatchObject({ visibility: "team", shared_to_project: false });
    expect(await sharedIds(outsider)).toContain(x.threadId);
    expect(await sharedIds(member)).toContain(x.threadId);

    await share(x.author, x.threadId, "project");
    expect(await sharedIds(outsider)).not.toContain(x.threadId);
    expect((await as(outsider).get(`/v1/threads/${x.threadId}`)).status).toBe(404);

    // A move keeps a team share (its readers don't depend on the project) and ends a project one.
    await share(x.author, x.threadId, "team");
    await as(x.author).post(`/v1/threads/${x.threadId}/move`, { project_id: null });
    expect((await as(x.author).get(`/v1/threads/${x.threadId}`)).json.visibility).toBe("team");

    expect((await audit(x.w.team)).map((a) => [a.from, a.visibility])).toEqual([
      ["private", "project"],
      ["project", "team"],
      ["team", "project"],
      ["project", "team"],
    ]);
    expect((await share(x.author, x.threadId, "public")).status).toBe(400);
  });

  it("hides a shared thread in Trash and brings it back on restore", async () => {
    const x = await world();
    await share(x.author, x.threadId, "team");
    expect((await as(x.author).delete(`/v1/threads/${x.threadId}`)).status).toBe(200);
    expect(await readStatuses(x.reader, x.threadId, x.runId)).toEqual(ALL_GONE);
    expect(await sharedIds(x.reader)).not.toContain(x.threadId);
    await as(x.author).post(`/v1/threads/${x.threadId}/restore`, {});
    expect(await sharedIds(x.reader)).toContain(x.threadId);
  });
});

describe("a reader never writes", () => {
  it("answers 403 read_only on every change to a team-shared thread", async () => {
    const x = await world();
    await share(x.author, x.threadId, "team");
    const t = `/v1/threads/${x.threadId}`;
    const r = as(x.reader);
    const attempts = {
      rename: await r.patch(t, { title: "mine now" }),
      unshare: await r.patch(t, { shared_to_project: false }),
      model: await r.patch(t, { model: null }),
      leaf: await r.post(`${t}/leaf`, { entry_id: x.entries.user }),
      agentVersion: await r.post(`${t}/agent-version`, {}),
      trash: await r.delete(t),
      restore: await r.post(`${t}/restore`, {}),
      send: await r.post(`${t}/messages`, { content: "hi" }),
      regenerate: await r.post(`${t}/messages`, {
        content: "again",
        parent_entry_id: x.entries.user,
      }),
      compact: await r.post(`${t}/compact`, {}),
      pin: await r.post(`${t}/pin`, {}),
      unpin: await r.post(`${t}/unpin`, {}),
      archive: await r.post(`${t}/archive`, {}),
      unarchive: await r.post(`${t}/unarchive`, {}),
      move: await r.post(`${t}/move`, { project_id: null }),
      share: await r.post(`${t}/share`, { visibility: "private" }),
      resume: await r.post(`${t}/queue/resume`, {}),
      pause: await r.post(`${t}/queue/pause`, {}),
      order: await r.post(`${t}/queue/order`, { run_ids: [x.runId] }),
      steer: await r.post(`/v1/runs/${x.runId}/steer`, { content: "x" }),
      cancel: await r.post(`/v1/runs/${x.runId}/cancel`, {}),
      retry: await r.post(`/v1/runs/${x.runId}/retry`, {}),
      edit: await r.patch(`/v1/runs/${x.runId}`, { content: "x" }),
    };
    for (const [name, res] of Object.entries(attempts)) {
      expect([res.status, res.json.code], `${name}: ${JSON.stringify(res.json)}`).toEqual([
        403,
        "read_only",
      ]);
    }
    expect((await r.post(`${t}/purge`, {})).status).toBe(404);
    const still = await as(x.author).get(t);
    expect(still.json).toMatchObject({
      title: "plan",
      deleted_at: null,
      visibility: "team",
      pinned_at: null,
      archived_at: null,
    });
  });
});

describe("team admins and other teams (ac-3)", () => {
  it("shows a team admin only shared threads, never private ones", async () => {
    const x = await world();
    expect(await readStatuses(x.admin, x.threadId, x.runId)).toEqual(ALL_GONE);
    expect(await sharedIds(x.admin)).not.toContain(x.threadId);
    expect(await searchIds(x.admin, "wombat")).not.toContain(x.threadId);
    expect((await as(x.admin).post(`/v1/threads/${x.threadId}/fork`, {})).status).toBe(404);
    await share(x.author, x.threadId, "team");
    expect(await readStatuses(x.admin, x.threadId, x.runId)).toEqual(ALL_OK);
    expect(await sharedIds(x.admin)).toContain(x.threadId);
    const asAdmin = await as(x.admin).patch(`/v1/threads/${x.threadId}`, { title: "admin" });
    expect([asAdmin.status, asAdmin.json.code]).toEqual([403, "read_only"]);
  });

  it("never lets another team read a team-shared thread, not even a member of both", async () => {
    const x = await world();
    await share(x.author, x.threadId, "team");
    const other = await f.world();
    const stranger = await f.member(other.team);
    // In both teams, signed in with the other team active.
    const both = await f.member(other.team);
    await f.fx.addMember(x.w.team, both);
    for (const p of [stranger, both, other.owner]) {
      expect(await readStatuses(p, x.threadId, x.runId)).toEqual(ALL_GONE);
      expect(await sharedIds(p)).not.toContain(x.threadId);
      expect(await searchIds(p, "wombat")).not.toContain(x.threadId);
      expect((await as(p).post(`/v1/threads/${x.threadId}/fork`, {})).status).toBe(404);
      expect((await f.fx.open(0, p, x.runId)).status).toBe(404);
    }
    // Claiming the thread's team without switching to it is refused before any read.
    const claimed = as(stranger);
    claimed.team = x.w.team;
    expect((await claimed.get(`/v1/threads/${x.threadId}`)).status).not.toBe(200);
  });
});

describe("revocation reaches open streams at once", () => {
  it("ends a reader's live stream on revoke and on narrowing to the project", async () => {
    for (const how of ["revoke", "narrow"] as const) {
      const x = await world(false);
      if (how === "narrow") {
        const project = await as(x.admin).post("/v1/projects", {
          name: `N${randomBytes(2).toString("hex")}`,
          members_mode: "selected",
          member_user_ids: [x.author.id],
        });
        expect(project.status, JSON.stringify(project.json)).toBe(201);
        // The run is live, so the move waits: put the project on the thread directly.
        await f.fx.admin.query(
          `UPDATE threads SET project_id = $1 WHERE team_id = $2 AND id = $3`,
          [project.json.id, x.w.team, x.threadId],
        );
      }
      await share(x.author, x.threadId, "team");
      const res = await f.fx.open(0, x.reader, x.runId);
      expect(res.status, how).toBe(200);
      const sse = new SseReader(res.body);
      expect((await sse.nextEvent())?.run_id).toBe(x.runId);
      if (how === "revoke") await share(x.author, x.threadId, "private");
      if (how === "narrow") await share(x.author, x.threadId, "project");
      // revalidateMs is 60 s here: only the access hint ends it this fast.
      expect(await endsWithin(sse, 5_000), how).toBe(true);
    }
  });

  it("sends the access hint from the real Trash and move paths, for a run that just ended", async () => {
    const heard: string[] = [];
    const listen = (msg: { channel: string; payload?: string | undefined }) => {
      if (msg.channel === "kobe_run_events" && msg.payload?.startsWith("access:")) {
        heard.push(msg.payload);
      }
    };
    f.fx.admin.on("notification", listen);
    await f.fx.admin.query("LISTEN kobe_run_events");
    try {
      // Trash of a team-shared thread.
      const a = await world();
      await share(a.author, a.threadId, "team");
      heard.length = 0;
      expect((await as(a.author).delete(`/v1/threads/${a.threadId}`)).status).toBe(200);
      await expect.poll(() => heard, { timeout: 2_000 }).toContain(`access:${a.runId}`);

      // A move ending a project share.
      const b = await world();
      const project = await as(b.admin).post("/v1/projects", {
        name: `M${randomBytes(2).toString("hex")}`,
        members_mode: "selected",
        member_user_ids: [b.author.id, b.reader.id],
      });
      expect(project.status, JSON.stringify(project.json)).toBe(201);
      await as(b.author).post(`/v1/threads/${b.threadId}/move`, { project_id: project.json.id });
      await share(b.author, b.threadId, "project");
      heard.length = 0;
      const moved = await as(b.author).post(`/v1/threads/${b.threadId}/move`, {
        project_id: null,
      });
      expect(moved.status, JSON.stringify(moved.json)).toBe(200);
      await expect.poll(() => heard, { timeout: 2_000 }).toContain(`access:${b.runId}`);
      expect((await as(b.reader).get(`/v1/threads/${b.threadId}`)).status).toBe(404);

      // Nothing is sent for a private thread's Trash (no reader to tell).
      const c = await world();
      heard.length = 0;
      await as(c.author).delete(`/v1/threads/${c.threadId}`);
      await new Promise((r) => setTimeout(r, 200));
      expect(heard).not.toContain(`access:${c.runId}`);
    } finally {
      f.fx.admin.off("notification", listen);
      await f.fx.admin.query("UNLISTEN kobe_run_events");
    }
  });

  it("keeps the author's own stream open when they revoke", async () => {
    const x = await world(false);
    await share(x.author, x.threadId, "team");
    const res = await f.fx.open(0, x.author, x.runId);
    expect(res.status).toBe(200);
    const sse = new SseReader(res.body);
    expect((await sse.nextEvent())?.run_id).toBe(x.runId);
    await share(x.author, x.threadId, "private");
    expect(await endsWithin(sse, 1_000)).toBe(false);
  });
});

describe("more read paths (S3)", () => {
  it("follows the scope for tool output, pending drafts, shared files and artifacts", async () => {
    const x = await world(false);
    // A queued draft of the author's: never shown to a reader.
    const queued = await f.send(x.author, x.threadId, "a second question");
    expect(queued.status, JSON.stringify(queued.json)).toBe(201);
    const fileId = randomUUID();
    await f.fx.admin.query(
      `INSERT INTO files (team_id, id, user_id, thread_id, kind, name, size_bytes, sha256, mime_type, blob_ref)
       VALUES ($1, $2, $3, $4, 'shared', 'r.txt', 1, $5, 'text/plain', 'k')`,
      [x.w.team, fileId, x.author.id, x.threadId, "a".repeat(64)],
    );
    const artifactId = randomUUID();
    await f.fx.admin.query(
      `INSERT INTO artifacts (team_id, id, thread_id, created_by, kind, title)
       VALUES ($1, $2, $3, $4, 'markdown', 'Notes')`,
      [x.w.team, artifactId, x.threadId, x.author.id],
    );
    await f.fx.admin.query(
      `INSERT INTO artifact_versions (team_id, artifact_id, version, thread_id, blob_ref, size_bytes,
                                      sha256, run_id, tool_call_id)
       VALUES ($1, $2, 1, $3, 'k', 1, $4, $5, $6)`,
      [x.w.team, artifactId, x.threadId, "b".repeat(64), x.runId, `tc-${artifactId}`],
    );
    const t = `/v1/threads/${x.threadId}`;
    const statuses = async (p: Person) => {
      const b = as(p);
      return [
        (await b.get(`${t}/entries/${x.entries.user}/output`)).status,
        (await b.get(`${t}/pending-messages`)).status,
        (await b.get(`/v1/files/${fileId}`)).status,
        (await b.get(`/v1/files/${fileId}/content`)).status,
        (await b.get(`/v1/artifacts/${artifactId}`)).status,
        (await b.get(`/v1/artifacts/${artifactId}/versions/1/content`)).status,
        (await b.get(`/v1/artifacts/${artifactId}/versions/1/frame?team=${x.w.team}`)).status,
      ];
    };
    // Shared: past the access check (a user message is no tool output; no object storage here).
    const open = [409, 200, 200, 503, 200, 503, 503];
    const closed = [404, 404, 404, 404, 404, 404, 404];
    expect(await statuses(x.author)).toEqual(open);
    expect(await statuses(x.reader)).toEqual(closed);
    await share(x.author, x.threadId, "team");
    expect(await statuses(x.reader)).toEqual(open);
    // The author's queued draft is theirs only; a reader sees at most the running prompt.
    const queuedOf = async (p: Person) =>
      ((await as(p).get(`${t}/pending-messages`)).json.messages as { status: string }[]).filter(
        (m) => m.status === "queued",
      );
    expect(await queuedOf(x.reader)).toEqual([]);
    expect(await queuedOf(x.author)).toHaveLength(1);
    await share(x.author, x.threadId, "private");
    expect(await statuses(x.reader)).toEqual(closed);
  });

  it("never lets a team reader decide the author's approval", async () => {
    const x = await world();
    await share(x.author, x.threadId, "team");
    const approvalId = randomUUID();
    await f.fx.admin.query(
      `INSERT INTO approvals (team_id, id, run_id, thread_id, user_id, connection_id, tool_call_id,
                              tool, input_canonical, risk, reasons, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, gen_random_uuid(), 'tc-1', 'bash', '{}', 'write', '[]',
               'pending', now() + interval '1 hour')`,
      [x.w.team, approvalId, x.runId, x.threadId, x.author.id],
    );
    // Decided by its asker only: to anyone else it does not exist (as for project readers).
    const tried = await as(x.reader).post(`/v1/approvals/${approvalId}`, { decision: "allow" });
    expect(tried.status).toBe(404);
    expect((await as(x.reader).get("/v1/approvals")).json.approvals).toEqual([]);
    const still = await f.fx.admin.query(`SELECT status FROM approvals WHERE id = $1`, [
      approvalId,
    ]);
    expect(still.rows[0]).toEqual({ status: "pending" });
  });

  it("refuses to share a builder test thread", async () => {
    const x = await world();
    await f.fx.admin.query(`UPDATE threads SET is_test = true WHERE team_id = $1 AND id = $2`, [
      x.w.team,
      x.threadId,
    ]);
    const refused = await share(x.author, x.threadId, "team");
    expect([refused.status, refused.json.code]).toEqual([409, "test_thread"]);
  });

  it("hides the project of a team-shared thread from someone who can't open it (N4)", async () => {
    const x = await world();
    const project = await as(x.admin).post("/v1/projects", {
      name: `H${randomBytes(2).toString("hex")}`,
      members_mode: "selected",
      member_user_ids: [x.author.id],
    });
    expect(project.status, JSON.stringify(project.json)).toBe(201);
    const projectId = project.json.id as string;
    await as(x.author).post(`/v1/threads/${x.threadId}/move`, { project_id: projectId });
    await share(x.author, x.threadId, "team");
    expect((await as(x.reader).get(`/v1/threads/${x.threadId}`)).json.project_id).toBeNull();
    const listed = (await as(x.reader).get("/v1/threads/shared")).json.threads as {
      thread_id: string;
      project_id: string | null;
    }[];
    expect(listed.find((r) => r.thread_id === x.threadId)?.project_id).toBeNull();
    const found = (await as(x.reader).get("/v1/threads?q=wombat")).json.threads as {
      thread_id: string;
      project_id: string | null;
    }[];
    expect(found.find((r) => r.thread_id === x.threadId)?.project_id).toBeNull();
    // Listing or searching that project shows them nothing of it.
    expect((await as(x.reader).get(`/v1/threads?project_id=${projectId}`)).json.threads).toEqual(
      [],
    );
    expect(
      (await as(x.reader).get(`/v1/threads?q=wombat&project_id=${projectId}`)).json.threads,
    ).toEqual([]);
    // The author and a team admin (who may open every project) still see it.
    expect((await as(x.author).get(`/v1/threads/${x.threadId}`)).json.project_id).toBe(projectId);
    expect((await as(x.admin).get(`/v1/threads/${x.threadId}`)).json.project_id).toBe(projectId);
  });
});

describe("a member who leaves (S2)", () => {
  /** Collects the access hints (`access:<run>`) sent while `fn` runs. */
  async function hintsDuring(fn: () => Promise<void>): Promise<string[]> {
    const heard: string[] = [];
    const listen = (msg: { channel: string; payload?: string | undefined }) => {
      if (msg.channel === "kobe_run_events" && msg.payload?.startsWith("access:")) {
        heard.push(msg.payload);
      }
    };
    f.fx.admin.on("notification", listen);
    await f.fx.admin.query("LISTEN kobe_run_events");
    try {
      await fn();
      await new Promise((r) => setTimeout(r, 300));
      return heard;
    } finally {
      f.fx.admin.off("notification", listen);
      await f.fx.admin.query("UNLISTEN kobe_run_events");
    }
  }

  /** The newest `thread.sharing_changed` rows of the team, with their actor kind. */
  async function sharingRows(team: string) {
    const { rows } = await f.fx.admin.query<{
      actor_kind: string;
      target: Record<string, unknown>;
    }>(
      `SELECT actor_kind, target FROM audit_log
        WHERE team_id = $1 AND action = 'thread.sharing_changed' ORDER BY seq`,
      [team],
    );
    return rows;
  }

  /** Every way `p` could read the thread: its read paths, Shared with me, search, the stream. */
  async function unreadable(p: Person, threadId: string, runId: string) {
    expect(await readStatuses(p, threadId, runId)).toEqual(ALL_GONE);
    expect(await sharedIds(p)).not.toContain(threadId);
    expect(await searchIds(p, "wombat")).not.toContain(threadId);
    expect((await f.fx.open(0, p, runId)).status).toBe(404);
  }

  it("ends their team and project shares on removal, audited as the system, streams told", async () => {
    const x = await world();
    await share(x.author, x.threadId, "team");
    const project = await as(x.admin).post("/v1/projects", {
      name: `L${randomBytes(2).toString("hex")}`,
      members_mode: "selected",
      member_user_ids: [x.author.id, x.reader.id],
    });
    expect(project.status, JSON.stringify(project.json)).toBe(201);
    const inProject = await as(x.author).post("/v1/threads", {
      project_id: project.json.id,
      title: "p",
    });
    const projectThread = inProject.json.thread_id as string;
    await share(x.author, projectThread, "project");
    expect((await as(x.reader).get(`/v1/threads/${projectThread}`)).status).toBe(200);

    const heard = await hintsDuring(async () => {
      const removed = await as(x.admin).delete(`/v1/team/members/${x.author.id}`);
      expect(removed.status, JSON.stringify(removed.json)).toBe(204);
    });
    expect(heard).toContain(`access:${x.runId}`);
    await unreadable(x.reader, x.threadId, x.runId);
    await unreadable(x.admin, x.threadId, x.runId);
    expect((await as(x.reader).get(`/v1/threads/${projectThread}`)).status).toBe(404);
    const ended = (await sharingRows(x.w.team)).slice(-2);
    expect(ended).toEqual(
      expect.arrayContaining([
        {
          actor_kind: "system",
          target: {
            threadId: x.threadId,
            projectId: null,
            shared: false,
            visibility: "private",
            from: "team",
          },
        },
        {
          actor_kind: "system",
          target: {
            threadId: projectThread,
            projectId: project.json.id,
            shared: false,
            visibility: "private",
            from: "project",
          },
        },
      ]),
    );
  });

  it("ends their shares in every team on deactivation, streams told", async () => {
    const x = await world();
    await share(x.author, x.threadId, "team");
    // The author is in a second team too, with a team-shared thread there.
    const other = await f.world();
    await f.fx.addMember(other.team, x.author);
    const { rows } = await f.fx.admin.query<{ id: string }>(
      `INSERT INTO threads (team_id, owner_user_id, title, shared_to_team)
       VALUES ($1, $2, 'there', true) RETURNING id`,
      [other.team, x.author.id],
    );
    const there = rows[0]?.id ?? "";
    expect((await as(other.owner).get(`/v1/threads/${there}`)).status).toBe(200);
    const siteAdmin = await f.member(x.w.team);
    await f.fx.admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [
      siteAdmin.id,
    ]);
    const heard = await hintsDuring(async () => {
      const off = await as(siteAdmin).post(`/v1/site/users/${x.author.id}/deactivate`, {});
      expect(off.status, JSON.stringify(off.json)).toBeLessThan(300);
      expect(off.json.incompleteSteps ?? off.json.incomplete_steps ?? []).not.toContain(
        "thread-shares",
      );
    });
    expect(heard).toContain(`access:${x.runId}`);
    await unreadable(x.reader, x.threadId, x.runId);
    expect((await as(other.owner).get(`/v1/threads/${there}`)).status).toBe(404);
    for (const [team, threadId] of [
      [x.w.team, x.threadId],
      [other.team, there],
    ] as const) {
      expect((await sharingRows(team)).at(-1)).toEqual({
        actor_kind: "system",
        target: { threadId, projectId: null, shared: false, visibility: "private", from: "team" },
      });
    }
  });
});

describe("a share counts only while its owner is an active member (R1 backstop)", () => {
  it("ignores a share that committed after the owner's removal", async () => {
    const x = await world();
    const removed = await as(x.admin).delete(`/v1/team/members/${x.author.id}`);
    expect(removed.status).toBe(204);
    // The owner's share request passed its checks before the removal and committed after it.
    await f.fx.admin.query(
      `UPDATE threads SET shared_to_team = true WHERE team_id = $1 AND id = $2`,
      [x.w.team, x.threadId],
    );
    expect(await readStatuses(x.reader, x.threadId, x.runId)).toEqual(ALL_GONE);
    expect(await sharedIds(x.reader)).not.toContain(x.threadId);
    expect(await searchIds(x.reader, "wombat")).not.toContain(x.threadId);
    expect((await f.fx.open(0, x.reader, x.runId)).status).toBe(404);
  });

  it("ignores the shares of a deactivated owner even when ending them failed", async () => {
    const x = await world();
    await share(x.author, x.threadId, "team");
    expect((await f.fx.open(0, x.reader, x.runId)).status).not.toBe(404);
    // Deactivated, but none of the lifecycle steps ran (as when the thread-shares step failed).
    await f.fx.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [x.author.id]);
    expect(await readStatuses(x.reader, x.threadId, x.runId)).toEqual(ALL_GONE);
    expect(await sharedIds(x.reader)).not.toContain(x.threadId);
    expect(await searchIds(x.reader, "wombat")).not.toContain(x.threadId);
    expect((await f.fx.open(0, x.reader, x.runId)).status).toBe(404);
    // The share itself is untouched: reactivation shows it again.
    await f.fx.admin.query(`UPDATE users SET deactivated_at = NULL WHERE id = $1`, [x.author.id]);
    expect((await as(x.reader).get(`/v1/threads/${x.threadId}`)).status).toBe(200);
  });

  it("checks the owner with the membership and user primary keys", async () => {
    await f.fx.admin.query("BEGIN");
    try {
      await f.fx.admin.query("SET LOCAL enable_seqscan = off");
      const { rows } = await f.fx.admin.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (FORMAT JSON)
         SELECT t.id FROM threads t
          WHERE t.team_id = gen_random_uuid() AND t.shared_to_team
            AND EXISTS (SELECT 1 FROM team_members m JOIN users u ON u.id = m.user_id
                         WHERE m.team_id = t.team_id AND m.user_id = t.owner_user_id
                           AND u.deactivated_at IS NULL)`,
      );
      const plan = JSON.stringify(rows[0]?.["QUERY PLAN"]);
      expect(plan).toMatch(/"Index Name":"team_members_[a-z_]*pk[a-z]*"/);
      expect(plan).toMatch(/"Index Name":"users_pkey"/);
    } finally {
      await f.fx.admin.query("ROLLBACK");
    }
  });
});
