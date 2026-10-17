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
  server.failDownloads = 0;
  server.horizon = 0;
  server.moves.length = 0;
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
    expect((await stat(path.join(second, "bin/run.sh"))).mode & 0o777).toBe(0o775);
    expect(
      Math.abs((await stat(path.join(second, "report.md"))).mtimeMs - mtime),
    ).toBeLessThanOrEqual(1);
    // Session files are never restored (only the agent's own sync state lives there, KOBE-304).
    expect(await exists(second, ".kobe/sessions")).toBe(false);
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

  it("lets a restore in flight finish before the flush returns: nothing is written after it", async () => {
    const root = await volume();
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let asked = () => {};
    const manifestAsked = new Promise<void>((r) => (asked = r));
    class GatedClient extends SyncClient {
      override async manifest(since: number, limit?: number) {
        asked();
        await gate;
        return super.manifest(since, limit);
      }
    }
    const sync = new WorkspaceSync({
      root,
      client: new GatedClient({ serverUrl, readToken: () => Promise.resolve(server.token) }),
      logger: quiet,
      intervalMs: 60_000,
    });
    syncs.push(sync);
    sync.start();
    await manifestAsked; // the restore is waiting on the server
    let flushed = false;
    const flush = sync.flush(5_000).then(() => (flushed = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(flushed).toBe(false);
    release();
    await flush;
    // The restore's last write (the saved revision, KOBE-304) happened before the flush returned.
    const after = await readdir(root, { recursive: true });
    await new Promise((r) => setTimeout(r, 200));
    expect(await readdir(root, { recursive: true })).toEqual(after);
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

  it("applies deletions it missed when the server compacted them away (resync)", async () => {
    const root = await volume();
    await put(root, "gone.txt", "deleted on the server");
    await put(root, "edited.txt", "v1");
    await put(root, "kept.txt", "kept");
    const sync = await started(root);
    await sync.push();
    server.serverWrite("projects/p/old.md", "stale project file");
    await sync.pull();
    // Meanwhile on the server: three deletions, then their tombstones are compacted away.
    server.serverDelete("gone.txt");
    server.serverDelete("edited.txt");
    server.serverDelete("projects/p/old.md");
    await put(root, "edited.txt", "v2, edited locally");
    server.compact();
    server.serverWrite("new.txt", "after the compaction");
    await sync.pull();
    expect(await exists(root, "gone.txt")).toBe(false);
    expect(await exists(root, "projects/p/old.md")).toBe(false);
    expect(await text(root, "edited.txt")).toBe("v2, edited locally"); // a modification wins
    expect(await text(root, "new.txt")).toBe("after the compaction");
    await sync.push();
    expect(server.livePaths()).toEqual(["edited.txt", "kept.txt", "new.txt"]);
  });

  it("without a journalled move (an older server) the pull alone converges: download, drop, edits stay (KOBE-304)", async () => {
    const root = await volume();
    await put(root, "reports/2026/q1.csv", "q1");
    await put(root, "reports/2026/q2.csv", "q2");
    await put(root, "reports/notes.md", "n");
    await put(root, "keep/empty-on-purpose/.gitkeep", "");
    const sync = await started(root);
    await sync.push();
    // The server's move (manifest-first): new rows, then tombstones of the old ones.
    for (const p of ["reports/2026/q1.csv", "reports/2026/q2.csv", "reports/notes.md"]) {
      server.serverWrite(`archive/${p}`, server.content(p) ?? "");
    }
    for (const p of ["reports/2026/q1.csv", "reports/2026/q2.csv", "reports/notes.md"]) {
      server.serverDelete(p);
    }
    await put(root, "reports/notes.md", "edited before the pull");
    await sync.pull();
    expect(await text(root, "archive/reports/2026/q2.csv")).toBe("q2");
    expect(await exists(root, "reports/2026")).toBe(false); // emptied by the move: gone
    expect(await text(root, "reports/notes.md")).toBe("edited before the pull"); // an edit wins
    expect(await exists(root, "keep/empty-on-purpose/.gitkeep")).toBe(true);
    await sync.push();
    expect(server.livePaths()).toEqual([
      "archive/reports/2026/q1.csv",
      "archive/reports/2026/q2.csv",
      "archive/reports/notes.md",
      "keep/empty-on-purpose/.gitkeep",
      "reports/notes.md",
    ]);
  });

  const downloads = () => server.requests.filter((r) => r.startsWith("GET /file")).length;

  it("replays a server move as a local rename of the whole tree: nothing downloaded, nothing left behind (KOBE-304)", async () => {
    const root = await volume();
    await put(root, "app/src/main.py", "print(1)");
    await put(root, "app/README.md", "# App");
    const sync = await started(root);
    await sync.push();
    // Never synced: caches, a virtualenv, a new file, and an unsynced edit of a synced one.
    await put(root, "app/node_modules/dep/index.js", "dep");
    await put(root, "app/.venv/bin/python", "py");
    await put(root, "app/src/new.py", "new, not pushed yet");
    await put(root, "app/README.md", "# App, edited before the move");
    server.serverMove("app", "old/app");
    const before = downloads();
    await sync.pull();
    expect(downloads()).toBe(before); // a rename, not a download
    expect(await exists(root, "app")).toBe(false);
    expect(await text(root, "old/app/src/main.py")).toBe("print(1)");
    expect(await text(root, "old/app/node_modules/dep/index.js")).toBe("dep");
    expect(await text(root, "old/app/.venv/bin/python")).toBe("py");
    expect(await text(root, "old/app/src/new.py")).toBe("new, not pushed yet");
    expect(await text(root, "old/app/README.md")).toBe("# App, edited before the move");
    // The edit and the new file are pushed under the new path, onto the moved rows.
    await sync.push();
    expect(server.livePaths()).toEqual([
      "old/app/README.md",
      "old/app/src/main.py",
      "old/app/src/new.py",
    ]);
    expect(server.content("old/app/README.md")).toBe("# App, edited before the move");
    // A replay of the same move (the next pull, a restart) is a no-op.
    await sync.pull();
    expect(await text(root, "old/app/src/main.py")).toBe("print(1)");
    expect(downloads()).toBe(before);
  });

  it("renames a single file, and leaves no emptied folder behind", async () => {
    const root = await volume();
    await put(root, "a/b/report.md", "r");
    const sync = await started(root);
    await sync.push();
    server.serverMove("a/b/report.md", "report-final.md");
    await sync.pull();
    expect(await text(root, "report-final.md")).toBe("r");
    expect(await exists(root, "a")).toBe(false);
  });

  it("refuses to rename onto a local file at the destination: the pull converges and keeps both", async () => {
    const root = await volume();
    await put(root, "a.txt", "server copy");
    const sync = await started(root);
    await sync.push();
    await put(root, "b.txt", "local, never pushed");
    server.serverMove("a.txt", "b.txt");
    await sync.pull();
    expect(await text(root, "b.txt")).toBe("server copy");
    const names = await readdir(root);
    const copy = names.find((n) => n.startsWith("b.conflict-"));
    expect(copy).toBeDefined();
    expect(await text(root, copy ?? "")).toBe("local, never pushed");
    expect(await exists(root, "a.txt")).toBe(false);
  });

  it("a hibernated sandbox replays the moves made while it slept before its restore (KOBE-304)", async () => {
    const root = await volume();
    await put(root, "data/big.csv", "x,y\n".repeat(1000));
    const first = await started(root);
    await first.push();
    await put(root, "data/node_modules/cache.bin", "cache");
    await first.flush(5_000);
    server.serverMove("data", "archive/data");
    const before = downloads();
    const woken = await started(root);
    expect(downloads()).toBe(before);
    expect(await exists(root, "data")).toBe(false);
    expect(await text(root, "archive/data/node_modules/cache.bin")).toBe("cache");
    expect(await woken.push()).toMatchObject({ changes: 0 });
  });

  it("a restore retried after a transient error keeps the unsynced edit a replayed rename moved (review R1)", async () => {
    const root = await volume();
    await put(root, "reports/q3.md", "O");
    const first = await started(root);
    await first.push();
    await first.pull(); // remembers the revision for the replay on wake
    await put(root, "reports/q3.md", "N, edited, never pushed");
    // Asleep: the member moves the folder; something else needs a download on wake.
    server.serverMove("reports", "archive/reports");
    server.serverWrite("other.txt", "new while asleep");
    server.failDownloads = 1; // the first restore attempt fails after its rename
    const woken = await started(root);
    expect(await text(root, "archive/reports/q3.md")).toBe("N, edited, never pushed");
    expect(await text(root, "other.txt")).toBe("new while asleep");
    await woken.push();
    expect(server.content("archive/reports/q3.md")).toBe("N, edited, never pushed");
  });

  it("an upload made while asleep, then moved, wins over the stale renamed file, which is kept beside it (review R1)", async () => {
    const root = await volume();
    await put(root, "reports/q3.md", "O, stale");
    const first = await started(root);
    await first.push();
    await first.pull();
    await new Promise((r) => setTimeout(r, 5));
    server.serverWrite("reports/q3.md", "X, the member's upload");
    server.serverMove("reports", "archive/reports");
    const woken = await started(root);
    expect(await text(root, "archive/reports/q3.md")).toBe("X, the member's upload");
    const copies = (await readdir(path.join(root, "archive/reports"))).filter((n) =>
      n.startsWith("q3.conflict-"),
    );
    expect(copies).toHaveLength(1);
    expect(await text(root, `archive/reports/${copies[0] ?? ""}`)).toBe("O, stale");
    await woken.push();
    expect(server.content("archive/reports/q3.md")).toBe("X, the member's upload");
  });

  it("a commit to the old path that lands after the move is not hidden by the rename (review R2)", async () => {
    const root = await volume();
    await put(root, "reports/q3.md", "O");
    const sync = await started(root);
    await sync.push();
    await sync.pull();
    await put(root, "reports/q3.md", "N, pushed after the move");
    server.serverMove("reports", "archive/reports");
    // The push was planned before the move and its commit lands after it: a put onto the
    // tombstone, accepted at a revision newer than the moved rows.
    await sync.push();
    expect(server.content("reports/q3.md")).toBe("N, pushed after the move");
    await sync.pull(); // the nudge: replay the rename, then the rows
    expect(await text(root, "archive/reports/q3.md")).toBe("N, pushed after the move");
    await sync.push();
    // The new path is current on the server; the resurrected old path keeps the same content.
    expect(server.content("archive/reports/q3.md")).toBe("N, pushed after the move");
    expect(server.content("reports/q3.md")).toBe("N, pushed after the move");
  });

  it("ignores server entries in its own area or with invalid names, whatever the server says", async () => {
    const root = await volume();
    const sync = await started(root);
    server.serverWrite(".kobe/sessions/t.jsonl", '{"forged":true}\n');
    server.serverWrite("ok.txt", "fine");
    await sync.pull();
    expect(await exists(root, ".kobe/sessions/t.jsonl")).toBe(false);
    expect(await text(root, "ok.txt")).toBe("fine");
  });

  it("turns itself off when the server has no workspace sync", async () => {
    server.failWith = 404;
    const root = await volume();
    const sync = await started(root);
    expect(sync.enabled).toBe(false);
    await expect(sync.beforeRun(runStart())).resolves.toBeUndefined();
  });

  it(
    "measures a full restore (localhost; see the ledger for real numbers)",
    { timeout: 30000 },
    async () => {
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
    },
  );
});

describe("pushPath (share_file: push one file and return its revision)", () => {
  it("uploads and commits one new file, and returns its rev and hash", async () => {
    const root = await volume();
    await put(root, "out/report.csv", "a,b\n1,2\n");
    await put(root, "other.txt", "not pushed");
    const sync = await started(root);
    const pushed = await sync.pushPath("out/report.csv");
    expect(pushed).toMatchObject({ path: "out/report.csv", size: 8 });
    expect(pushed.rev).toBeGreaterThan(0);
    expect(server.rows.get("out/report.csv")).toMatchObject({
      rev: pushed.rev,
      sha256: pushed.sha256,
    });
    expect(server.livePaths()).toEqual(["out/report.csv"]); // only that file
  });

  it("returns the existing revision for a file that is already synced and unchanged", async () => {
    const root = await volume();
    await put(root, "a.txt", "same");
    const sync = await started(root);
    await sync.push();
    const row = must(server.rows.get("a.txt"));
    expect(await sync.pushPath("a.txt")).toEqual({
      path: "a.txt",
      rev: row.rev,
      sha256: row.sha256,
      size: 4,
    });
    expect(server.rows.get("a.txt")?.rev).toBe(row.rev); // no new revision
  });

  it("commits a new revision for a file changed since the last sync", async () => {
    const root = await volume();
    await put(root, "a.txt", "one");
    const sync = await started(root);
    await sync.push();
    const first = must(server.rows.get("a.txt")).rev;
    await put(root, "a.txt", "two!");
    const pushed = await sync.pushPath("a.txt");
    expect(pushed.rev).toBeGreaterThan(first);
    expect(pushed.size).toBe(4);
  });

  it("fails clearly when the server rejects the push", async () => {
    const root = await volume();
    await put(root, "a.txt", "x");
    const sync = await started(root);
    server.failWith = 500;
    await expect(sync.pushPath("a.txt")).rejects.toThrow(/not_synced|could not be pushed/);
  });

  it("refuses a symlink, a missing file and an excluded or skipped path", async () => {
    const root = await volume();
    await put(root, ".kobe/x", "x");
    await put(root, "app/node_modules/dep.js", "x");
    await put(root, "real.txt", "x");
    await symlink(path.join(root, "real.txt"), path.join(root, "link.txt"));
    const sync = await started(root);
    for (const rel of ["link.txt", "missing.txt", ".kobe/x", "app/node_modules/dep.js"]) {
      await expect(sync.pushPath(rel), rel).rejects.toThrow();
    }
    expect(server.livePaths()).toEqual([]);
  });

  it("refuses to push when sync is off", async () => {
    const root = await volume();
    await put(root, "a.txt", "x");
    const sync = new WorkspaceSync({
      root,
      client: new SyncClient({ serverUrl, readToken: () => Promise.resolve(server.token) }),
      logger: quiet,
      intervalMs: 0,
    });
    await expect(sync.pushPath("a.txt")).rejects.toThrow(/not available/);
  });
});

function must<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("missing");
  return v;
}
