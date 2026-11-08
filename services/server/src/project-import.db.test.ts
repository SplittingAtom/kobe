import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { ARTIFACT_CONTENT_MAX_BYTES, projectFileSchema } from "@kobe/protocol";
import { createApp } from "./app.js";
import {
  EventStreamFixture,
  PUBLIC_URL,
  must,
  type Person,
} from "./testing/event-stream-fixture.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { RawBody, TestBrowser } from "./testing/browser.js";
import { createWorkspaceSync, type WorkspaceSync } from "./workspace-sync/index.js";
import { listLive } from "./workspace-sync/store.js";

/**
 * Add to project (KOBE-585, ac-1/ac-2): `POST /v1/projects/:id/files/import` copies an artifact
 * version or the caller's own synced workspace file into a project from the bytes the server
 * stored. Rights (`canAddToProject`, Chris 2026-11-08 "editors are builders"): team admins, project
 * owners, builder project members, and the content's owner when a project member. A clash is 409
 * `already_exists`; the audit row carries ids only; every project member gets the file read-only under
 * `projects/<slug>/`.
 */
const fx = new EventStreamFixture();
const objects = new MemoryObjects();
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const PREFIX = "kobe/";
const LIMITS = { maxFileBytes: 1024 * 1024, maxWorkspaceBytes: 4 * 1024 * 1024, maxFiles: 50 };
let sync: WorkspaceSync;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  // One prefix for thread blobs and workspaces, as deployed: mounts point at the project's object.
  await fx.setup([{}], () => ({ blobs: { objects, prefix: PREFIX } }));
  sync = createWorkspaceSync({ db: fx.db, objects, prefix: PREFIX, limits: LIMITS, log: silent });
  fx.replica(0).deps.projectMounts.use(sync);
  app = createApp(fx.replica(0).deps, {
    workspaceFiles: { sync, waker: { wake: () => Promise.resolve() } },
  });
});

afterAll(() => fx.teardown());

function browserFor(p: Person, team: string): TestBrowser {
  const b = new TestBrowser(app, PUBLIC_URL);
  for (const [k, v] of p.browser.cookies) b.cookies.set(k, v);
  b.team = team;
  return b;
}

interface World {
  readonly team: string;
  readonly threadId: string;
  readonly runId: string;
  readonly people: Record<"admin" | "alice" | "bob" | "carol" | "dave" | "eve", Person>;
  readonly as: Record<"admin" | "alice" | "bob" | "carol" | "dave" | "eve", TestBrowser>;
  readonly project: { readonly id: string; readonly slug: string };
}

/**
 * admin: team admin, not a project member. alice: member, project member, owns the thread.
 * bob: member, project member. carol: builder, project owner (created it). dave: builder,
 * project member. eve: member, not in the (selected) project.
 */
async function world(): Promise<World> {
  const admin = await fx.person("admin");
  const alice = await fx.person("alice");
  const bob = await fx.person("bob");
  const carol = await fx.person("carol");
  const dave = await fx.person("dave");
  const eve = await fx.person("eve");
  const team = await fx.team(`i-${randomBytes(3).toString("hex")}`, admin, [
    alice,
    bob,
    carol,
    dave,
    eve,
  ]);
  await fx.admin.query(
    `UPDATE team_members SET role = 'builder' WHERE team_id = $1 AND user_id = ANY($2)`,
    [team, [carol.id, dave.id]],
  );
  const runId = await fx.run(team, alice);
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [team, runId],
  );
  const threadId = must(rows[0], "run").thread_id;
  const people = { admin, alice, bob, carol, dave, eve };
  const as = Object.fromEntries(
    Object.entries(people).map(([k, p]) => [k, browserFor(p, team)]),
  ) as World["as"];
  const created = await as.carol.post("/v1/projects", {
    name: `Launch ${randomBytes(2).toString("hex")}`,
    visibility: "restricted",
    member_user_ids: [alice.id, bob.id, dave.id],
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const project = created.json as { id: string; slug: string };
  return { team, threadId, runId, people, as, project };
}

/** Stores an artifact the way `artifact.put` leaves it (as artifact-edit-as-file.db.test.ts). */
async function artifact(w: World, title: string, versions: readonly string[]): Promise<string> {
  const id = randomUUID();
  await fx.admin.query(
    `INSERT INTO artifacts (team_id, id, thread_id, created_by, kind, title, language, current_version)
     VALUES ($1, $2, $3, $4, 'markdown', $5, NULL, $6)`,
    [w.team, id, w.threadId, w.people.alice.id, title, versions.length],
  );
  for (const [i, content] of versions.entries()) {
    const data = Buffer.from(content);
    const key = `${PREFIX}teams/${w.team}/threads/${w.threadId}/artifacts/${id}/v${i + 1}`;
    objects.objects.set(key, data);
    await fx.admin.query(
      `INSERT INTO artifact_versions
         (team_id, artifact_id, version, thread_id, blob_ref, size_bytes, sha256, run_id, tool_call_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        w.team,
        id,
        i + 1,
        w.threadId,
        key,
        data.length,
        createHash("sha256").update(data).digest("hex"),
        w.runId,
        `call-${randomUUID()}`,
      ],
    );
  }
  return id;
}

const shareToTeam = (w: World) =>
  fx.admin.query(`UPDATE threads SET shared_to_team = true WHERE team_id = $1 AND id = $2`, [
    w.team,
    w.threadId,
  ]);

const importInto = (b: TestBrowser, project: string, body: Record<string, unknown>) =>
  b.post(`/v1/projects/${project}/files/import`, body);

const fromArtifact = (
  artifactId: string,
  version: number,
  extra: Record<string, unknown> = {},
) => ({
  source: { kind: "artifact", artifact_id: artifactId, version },
  ...extra,
});

async function uploadToWorkspace(b: TestBrowser, name: string, data: string) {
  const boundary = `----kobe${randomBytes(6).toString("hex")}`;
  const bytes = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\nnotes\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
      `Content-Type: text/plain\r\n\r\n${data}\r\n--${boundary}--\r\n`,
  );
  const res = await b.request(
    "POST",
    "/v1/workspace/files",
    new RawBody(bytes, `multipart/form-data; boundary=${boundary}`),
    { "content-length": String(bytes.length) },
  );
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return `notes/${name}`;
}

async function auditRows(team: string) {
  const { rows } = await fx.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'project.file_added' ORDER BY seq`,
    [team],
  );
  return rows.map((r) => r.target);
}

async function mounted(team: string, userId: string): Promise<Record<string, string | undefined>> {
  const entries = await withTeam(fx.db, team, (tx) =>
    listLive(tx, { teamId: team, userId }, "projects/", 1000),
  );
  for (const e of entries) expect(e.origin).toBe("server");
  return Object.fromEntries(entries.map((e) => [e.path, e.sha256]));
}

describe("Add to project: artifacts (KOBE-585)", () => {
  it("copies the thread owner's artifact version into the project, ids only in the audit", async () => {
    const w = await world();
    const id = await artifact(w, "Q3 Plan: SECRET", ["# v1", "# v2"]);
    const res = await importInto(w.as.alice, w.project.id, fromArtifact(id, 1, { folder: "docs" }));
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const file = projectFileSchema.parse(res.json);
    expect(file).toMatchObject({
      project_id: w.project.id,
      path: "docs/q3-plan-secret.md",
      size_bytes: 4,
      source: "upload",
      added_by: w.people.alice.id,
      mime_type: "text/markdown",
    });
    const audits = await auditRows(w.team);
    expect(audits).toEqual([
      {
        projectId: w.project.id,
        fileId: file.id,
        source: "upload",
        sizeBytes: 4,
        importedFrom: { kind: "artifact", artifactId: id, version: 1 },
      },
    ]);
    expect(JSON.stringify(audits)).not.toMatch(/plan|secret/i);
    // The artifact is unchanged; the project's copy holds the chosen version's bytes.
    const { rows } = await fx.admin.query<{ blob_ref: string }>(
      `SELECT blob_ref FROM project_files WHERE team_id = $1 AND id = $2`,
      [w.team, file.id],
    );
    expect(objects.objects.get(must(rows[0], "row").blob_ref)?.toString()).toBe("# v1");
  });

  it("answers 409 already_exists on a clash and takes another name", async () => {
    const w = await world();
    const id = await artifact(w, "Plan", ["# p"]);
    expect((await importInto(w.as.alice, w.project.id, fromArtifact(id, 1))).status).toBe(201);
    const again = await importInto(w.as.alice, w.project.id, fromArtifact(id, 1));
    expect(again.status).toBe(409);
    expect(again.json).toMatchObject({ code: "already_exists" });
    const copy = await importInto(
      w.as.alice,
      w.project.id,
      fromArtifact(id, 1, { name: "plan-2.md" }),
    );
    expect(copy.status, JSON.stringify(copy.json)).toBe(201);
    expect(copy.json).toMatchObject({ path: "plan-2.md" });
  });

  it("allows admins, project owners and builder members; refuses other readers", async () => {
    const w = await world();
    const id = await artifact(w, "Shared", ["# s"]);
    // Bob and Dave cannot read Alice's private thread: not found, whatever their role.
    expect((await importInto(w.as.bob, w.project.id, fromArtifact(id, 1))).status).toBe(404);
    expect((await importInto(w.as.dave, w.project.id, fromArtifact(id, 1))).status).toBe(404);
    await shareToTeam(w);
    // Bob is a listed member, which reads as editor now (KOBE-576): he may add.
    const bob = await importInto(w.as.bob, w.project.id, fromArtifact(id, 1, { name: "b.md" }));
    expect(bob.status, JSON.stringify(bob.json)).toBe(201);
    // Dave is a builder project member: also an editor.
    const dave = await importInto(w.as.dave, w.project.id, fromArtifact(id, 1, { name: "d.md" }));
    expect(dave.status, JSON.stringify(dave.json)).toBe(201);
    // Carol owns the project; the team admin manages every project without being a member.
    const carol = await importInto(w.as.carol, w.project.id, fromArtifact(id, 1, { name: "c.md" }));
    expect(carol.status, JSON.stringify(carol.json)).toBe(201);
    const admin = await importInto(w.as.admin, w.project.id, fromArtifact(id, 1, { name: "a.md" }));
    expect(admin.status, JSON.stringify(admin.json)).toBe(201);
    // Eve owns nothing here and is not in the selected project: it does not exist for her.
    expect((await importInto(w.as.eve, w.project.id, fromArtifact(id, 1))).status).toBe(404);
  });

  it("refuses the content's owner who is not a project member", async () => {
    const w = await world();
    const id = await artifact(w, "Mine", ["# m"]);
    // A team-wide project Alice is not an explicit member of, then made selected without her.
    const other = await w.as.carol.post("/v1/projects", {
      name: `Other ${randomBytes(2).toString("hex")}`,
      visibility: "restricted",
      member_user_ids: [w.people.bob.id],
    });
    expect(other.status).toBe(201);
    const otherId = (other.json as { id: string }).id;
    // A non-member never learns the project exists (404, as every project route).
    expect((await importInto(w.as.alice, otherId, fromArtifact(id, 1))).status).toBe(404);
    expect(await auditRows(w.team)).toEqual([]);
  });

  it("answers 404 for unknown versions, other teams and bad ids; 422 for bad names", async () => {
    const w = await world();
    const id = await artifact(w, "One", ["# 1"]);
    expect((await importInto(w.as.alice, w.project.id, fromArtifact(id, 2))).status).toBe(404);
    expect((await importInto(w.as.alice, randomUUID(), fromArtifact(id, 1))).status).toBe(404);
    expect(
      (await w.as.alice.post(`/v1/projects/nope/files/import`, fromArtifact(id, 1))).status,
    ).toBe(404);
    for (const extra of [{ name: "../x.md" }, { name: "a/b.md" }, { folder: "../up" }]) {
      const res = await importInto(w.as.alice, w.project.id, fromArtifact(id, 1, extra));
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    const carol = await fx.person("carol2");
    const otherTeam = await fx.team(`o-${randomBytes(3).toString("hex")}`, carol);
    const created = await browserFor(carol, otherTeam).post("/v1/projects", { name: "Theirs" });
    const theirs = (created.json as { id: string }).id;
    expect(
      (await importInto(browserFor(carol, otherTeam), theirs, fromArtifact(id, 1))).status,
    ).toBe(404);
    expect(await auditRows(w.team)).toEqual([]);
  });

  it("answers 404 for a purged version and 413 for one over the artifact cap", async () => {
    const w = await world();
    const gone = await artifact(w, "Gone", ["# g"]);
    objects.objects.delete(`${PREFIX}teams/${w.team}/threads/${w.threadId}/artifacts/${gone}/v1`);
    const missing = await importInto(w.as.alice, w.project.id, fromArtifact(gone, 1));
    expect(missing.status).toBe(404);
    const big = await artifact(w, "Big", ["x".repeat(ARTIFACT_CONTENT_MAX_BYTES + 1)]);
    const large = await importInto(w.as.alice, w.project.id, fromArtifact(big, 1));
    expect(large.status).toBe(413);
    expect(large.json).toMatchObject({ code: "file_too_large" });
    expect(await auditRows(w.team)).toEqual([]);
  });

  it("refuses an archived project before reading the source", async () => {
    const w = await world();
    const id = await artifact(w, "Late", ["# l"]);
    expect(
      (await w.as.carol.patch(`/v1/projects/${w.project.id}`, { archived: true })).status,
    ).toBe(200);
    const res = await importInto(w.as.alice, w.project.id, fromArtifact(id, 1));
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "archived" });
    // Not even an unknown source is looked at.
    const unknown = await importInto(w.as.alice, w.project.id, fromArtifact(randomUUID(), 1));
    expect(unknown.json).toMatchObject({ code: "archived" });
  });
});

describe("Add to project: workspace files (KOBE-585)", () => {
  it("copies the caller's own synced file; others' paths are their own workspace", async () => {
    const w = await world();
    const path = await uploadToWorkspace(w.as.alice, "findings.txt", "hello project");
    const res = await importInto(w.as.alice, w.project.id, {
      source: { kind: "workspace_file", path },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const file = projectFileSchema.parse(res.json);
    expect(file).toMatchObject({ path: "findings.txt", size_bytes: 13, mime_type: "text/plain" });
    const audits = await auditRows(w.team);
    expect(audits).toEqual([
      {
        projectId: w.project.id,
        fileId: file.id,
        source: "upload",
        sizeBytes: 13,
        importedFrom: { kind: "workspace_file" },
      },
    ]);
    // No reference to the path at all: not the name, not a hash of it.
    expect(JSON.stringify(audits)).not.toContain("findings");
    expect(JSON.stringify(audits)).not.toContain(createHash("sha256").update(path).digest("hex"));
    // Bob has no such file in his own workspace: not found (never Alice's copy).
    const bob = await importInto(w.as.bob, w.project.id, {
      source: { kind: "workspace_file", path },
    });
    expect(bob.status).toBe(404);
    // Agent-internal paths are never a source.
    expect(
      (
        await importInto(w.as.alice, w.project.id, {
          source: { kind: "workspace_file", path: ".kobe/x" },
        })
      ).status,
    ).toBe(404);
  });

  it("mounts the file read-only for every project member and nobody else", async () => {
    const w = await world();
    const path = await uploadToWorkspace(w.as.alice, "shared.txt", "for all");
    const res = await importInto(w.as.alice, w.project.id, {
      source: { kind: "workspace_file", path },
      folder: "in",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const sha = projectFileSchema.parse(res.json).sha256;
    const expected = { [`projects/${w.project.slug}/in/shared.txt`]: sha };
    for (const p of ["alice", "bob", "carol", "dave"] as const) {
      expect(await mounted(w.team, w.people[p].id)).toEqual(expected);
    }
    expect(await mounted(w.team, w.people.eve.id)).toEqual({});
    // Read-only in the browser for members: the project area refuses writes.
    const put = await w.as.bob.request(
      "PUT",
      `/v1/workspace/file?path=projects/${w.project.slug}/in/shared.txt&base_sha256=${sha}`,
      new RawBody("changed", "text/plain"),
    );
    expect(put.status).toBe(403);
    expect(
      (await w.as.bob.get(`/v1/workspace/file?path=projects/${w.project.slug}/in/shared.txt`)).text,
    ).toBe("for all");
  });
});
