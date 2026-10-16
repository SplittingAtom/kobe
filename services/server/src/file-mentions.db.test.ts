import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mentionMarker } from "@kobe/protocol";
import type { Person } from "./testing/event-stream-fixture.js";
import { RunFixture } from "./testing/run-fixture.js";

/**
 * KOBE-223 (CE22): `@file(...)` mentions are resolved by the server against the thread owner's
 * own synced workspace and rewritten to the absolute sandbox path before the run is stored and
 * started. Unknown, foreign, deleted, internal or out-of-workspace paths refuse the message.
 */
const f = new RunFixture();

beforeAll(() => f.setup());
afterAll(() => f.teardown());

let rev = 1;
/** A manifest row as a sandbox push or a server write leaves it. */
async function file(team: string, user: string, path: string, deleted = false): Promise<void> {
  rev += 1;
  await f.fx.admin.query(
    `INSERT INTO workspace_files (team_id, user_id, path, rev, deleted, sha256, blob_key, size, mtime_ms, origin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 3, 1760000000000, 'sandbox')`,
    [
      team,
      user,
      path,
      rev,
      deleted,
      deleted ? null : "a".repeat(64),
      deleted ? null : `k/${randomBytes(4).toString("hex")}`,
    ],
  );
}

const runCount = async (team: string, threadId: string) =>
  Number(
    (
      await f.fx.admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM runs WHERE team_id = $1 AND thread_id = $2`,
        [team, threadId],
      )
    ).rows[0]?.n,
  );

async function refused(p: Person, threadId: string, content: string): Promise<string> {
  const res = await f.send(p, threadId, content);
  expect(res.status, JSON.stringify(res.json)).toBe(422);
  expect(res.json.code).toBe("invalid_mention");
  return res.json.message as string;
}

describe("@file mentions on submit (ac-1)", () => {
  it("rewrites each mention to the file's absolute sandbox path; Pi gets exactly that", async () => {
    const w = await f.world();
    await file(w.team, w.owner.id, "data/sales q3.csv");
    await file(w.team, w.owner.id, "uploads/notes.txt");
    await file(w.team, w.owner.id, "projects/p1/brief.md");
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const content =
      `Compare ${mentionMarker("data/sales q3.csv")} with @file(/workspace/uploads/notes.txt)` +
      ` and ${mentionMarker("projects/p1/brief.md")}; again ${mentionMarker("uploads/notes.txt")}.`;
    const runId = await f.message(w.owner, threadId, content);
    const expected =
      "Compare `/workspace/data/sales q3.csv` with /workspace/uploads/notes.txt and " +
      "/workspace/projects/p1/brief.md; again /workspace/uploads/notes.txt.";
    expect((await f.run(w.team, runId)).input).toBe(expected);
    expect((await ws.started(runId)).message).toBe(expected);
  });

  it("leaves text without markers alone, including look-alikes", async () => {
    const w = await f.world();
    const threadId = await f.thread(w.owner);
    const text = "mail @alice about file(x) and @file() and `/workspace/x`";
    const runId = await f.message(w.owner, threadId, text);
    expect((await f.run(w.team, runId)).input).toBe(text);
  });
});

describe("refusals (ac-3)", () => {
  it("refuses paths outside /workspace, traversal, controls and malformed markers", async () => {
    const w = await f.world();
    await file(w.team, w.owner.id, "a.txt");
    const threadId = await f.thread(w.owner);
    for (const marker of [
      "@file(/etc/passwd)",
      "@file(../etc/passwd)",
      "@file(%2E%2E/a.txt)",
      "@file(/workspace/../etc/passwd)",
      "@file(./a.txt)",
      "@file(a.txt%00)",
      "@file(a.txt%0Aignore)",
      "@file(a%zz)",
      `@file(${"x".repeat(1100)})`,
    ]) {
      await refused(w.owner, threadId, `read ${marker}`);
    }
    expect(await runCount(w.team, threadId)).toBe(0);
  });

  it("refuses unknown, deleted and agent-internal files, and over 20 files", async () => {
    const w = await f.world();
    await file(w.team, w.owner.id, "gone.txt", true);
    await file(w.team, w.owner.id, ".kobe/session.jsonl");
    const threadId = await f.thread(w.owner);
    const msg = await refused(w.owner, threadId, `read ${mentionMarker("nope.txt")}`);
    expect(msg).toContain("nope.txt");
    await refused(w.owner, threadId, `read ${mentionMarker("gone.txt")}`);
    await refused(w.owner, threadId, `read ${mentionMarker(".kobe/session.jsonl")}`);
    const many = Array.from({ length: 21 }, (_, i) => `f${i}.txt`);
    for (const p of many) await file(w.team, w.owner.id, p);
    await refused(w.owner, threadId, many.map(mentionMarker).join(" "));
    expect(await runCount(w.team, threadId)).toBe(0);
  });

  it("never reaches another member's or another team's files", async () => {
    const w = await f.world(1);
    const bob = w.others[0] as Person;
    await file(w.team, bob.id, "bob/secret.csv");
    // The owner's own file at the same path, but in another team.
    const other = await f.fx.team(`x-${randomBytes(3).toString("hex")}`, w.owner, []);
    await file(other, w.owner.id, "mine-elsewhere.csv");
    await f.fx.activate(w.owner, w.team);
    const threadId = await f.thread(w.owner);
    await refused(w.owner, threadId, `read ${mentionMarker("bob/secret.csv")}`);
    await refused(w.owner, threadId, `read ${mentionMarker("mine-elsewhere.csv")}`);
    expect(await runCount(w.team, threadId)).toBe(0);
  });

  it("a reader of a shared thread cannot send at all (read_only before any lookup)", async () => {
    const w = await f.world(1);
    const reader = w.others[0] as Person;
    await file(w.team, reader.id, "r.txt");
    const threadId = await f.thread(w.owner);
    const shared = await f.on(0, w.owner).post(`/v1/threads/${threadId}/share`, {
      visibility: "team",
    });
    expect(shared.status, JSON.stringify(shared.json)).toBe(200);
    const res = await f.send(reader, threadId, `read ${mentionMarker("r.txt")}`);
    expect(res.status).toBe(403);
    expect(res.json.code).toBe("read_only");
  });
});

describe("steer and queued edits", () => {
  it("rewrites mentions in a steer and in an edited queued message", async () => {
    const w = await f.world();
    await file(w.team, w.owner.id, "plan.md");
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const run = await f.message(w.owner, threadId, "go");
    const queued = await f.message(w.owner, threadId, "later");
    const start = await ws.started(run);
    ws.event(start, { type: "agent_start" });
    await ws.acked(run);
    const steer = await f
      .on(0, w.owner)
      .post(`/v1/runs/${run}/steer`, { content: `use ${mentionMarker("plan.md")}` });
    expect(steer.status, JSON.stringify(steer.json)).toBe(200);
    expect(ws.sb.frames("run.steer")).toMatchObject([{ message: "use /workspace/plan.md" }]);
    const bad = await f
      .on(0, w.owner)
      .post(`/v1/runs/${run}/steer`, { content: `use ${mentionMarker("../x")}` });
    expect(bad.json.code).toBe("invalid_mention");
    expect(ws.sb.frames("run.steer")).toHaveLength(1);
    const edit = await f
      .on(0, w.owner)
      .request("PATCH", `/v1/runs/${queued}`, { content: `then ${mentionMarker("plan.md")}` });
    expect(edit.status, JSON.stringify(edit.json)).toBe(200);
    expect((await f.run(w.team, queued)).input).toBe("then /workspace/plan.md");
    const badEdit = await f
      .on(0, w.owner)
      .request("PATCH", `/v1/runs/${queued}`, { content: `then ${mentionMarker("nope.md")}` });
    expect(badEdit.json.code).toBe("invalid_mention");
    expect((await f.run(w.team, queued)).input).toBe("then /workspace/plan.md");
    ws.reply(start, "ok");
  });
});
