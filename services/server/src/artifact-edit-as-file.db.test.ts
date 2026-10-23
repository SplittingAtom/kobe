import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaceFileEntrySchema } from "@kobe/protocol";
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

/**
 * Edit as file (KOBE-485): `POST /v1/artifacts/:id/versions/:n/edit-as-file` copies one version of
 * a text artifact into the thread owner's workspace as `artifacts/<slug>.<ext>` through the upload
 * path (quota, size, audit with ids only); a clash takes `-2`, `-3` and never overwrites. Shared
 * readers, other members and other teams are refused; the artifact itself never changes.
 */
const fx = new EventStreamFixture();
const objects = new MemoryObjects();
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const LIMITS = { maxFileBytes: 1024 * 1024, maxWorkspaceBytes: 4 * 1024 * 1024, maxFiles: 50 };
let sync: WorkspaceSync;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await fx.setup([{}], () => ({ blobs: { objects, prefix: "" } }));
  sync = createWorkspaceSync({ db: fx.db, objects, prefix: "ws/", limits: LIMITS, log: silent });
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
  readonly alice: Person;
  readonly bob: Person;
  readonly threadId: string;
  readonly runId: string;
  readonly a: TestBrowser;
  readonly b: TestBrowser;
}

async function world(): Promise<World> {
  const alice = await fx.person("alice");
  const bob = await fx.person("bob");
  const team = await fx.team(`e-${randomBytes(3).toString("hex")}`, alice, [bob]);
  const runId = await fx.run(team, alice);
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
    [team, runId],
  );
  const threadId = must(rows[0], "run").thread_id;
  return {
    team,
    alice,
    bob,
    threadId,
    runId,
    a: browserFor(alice, team),
    b: browserFor(bob, team),
  };
}

/** Stores an artifact with one row per content, the way `artifact.put` leaves it. */
async function artifact(
  w: World,
  kind: string,
  title: string,
  versions: readonly string[],
  language: string | null = null,
): Promise<string> {
  const id = randomUUID();
  await fx.admin.query(
    `INSERT INTO artifacts (team_id, id, thread_id, created_by, kind, title, language, current_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [w.team, id, w.threadId, w.alice.id, kind, title, language, versions.length],
  );
  for (const [i, content] of versions.entries()) {
    const data = Buffer.from(content);
    const key = `teams/${w.team}/threads/${w.threadId}/artifacts/${id}/v${i + 1}`;
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

const editAsFile = (b: TestBrowser, id: string, version: number) =>
  b.post(`/v1/artifacts/${id}/versions/${version}/edit-as-file`, {});

async function auditRows(team: string) {
  const { rows } = await fx.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'workspace.file_uploaded'
     ORDER BY seq`,
    [team],
  );
  return rows.map((r) => r.target);
}

describe("Edit as file (KOBE-485)", () => {
  it("copies the chosen version to artifacts/<slug>.<ext>, readable and editable", async () => {
    const w = await world();
    const id = await artifact(w, "markdown", "Q3 Plan: draft!", ["# v1", "# v2 SECRET"]);
    const res = await editAsFile(w.a, id, 1);
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const entry = workspaceFileEntrySchema.parse(res.json);
    expect(entry.path).toBe("artifacts/q3-plan-draft.md");
    expect((await w.a.get(`/v1/workspace/file?path=${entry.path}`)).text).toBe("# v1");
    // Audit: ids and counts only, never the title, path or content.
    expect(await auditRows(w.team)).toEqual([
      { userId: w.alice.id, bytes: 4, area: "artifact", artifactId: id, version: 1 },
    ]);
    // Editable: a save at the copied version goes through.
    const sha = must(entry.sha256, "sha256");
    const saved = await w.a.request(
      "PUT",
      `/v1/workspace/file?path=${entry.path}&base_sha256=${sha}`,
      new RawBody("# edited", "text/plain"),
    );
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    // The artifact stays immutable.
    expect((await w.a.get(`/v1/artifacts/${id}/versions/1/content`)).text).toBe("# v1");
  });

  it("never overwrites: a clash takes -2, -3", async () => {
    const w = await world();
    const id = await artifact(w, "code", "Load data", ["print(1)", "print(2)"], "python");
    const paths: string[] = [];
    for (const version of [1, 2, 2]) {
      const res = await editAsFile(w.a, id, version);
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      paths.push(workspaceFileEntrySchema.parse(res.json).path);
    }
    expect(paths).toEqual([
      "artifacts/load-data.py",
      "artifacts/load-data-2.py",
      "artifacts/load-data-3.py",
    ]);
    expect((await w.a.get("/v1/workspace/file?path=artifacts/load-data.py")).text).toBe("print(1)");
    expect((await w.a.get("/v1/workspace/file?path=artifacts/load-data-2.py")).text).toBe(
      "print(2)",
    );
  });

  it("gives racing copies distinct names", async () => {
    const w = await world();
    const id = await artifact(w, "csv", "Sales", ["a,b\n1,2"]);
    const results = await Promise.all([1, 2, 3].map(() => editAsFile(w.a, id, 1)));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    const paths = results.map((r) => workspaceFileEntrySchema.parse(r.json).path).sort();
    expect(paths).toEqual([
      "artifacts/sales-2.csv",
      "artifacts/sales-3.csv",
      "artifacts/sales.csv",
    ]);
  });

  it("refuses a shared reader (read-only) and anyone who can't read the thread (not found)", async () => {
    const w = await world();
    const id = await artifact(w, "markdown", "Plan", ["# p"]);
    // Bob is not in the thread's project and it isn't shared: not found.
    expect((await editAsFile(w.b, id, 1)).status).toBe(404);
    const project = randomUUID();
    await fx.admin.query(
      `INSERT INTO projects (team_id, id, slug, name, created_by, members_mode)
       VALUES ($1, $2, 'plan', 'Plan', $3, 'selected')`,
      [w.team, project, w.alice.id],
    );
    await fx.admin.query(
      `INSERT INTO project_members (team_id, project_id, user_id, role, added_by)
       VALUES ($1, $2, $3, 'owner', $3), ($1, $2, $4, 'member', $3)`,
      [w.team, project, w.alice.id, w.bob.id],
    );
    await fx.admin.query(
      `UPDATE threads SET project_id = $3, shared_to_project = true WHERE team_id = $1 AND id = $2`,
      [w.team, w.threadId, project],
    );
    // Bob now reads the artifact, but Edit as file is the owner's.
    expect((await w.b.get(`/v1/artifacts/${id}`)).status).toBe(200);
    const res = await editAsFile(w.b, id, 1);
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "read_only" });
    // Another team never sees it.
    const carol = await fx.person("carol");
    const other = await fx.team(`o-${randomBytes(3).toString("hex")}`, carol);
    expect((await editAsFile(browserFor(carol, other), id, 1)).status).toBe(404);
    expect(await auditRows(w.team)).toEqual([]);
  });

  it("refuses html, svg and mermaid, and unknown versions", async () => {
    const w = await world();
    for (const kind of ["html", "svg", "mermaid"]) {
      const id = await artifact(w, kind, kind, ["x"]);
      const res = await editAsFile(w.a, id, 1);
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ code: "not_editable" });
    }
    const id = await artifact(w, "markdown", "One", ["# 1"]);
    expect((await editAsFile(w.a, id, 2)).status).toBe(404);
    expect((await w.a.post(`/v1/artifacts/not-a-uuid/versions/1/edit-as-file`, {})).status).toBe(
      400,
    );
  });

  it("answers the workspace quota without writing", async () => {
    const w = await world();
    const big = "x".repeat(400 * 1024);
    const tight = createWorkspaceSync({
      db: fx.db,
      objects,
      prefix: "ws/",
      limits: { ...LIMITS, maxWorkspaceBytes: 300 * 1024 },
      log: silent,
    });
    const tightApp = createApp(fx.replica(0).deps, {
      workspaceFiles: { sync: tight, waker: { wake: () => Promise.resolve() } },
    });
    const b = new TestBrowser(tightApp, PUBLIC_URL);
    for (const [k, v] of w.alice.browser.cookies) b.cookies.set(k, v);
    b.team = w.team;
    const id = await artifact(w, "markdown", "Big", [big]);
    const res = await editAsFile(b, id, 1);
    expect(res.status).toBe(507);
    expect(res.json).toMatchObject({ code: "quota_exceeded" });
    expect((await w.a.get("/v1/workspace/file?path=artifacts/big.md")).status).toBe(404);
  });
});
