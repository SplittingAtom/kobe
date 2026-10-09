import { randomUUID } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { exportZip } from "./retention/export.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memoryDocDetailSchema, memoryListResponseSchema, undoMemoryAction } from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { EventStreamFixture, PUBLIC_URL, type Person } from "./testing/event-stream-fixture.js";
import { TestBrowser } from "./testing/browser.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { runWithAuditContext } from "./audit/context.js";
import { writeMemory } from "./memory/store.js";
import { memoryBlobKey } from "./memory/keys.js";

/**
 * KOBE-155: /v1/memory end to end: owner-only personal memory, versions in S3, restore (Undo),
 * soft delete, the AND-ed switches, project seam, audit without content.
 */
const fx = new EventStreamFixture();
const objects = new MemoryObjects();
const PREFIX = "kobe/";
const blobs = { objects, prefix: PREFIX };

beforeAll(async () => {
  await fx.setup([{}], () => ({ blobs }));
});
afterAll(() => fx.teardown());

let n = 0;
async function world() {
  const admin = await fx.person(`adm${n++}`);
  const member = await fx.person(`mem${n}`);
  const other = await fx.person(`oth${n}`);
  const team = await fx.team(`t-mem-${n}`, admin, [member, other]);
  return { admin, member, other, team };
}

const put = (p: Person, path: string, content: string, extra: object = {}) =>
  p.browser.put("/v1/memory", { scope: "user", path, content, ...extra });
const auditOf = async (team: string, action: string) =>
  (
    await fx.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = $2 ORDER BY seq`,
      [team, action],
    )
  ).rows.map((r) => r.target);

describe("personal memory", () => {
  it("creates, versions and lists; content is in S3 outside thread trees", async () => {
    const w = await world();
    const a = await put(w.member, "prefs.md", "likes tea");
    expect(a.status, a.text).toBe(200);
    const d1 = memoryDocDetailSchema.parse(a.json);
    expect(d1).toMatchObject({
      scope: "user",
      path: "prefs.md",
      current_version: 1,
      content: "likes tea",
    });
    const b = await put(w.member, "prefs.md", "likes coffee", { expected_version: 1 });
    const d2 = memoryDocDetailSchema.parse(b.json);
    expect(d2.current_version).toBe(2);
    expect(d2.versions.map((v) => [v.version, v.source])).toEqual([
      [1, "panel"],
      [2, "panel"],
    ]);
    const key = memoryBlobKey(PREFIX, w.team, d1.id, 2);
    expect(objects.objects.get(key)?.toString()).toBe("likes coffee");
    expect(key).not.toContain("/threads/");
    const list = memoryListResponseSchema.parse(
      (await w.member.browser.get("/v1/memory?scope=user")).json,
    );
    expect(list.docs).toHaveLength(1);
    expect(list.docs[0]).toMatchObject({
      id: d1.id,
      current_version: 2,
      size_bytes: 12,
      updated_by: w.member.id,
    });
  });

  it("refuses a stale expected_version, oversized index and invalid input", async () => {
    const w = await world();
    await put(w.member, "a.md", "x");
    const stale = await put(w.member, "a.md", "y", { expected_version: 0 });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: "version_conflict", current_version: 1 });
    const index = await put(w.member, "MEMORY.md", Array(201).fill("- l").join("\n"));
    expect(index.status).toBe(422);
    expect(index.json).toMatchObject({ code: "index_full" });
    expect((await put(w.member, "MEMORY.md", Array(200).fill("- l").join("\n"))).status).toBe(200);
    expect((await put(w.member, "../x.md", "x")).status).toBe(400);
    expect((await put(w.member, "big.md", "x".repeat(64 * 1024 + 1))).status).toBe(400);
  });

  it("is visible only to its owner, team admins included", async () => {
    const w = await world();
    const doc = memoryDocDetailSchema.parse((await put(w.member, "secret.md", "mine")).json);
    for (const p of [w.other, w.admin]) {
      expect((await p.browser.get(`/v1/memory/${doc.id}`)).status).toBe(404);
      expect((await p.browser.delete(`/v1/memory/${doc.id}`)).status).toBe(404);
      expect((await p.browser.post(`/v1/memory/${doc.id}/restore`, { version: 1 })).status).toBe(
        404,
      );
      const list = memoryListResponseSchema.parse(
        (await p.browser.get("/v1/memory?scope=user")).json,
      );
      expect(list.docs).toEqual([]);
    }
    // The same path for another user is a different doc.
    const theirs = memoryDocDetailSchema.parse((await put(w.other, "secret.md", "theirs")).json);
    expect(theirs.id).not.toBe(doc.id);
  });

  it("restore makes a new version equal to the prior one and keeps history (Undo)", async () => {
    const w = await world();
    const d1 = memoryDocDetailSchema.parse((await put(w.member, "r.md", "one")).json);
    await put(w.member, "r.md", "two");
    const res = await w.member.browser.post(`/v1/memory/${d1.id}/restore`, { version: 1 });
    expect(res.status, res.text).toBe(200);
    const d = memoryDocDetailSchema.parse(res.json);
    expect(d).toMatchObject({ current_version: 3, content: "one" });
    expect(d.versions.map((v) => v.source)).toEqual(["panel", "panel", "restore"]);
    const { rows } = await fx.admin.query<{ version: number; sha256: string; blob_ref: string }>(
      `SELECT version, sha256, blob_ref FROM memory_doc_versions WHERE team_id = $1 AND doc_id = $2 ORDER BY version`,
      [w.team, d1.id],
    );
    expect(rows[2]?.sha256).toBe(rows[0]?.sha256);
    expect(rows[2]?.blob_ref).not.toBe(rows[0]?.blob_ref);
    expect(objects.objects.get(rows[2]!.blob_ref)?.toString()).toBe("one");
    expect((await auditOf(w.team, "memory.restored"))[0]).toEqual({
      scope: "user",
      memoryDocId: d1.id,
      fromVersion: 1,
      version: 3,
    });
    expect(
      (await w.member.browser.post(`/v1/memory/${d1.id}/restore`, { version: 9 })).status,
    ).toBe(404);
    // memory.updated drives Undo: previous_version restores, a created doc is deleted.
    expect(undoMemoryAction({ version: 2, previous_version: 1 })).toEqual({
      action: "restore",
      version: 1,
    });
  });

  it("delete is soft and audited; restore or a new write revives it", async () => {
    const w = await world();
    const d = memoryDocDetailSchema.parse((await put(w.member, "gone.md", "bye")).json);
    expect((await w.member.browser.delete(`/v1/memory/${d.id}`)).status).toBe(204);
    expect((await w.member.browser.get(`/v1/memory/${d.id}`)).status).toBe(404);
    expect((await w.member.browser.delete(`/v1/memory/${d.id}`)).status).toBe(404);
    const list = memoryListResponseSchema.parse(
      (await w.member.browser.get("/v1/memory?scope=user")).json,
    );
    expect(list.docs).toEqual([]);
    const { rows } = await fx.admin.query(
      `SELECT deleted_at FROM memory_docs WHERE team_id = $1 AND id = $2`,
      [w.team, d.id],
    );
    expect(rows[0].deleted_at).not.toBeNull();
    expect(await auditOf(w.team, "memory.deleted")).toEqual([
      { scope: "user", memoryDocId: d.id, version: 1 },
    ]);
    const back = await w.member.browser.post(`/v1/memory/${d.id}/restore`, { version: 1 });
    expect(memoryDocDetailSchema.parse(back.json)).toMatchObject({
      current_version: 2,
      content: "bye",
    });
    await w.member.browser.delete(`/v1/memory/${d.id}`);
    const again = memoryDocDetailSchema.parse((await put(w.member, "gone.md", "new")).json);
    expect(again).toMatchObject({ id: d.id, current_version: 3, content: "new" });
  });

  it("audits without content or path", async () => {
    const w = await world();
    await put(w.member, "audit-me.md", "TOP-SECRET-CONTENT");
    const events = await auditOf(w.team, "memory.written");
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(/TOP-SECRET|audit-me/);
    expect(events[0]).toMatchObject({
      scope: "user",
      version: 1,
      actorKind: "user",
      sizeBytes: 18,
    });
  });
});

describe("project memory", () => {
  it("is not reachable until the caller is a project member (seam)", async () => {
    const w = await world();
    const projectId = randomUUID();
    const res = await w.member.browser.put(`/v1/memory?project_id=${projectId}`, {
      scope: "project",
      path: "p.md",
      content: "x",
    });
    expect(res.status).toBe(404);
    expect(
      (await w.member.browser.get(`/v1/memory?scope=project&project_id=${projectId}`)).status,
    ).toBe(404);
    expect((await w.member.browser.get("/v1/memory?scope=project")).status).toBe(400);
  });
});

describe("agent writes through the service", () => {
  it("append, index cap on the result, project scope, agent source", async () => {
    const w = await world();
    const actor = { kind: "agent", userId: null, runId: randomUUID(), toolCallId: "tc1" } as const;
    const target = { scope: "user", ownerUserId: w.member.id } as const;
    const call = (path: string, content: string, mode?: "append") =>
      runWithAuditContext(
        { actor: { kind: "user", id: w.member.id }, ip: null, userAgent: null },
        () =>
          withTeam(fx.db, w.team, (tx) =>
            writeMemory(
              tx,
              blobs,
              w.team,
              target,
              { path, content, ...(mode ? { mode } : {}) },
              actor,
            ),
          ),
      );
    const first = await call("MEMORY.md", Array(199).fill("- l").join("\n"));
    expect(first).toMatchObject({ ok: true, version: 1 });
    const second = await call("MEMORY.md", "- m", "append");
    expect(second).toMatchObject({ ok: true, version: 2, previousVersion: 1 });
    expect(await call("MEMORY.md", "- n\n- o", "append")).toMatchObject({
      ok: false,
      code: "index_full",
    });
    const d = memoryDocDetailSchema.parse(
      (await w.member.browser.get(`/v1/memory/${(second as { docId: string }).docId}`)).json,
    );
    expect(d.content.split("\n")).toHaveLength(200);
    expect(d.versions.map((v) => v.source)).toEqual(["agent", "agent"]);
    // Project docs (no FK yet) are keyed by project id.
    const pid = randomUUID();
    const proj = await withTeam(fx.db, w.team, (tx) =>
      writeMemory(
        tx,
        blobs,
        w.team,
        { scope: "project", projectId: pid },
        { path: "p.md", content: "shared" },
        actor,
      ),
    );
    expect(proj).toMatchObject({ ok: true, version: 1 });
  });
});

describe("switches", () => {
  const settings = (p: Person, level: string, body?: object) =>
    body
      ? p.browser.put(`/v1/memory/settings?level=${level}`, body)
      : p.browser.get(`/v1/memory/settings?level=${level}`);

  async function installAdmin(): Promise<TestBrowser> {
    const email = `ia${n++}-${randomUUID().slice(0, 6)}@events.test`;
    await fx
      .replica(0)
      .deps.createUserWithPassword(
        { email, name: "ia", password: "a long enough password" },
        { installRole: "admin" },
      );
    const b = new TestBrowser(fx.replica(0).app, PUBLIC_URL);
    const res = await b.post("/api/auth/sign-in/email", {
      email,
      password: "a long enough password",
    });
    expect(res.status).toBe(200);
    return b;
  }

  it("team level: members read, only team admins change; a disabled scope refuses", async () => {
    const w = await world();
    expect((await settings(w.member, "team")).json).toEqual({
      memory_enabled: true,
      project_memory_enabled: true,
    });
    expect((await settings(w.member, "team", { memory_enabled: false })).status).toBe(403);
    const off = await settings(w.admin, "team", { memory_enabled: false });
    expect(off.json).toEqual({ memory_enabled: false, project_memory_enabled: true });
    expect(await auditOf(w.team, "memory.settings_changed")).toEqual([
      { memoryEnabled: false, projectMemoryEnabled: true },
    ]);
    const refused = await put(w.member, "x.md", "x");
    expect(refused.status).toBe(403);
    expect(refused.json).toMatchObject({ code: "memory_disabled" });
    expect((await w.member.browser.get("/v1/memory?scope=user")).status).toBe(403);
    expect((await settings(w.member, "effective")).json).toEqual({
      memory_enabled: false,
      project_memory_enabled: false,
    });
    expect((await settings(w.admin, "team", {})).status).toBe(400);
  });

  it("project switch off leaves personal memory on", async () => {
    const w = await world();
    await settings(w.admin, "team", { project_memory_enabled: false });
    expect((await put(w.member, "x.md", "x")).status).toBe(200);
    expect((await settings(w.member, "effective")).json).toEqual({
      memory_enabled: true,
      project_memory_enabled: false,
    });
  });

  it("install level is AND-ed with the team and needs an install admin", async () => {
    const w = await world();
    expect((await settings(w.admin, "install")).status).toBe(403);
    expect((await settings(w.admin, "install", { memory_enabled: false })).status).toBe(403);
    const ia = await installAdmin();
    try {
      const off = await settings({ browser: ia } as Person, "install", { memory_enabled: false });
      expect(off.json).toEqual({ memory_enabled: false, project_memory_enabled: true });
      expect((await put(w.member, "x.md", "x")).json).toMatchObject({ code: "memory_disabled" });
      await settings({ browser: ia } as Person, "install", { memory_enabled: true });
      expect((await put(w.member, "x.md", "x")).status).toBe(200);
      expect(
        await fx.admin.query(
          `SELECT 1 FROM audit_log WHERE action = 'memory.install_settings_changed'`,
        ),
      ).toMatchObject({ rowCount: 2 });
    } finally {
      await settings({ browser: ia } as Person, "install", {
        memory_enabled: true,
        project_memory_enabled: true,
      });
    }
  });
});

describe("export", () => {
  it("includes the caller's live personal memory only", async () => {
    const w = await world();
    await put(w.member, "prefs.md", "likes tea");
    await put(w.member, "notes/deep.md", "deep");
    await put(w.other, "other.md", "not yours");
    const gone = memoryDocDetailSchema.parse((await put(w.member, "gone.md", "x")).json);
    await w.member.browser.delete(`/v1/memory/${gone.id}`);
    const chunks: Uint8Array[] = [];
    for await (const c of exportZip(fx.db, { teamId: w.team, userId: w.member.id }, blobs))
      chunks.push(c);
    const files = unzipSync(Buffer.concat(chunks));
    const memory = Object.keys(files)
      .filter((k) => k.startsWith("memory/"))
      .sort();
    expect(memory).toEqual(["memory/notes/deep.md", "memory/prefs.md"]);
    expect(strFromU8(files["memory/prefs.md"]!)).toBe("likes tea");
  });
});
