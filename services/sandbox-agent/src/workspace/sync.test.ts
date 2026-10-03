import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RunStartFrame } from "@kobe/protocol";
import { FakeSyncServer } from "../testing/fake-sync-server.js";
import { SyncClient } from "./client.js";
import { WorkspaceSync } from "./sync.js";

const quiet = {
  debug: () => {},
  info: () => {},
  warn: (o: unknown, m: string) => {
    if (process.env.SYNC_DEBUG) console.log(m, o);
  },
  error: () => {},
};
const server = new FakeSyncServer();
let serverUrl: string;
const roots: string[] = [];
const syncs: WorkspaceSync[] = [];

beforeAll(async () => {
  serverUrl = await server.start();
});
afterAll(() => server.stop());
afterEach(async () => {
  for (const s of syncs.splice(0)) await s.flush(10);
  for (const r of roots.splice(0)) {
    await chmodTree(r);
    await rm(r, { recursive: true, force: true });
  }
  server.rows.clear();
  server.blobs.clear();
  server.reports.length = 0;
  server.failWith = undefined;
});

/** Read-only areas are 0555/0444: make them removable. */
async function chmodTree(dir: string): Promise<void> {
  await chmod(dir, 0o755).catch(() => {});
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) await chmodTree(path.join(dir, e.name));
  }
}

async function volume(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "kobe-ws-"));
  roots.push(root);
  return root;
}

function agentSync(root: string, intervalMs = 60_000): WorkspaceSync {
  const sync = new WorkspaceSync({
    root,
    client: new SyncClient({ serverUrl, readToken: () => Promise.resolve(server.token) }),
    logger: quiet,
    intervalMs,
    restoreWaitMs: 2_000,
  });
  syncs.push(sync);
  return sync;
}

async function started(root: string): Promise<WorkspaceSync> {
  const sync = agentSync(root);
  sync.start();
  await sync.ready();
  return sync;
}

async function put(root: string, rel: string, content: string, mode = 0o644): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), content, { mode });
}

const text = (root: string, rel: string) => readFile(path.join(root, rel), "utf8");
const exists = (root: string, rel: string) =>
  lstat(path.join(root, rel)).then(
    () => true,
    () => false,
  );

const RUN = "4f9c2d5a-6b7e-4f90-8bc2-4d5e6f708192";
const THREAD = "2d7a0b3e-4f5c-4d7e-8fa0-2b3c4d5e6f70";
const runStart = (attachments: { path: string; mime_type: string }[] = []): RunStartFrame => ({
  v: 1,
  type: "run.start",
  command_id: "c1",
  run_id: RUN,
  thread_id: THREAD,
  message: "go",
  attachments,
});

describe("workspace sync (agent)", () => {
  it("pushes the workspace and restores it onto a new, empty volume", async () => {
    const first = await volume();
    await put(first, "report.md", "# Q3\n");
    await put(first, "bin/run.sh", "#!/bin/sh\necho hi\n", 0o755);
    await put(first, "data/big.csv", "x,y\n".repeat(10_000));
    await put(first, ".kobe/sessions/t.jsonl", "{}\n"); // rebuilt from Postgres, never synced
    await put(first, "app/node_modules/dep/index.js", "cache"); // rebuildable, skipped
    const sync = await started(first);
    const pushed = await sync.push();
    expect(pushed).toMatchObject({ changes: 3, uploaded: 3, conflicts: 0, rejected: 0 });
    expect(server.livePaths()).toEqual(["bin/run.sh", "data/big.csv", "report.md"]);
    const mtime = (await stat(path.join(first, "report.md"))).mtimeMs;

    // The volume is lost: a new pod starts on an empty one.
    const second = await volume();
    const restored = await started(second);
    expect(await text(second, "report.md")).toBe("# Q3\n");
    expect(await text(second, "data/big.csv")).toBe("x,y\n".repeat(10_000));
    expect((await stat(path.join(second, "bin/run.sh"))).mode & 0o777).toBe(0o755);
    expect(
      Math.abs((await stat(path.join(second, "report.md"))).mtimeMs - mtime),
    ).toBeLessThanOrEqual(1);
    expect(await exists(second, ".kobe")).toBe(false);
    expect(server.reports.at(-1)).toMatchObject({ mode: "full", files: 3 });
    // Nothing to push afterwards: restored files match their copy without being read again.
    expect((await restored.push()).changes).toBe(0);
  });

  it("wakes on a kept volume without downloading anything", async () => {
    const root = await volume();
    await put(root, "notes.txt", "keep me");
    await (await started(root)).push();
    const before = server.requests.length;
    await started(root);
    const calls = server.requests.slice(before);
    expect(calls.filter((c) => c.startsWith("GET /file"))).toEqual([]);
    expect(server.reports.at(-1)).toMatchObject({ mode: "incremental", files: 0 });
  });

  it("keeps local edits made after the last push and pushes them on the next sync", async () => {
    const root = await volume();
    await put(root, "draft.md", "v1");
    await (await started(root)).push();
    await put(root, "draft.md", "v2, written after the last push");
    const sync = await started(root); // e.g. the agent restarted before pushing
    expect(await text(root, "draft.md")).toBe("v2, written after the last push");
    await sync.push();
    expect(server.content("draft.md")).toBe("v2, written after the last push");
  });

  it("pulls uploads before a run, read-only, and fails a run whose attachment is missing", async () => {
    const root = await volume();
    const sync = await started(root);
    server.serverWrite(`uploads/${THREAD}/sales.csv`, "region,total\nEU,3\n");
    const attachment = { path: `${root}/uploads/${THREAD}/sales.csv`, mime_type: "text/csv" };
    await sync.beforeRun(runStart([attachment]));
    expect(await text(root, `uploads/${THREAD}/sales.csv`)).toBe("region,total\nEU,3\n");
    expect((await stat(path.join(root, `uploads/${THREAD}/sales.csv`))).mode & 0o777).toBe(0o444);
    expect((await stat(path.join(root, `uploads/${THREAD}`))).mode & 0o777).toBe(0o555);
    await expect(
      sync.beforeRun(
        runStart([{ path: `${root}/uploads/${THREAD}/missing.csv`, mime_type: "text/csv" }]),
      ),
    ).rejects.toThrow(/not in the workspace/);
  });

  it("keeps project files read-only: local edits are reverted and never reach the server", async () => {
    const root = await volume();
    const sync = await started(root);
    server.serverWrite("projects/acme/brief.md", "the brief");
    await sync.pull();
    const file = path.join(root, "projects/acme/brief.md");
    await chmod(path.join(root, "projects/acme"), 0o755); // same uid: a model can undo the mode
    await chmod(file, 0o644);
    await writeFile(file, "vandalised");
    await writeFile(path.join(root, "projects/acme/extra.md"), "not from the server");
    const commitsBefore = server.requests.filter((r) => r === "POST /commit").length;
    await sync.push();
    expect(await text(root, "projects/acme/brief.md")).toBe("the brief");
    expect(await exists(root, "projects/acme/extra.md")).toBe(false);
    expect(server.content("projects/acme/brief.md")).toBe("the brief");
    expect(server.requests.filter((r) => r === "POST /commit").length).toBe(commitsBefore);
  });

  it("keeps both versions when the sandbox and the server changed the same file", async () => {
    const root = await volume();
    await put(root, "plan.md", "v1");
    const sync = await started(root);
    await sync.push();
    server.serverWrite("plan.md", "uploaded from the file browser");
    await put(root, "plan.md", "edited by the agent");
    const stats = await sync.push();
    expect(stats.conflicts).toBe(1);
    expect(await text(root, "plan.md")).toBe("uploaded from the file browser");
    const copies = (await readdir(root)).filter((n) => n.startsWith("plan.conflict-"));
    expect(copies).toHaveLength(1);
    expect(await text(root, must(copies[0]))).toBe("edited by the agent");
    await sync.push();
    expect(server.content(must(copies[0]))).toBe("edited by the agent");
  });

  it("propagates deletions both ways; a deletion never beats a modification", async () => {
    const root = await volume();
    await put(root, "a.txt", "a");
    await put(root, "b.txt", "b");
    await put(root, "c.txt", "c");
    const sync = await started(root);
    await sync.push();
    await rm(path.join(root, "a.txt"));
    await sync.push();
    expect(server.livePaths()).toEqual(["b.txt", "c.txt"]);
    server.serverDelete("b.txt");
    server.serverDelete("c.txt");
    await put(root, "c.txt", "c, changed locally");
    await utimes(path.join(root, "c.txt"), new Date(), new Date(Date.now() + 5_000));
    await sync.pull();
    expect(await exists(root, "b.txt")).toBe(false);
    expect(await text(root, "c.txt")).toBe("c, changed locally");
    await sync.push();
    expect(server.content("c.txt")).toBe("c, changed locally");
  });

  it("flushes pending changes when stopping (hibernation)", async () => {
    const root = await volume();
    const sync = await started(root);
    await put(root, "late.txt", "written just before hibernation");
    const stats = await sync.flush(5_000);
    expect(stats).toMatchObject({ changes: 1 });
    expect(server.content("late.txt")).toBe("written just before hibernation");
  });

  it("never syncs symlinks and never writes through one", async () => {
    const root = await volume();
    const outside = await volume();
    await put(outside, "secret", "outside the workspace");
    await symlink(path.join(outside, "secret"), path.join(root, "link"));
    await symlink(outside, path.join(root, "uploads"));
    const sync = await started(root);
    await sync.push();
    expect(server.livePaths()).toEqual([]);
    server.serverWrite(`uploads/${THREAD}/f.txt`, "upload");
    await sync.pull();
    expect((await lstat(path.join(root, "uploads"))).isDirectory()).toBe(true);
    expect(await exists(outside, THREAD)).toBe(false);
    expect(await text(root, `uploads/${THREAD}/f.txt`)).toBe("upload");
  });

  it("never lets one file block the restore: the rest restores and pushes keep working", async () => {
    const first = await volume();
    await put(first, "a.txt", "a");
    await put(first, "notes", "a file in the copy");
    await (await started(first)).push();
    const second = await volume();
    await mkdir(path.join(second, "notes"), { recursive: true }); // a directory in the way
    await put(second, "notes/inside.md", "local work");
    const sync = await started(second);
    expect(await text(second, "a.txt")).toBe("a");
    expect(await text(second, "notes/inside.md")).toBe("local work");
    await put(second, "after.txt", "still synced");
    await sync.push();
    expect(server.content("after.txt")).toBe("still synced");
    expect(server.content("notes")).toBe("a file in the copy"); // never deleted meanwhile
  });

  it("moves files the server never wrote out of read-only areas instead of deleting them", async () => {
    const root = await volume();
    await put(root, "projects/mine/plan.md", "written before sync existed");
    const sync = await started(root);
    expect(await exists(root, "projects/mine/plan.md")).toBe(false);
    expect(await text(root, "kobe-moved/projects/mine/plan.md")).toBe(
      "written before sync existed",
    );
    await sync.push();
    expect(server.content("kobe-moved/projects/mine/plan.md")).toBe("written before sync existed");
  });

  it("turns itself off when the server has no workspace sync", async () => {
    server.failWith = 404;
    const root = await volume();
    const sync = await started(root);
    expect(sync.enabled).toBe(false);
    await expect(sync.beforeRun(runStart())).resolves.toBeUndefined();
  });

  it("measures a full restore (localhost; see the ledger for real numbers)", async () => {
    const first = await volume();
    const files = 500;
    for (let i = 0; i < files; i++)
      await put(first, `set/${i % 20}/f${i}.txt`, `${i}`.repeat(1000));
    await (await started(first)).push();
    const second = await volume();
    const t0 = performance.now();
    await started(second);
    const ms = performance.now() - t0;
    expect(server.reports.at(-1)).toMatchObject({ mode: "full", files });
    console.log(
      `restore of ${files} files (≈ 2 MB) from a local fake server: ${Math.round(ms)} ms`,
    );
  });
});

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("missing");
  return v;
}
