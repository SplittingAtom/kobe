import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect } from "vitest";
import { withTeam } from "@kobe/db";
import { WORKSPACE_SYNC_PATH } from "@kobe/protocol";
import { unzipSync } from "fflate";
import { createApp } from "../app.js";
import { exportZip } from "../retention/export.js";
import { createSandboxApp } from "../routes/sandbox.js";
import { RawBody, TestBrowser } from "./browser.js";
import { EventStreamFixture, PUBLIC_URL, type Person } from "./event-stream-fixture.js";
import { FakeSandboxAuth } from "./fake-sandbox.js";
import { MemoryObjects } from "./memory-objects.js";
import { KEYS } from "./sandbox-fixtures.js";
import {
  createSandboxAuthenticator,
  createWorkspaceSync,
  type WorkspaceSync,
} from "../workspace-sync/index.js";
import { listLive } from "../workspace-sync/store.js";

/**
 * Shared world of the KOBE-579 db suites (project-commits, project-commit-sync,
 * project-history): one throwaway database per importing file (vitest isolates modules per
 * file), a workspace store, the REST app with the Files routes, and the sandbox listener's sync
 * routes. A team admin, alice (contributor, the project's owner), bob (editor), carol (reader).
 */
export const fx = new EventStreamFixture();
export const auth = new FakeSandboxAuth();
export const objects = new MemoryObjects();
export const silent = { error: () => {}, warn: () => {}, info: () => {} };
export const PREFIX = "kobe/";
export const LIMITS = {
  maxFileBytes: 1024 * 1024,
  maxWorkspaceBytes: 8 * 1024 * 1024,
  maxFiles: 200,
};
let sync: WorkspaceSync;
let app: ReturnType<typeof createApp>;
let sandbox: ReturnType<typeof createSandboxApp>;

beforeAll(async () => {
  await fx.setup([{}], () => ({ blobs: { objects, prefix: PREFIX } }));
  sync = createWorkspaceSync({ db: fx.db, objects, prefix: PREFIX, limits: LIMITS, log: silent });
  fx.replica(0).deps.projectMounts.use(sync);
  app = createApp(fx.replica(0).deps, {
    workspaceFiles: { sync, waker: { wake: () => Promise.resolve() } },
  });
  sandbox = createSandboxApp({
    provider: { identifyBootstrapToken: () => Promise.reject(new Error("unused")) },
    sessionKeys: KEYS,
    workspace: sync.routes(
      createSandboxAuthenticator({ db: fx.db, verify: auth.verify, liveness: auth.liveness }),
    ),
  });
});

afterAll(() => fx.teardown());

export const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const settle = () => new Promise((r) => setTimeout(r, 150));

export function browserFor(p: Person, team: string): TestBrowser {
  const b = new TestBrowser(app, PUBLIC_URL);
  for (const [k, v] of p.browser.cookies) b.cookies.set(k, v);
  b.team = team;
  return b;
}

export interface World {
  readonly team: string;
  readonly admin: Person;
  readonly people: Record<"alice" | "bob" | "carol", Person>;
  readonly as: Record<"admin" | "alice" | "bob" | "carol", TestBrowser>;
  readonly project: { readonly id: string; readonly slug: string };
}

/** admin: team admin. alice: contributor, the project's owner. bob: editor. carol: reader. */
export async function world(): Promise<World> {
  const admin = await fx.person("admin");
  const alice = await fx.person("alice");
  const bob = await fx.person("bob");
  const carol = await fx.person("carol");
  const team = await fx.team(`c-${randomBytes(3).toString("hex")}`, admin, [alice, bob, carol]);
  await fx.admin.query(
    `UPDATE team_members SET role = 'contributor' WHERE team_id = $1 AND user_id = $2`,
    [team, alice.id],
  );
  const as = {
    admin: browserFor(admin, team),
    alice: browserFor(alice, team),
    bob: browserFor(bob, team),
    carol: browserFor(carol, team),
  };
  const made = await as.alice.post("/v1/projects", { name: `P ${randomBytes(2).toString("hex")}` });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const project = made.json as { id: string; slug: string };
  const added = await as.alice.post(`/v1/projects/${project.id}/members`, {
    user_id: bob.id,
    role: "editor",
  });
  expect(added.status).toBe(201);
  return { team, admin, people: { alice, bob, carol }, as, project };
}

export function multipart(name: string, content: string, folder?: string) {
  const boundary = `----kobe${randomBytes(6).toString("hex")}`;
  const field =
    folder === undefined
      ? ""
      : `--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${folder}\r\n`;
  const bytes = Buffer.from(
    `${field}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
      `Content-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`,
  );
  return { body: new RawBody(bytes, `multipart/form-data; boundary=${boundary}`), bytes };
}

/** A project upload: one commit per file (KOBE-579 keeps `project_files` the head tree). */
export async function projectUpload(
  b: TestBrowser,
  projectId: string,
  name: string,
  content: string,
) {
  const { body, bytes } = multipart(name, content);
  const res = await b.request("POST", `/v1/projects/${projectId}/files`, body, {
    "content-length": String(bytes.length),
  });
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json as { id: string };
}

/** A Files-panel upload into the caller's workspace. */
export async function workspaceUpload(
  b: TestBrowser,
  folder: string,
  name: string,
  content: string,
) {
  const { body, bytes } = multipart(name, content, folder);
  return b.request("POST", "/v1/workspace/files", body, { "content-length": String(bytes.length) });
}

/** The FE4 save of the editor. */
export function save(b: TestBrowser, path: string, base: string, content: string) {
  const q = new URLSearchParams({ path, base_sha256: base });
  return b.request(
    "PUT",
    `/v1/workspace/file?${q.toString()}`,
    new RawBody(Buffer.from(content), "text/plain"),
    {
      "content-length": String(Buffer.byteLength(content)),
    },
  );
}

export async function rows(team: string, userId: string, slug: string) {
  const entries = await withTeam(fx.db, team, (tx) =>
    listLive(tx, { teamId: team, userId }, `projects/${slug}/`, 1000),
  );
  return new Map(entries.map((e) => [e.path.slice(`projects/${slug}/`.length), e]));
}

export const detail = async (b: TestBrowser, projectId: string, seq: number) => {
  const res = await b.get(`/v1/projects/${projectId}/commits/${seq}`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return res.json as {
    commit: { seq: number; author_kind: string };
    tree: { path: string; sha256: string; blob_ref: string }[];
    diff: { change: string; path: string }[];
  };
};

export const treeOf = (d: { tree: { path: string; sha256: string }[] }) =>
  Object.fromEntries(d.tree.map((e) => [e.path, e.sha256]));

export const audits = async (team: string, action: string) =>
  (
    await fx.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = $2 ORDER BY seq`,
      [team, action],
    )
  ).rows.map((r) => r.target);

// ------------------------------------------------------------------ sync (ac-2)

export function call(token: string, method: string, path: string, body?: unknown, raw?: Buffer) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let payload: string | Uint8Array<ArrayBuffer> | undefined;
  if (raw !== undefined) {
    payload = new Uint8Array(raw);
    headers["content-length"] = String(raw.length);
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  return sandbox.request(`${WORKSPACE_SYNC_PATH}${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
  });
}

export async function push(token: string, path: string, content: string) {
  const data = Buffer.from(content);
  const put = await call(token, "PUT", `/blobs/${sha(data)}`, undefined, data);
  expect([200, 201]).toContain(put.status);
  const res = await call(token, "POST", "/commit", {
    changes: [
      {
        op: "put",
        path,
        base_rev: null,
        sha256: sha(data),
        size: data.length,
        mtime_ms: Date.now(),
        executable: false,
      },
    ],
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { results: { status: string; code?: string }[] }).results[0];
}

export async function pull(token: string) {
  const res = await call(token, "GET", "/manifest?since=0&limit=1");
  expect(res.status).toBe(200);
  return (await res.json()) as { checkouts: unknown[]; more: boolean; head_rev: number };
}

export async function exportedNames(
  team: string,
  userId: string,
): Promise<Record<string, Uint8Array>> {
  const chunks: Uint8Array[] = [];
  for await (const c of exportZip(fx.db, { teamId: team, userId }, { objects, prefix: PREFIX })) {
    chunks.push(c);
  }
  return unzipSync(Buffer.concat(chunks));
}

export async function setHold(team: string, placedBy: string, on: boolean) {
  await fx.admin.query("SET session_replication_role = replica");
  try {
    if (on) {
      await fx.admin.query(
        `INSERT INTO legal_holds (team_id, user_id, reason, status, placed_by, approved_by, approved_at, self_approved)
         VALUES ($1, NULL, 'matter', 'active', $2, $2, now(), true)`,
        [team, placedBy],
      );
    } else {
      await fx.admin.query(
        `UPDATE legal_holds SET status = 'released', release_requested_by = placed_by, release_requested_at = now(),
                release_reason = 'done', released_by = placed_by, released_at = now(), release_self_approved = true
          WHERE team_id = $1 AND status = 'active'`,
        [team],
      );
    }
  } finally {
    await fx.admin.query("SET session_replication_role = origin");
  }
}

export const seqs = async (projectId: string) =>
  (
    await fx.admin.query<{ seq: number }>(
      `SELECT seq FROM project_commits WHERE project_id = $1 ORDER BY seq`,
      [projectId],
    )
  ).rows.map((r) => r.seq);

/** The Files panel's move. */
export function move(b: TestBrowser, from: string, to: string) {
  return b.post("/v1/workspace/files/move", { from, to });
}

/** The Files panel's delete. */
export function remove(b: TestBrowser, path: string) {
  return b.request("DELETE", `/v1/workspace/files?${new URLSearchParams({ path }).toString()}`);
}

/** A sandbox token for (team, user). */
export function tokenFor(team: string, userId: string): string {
  return auth.issue({ sandboxId: randomUUID(), teamId: team, userId });
}
