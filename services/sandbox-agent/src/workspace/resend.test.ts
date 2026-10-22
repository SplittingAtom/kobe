import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeSyncServer } from "../testing/fake-sync-server.js";
import { SyncClient } from "./client.js";
import { WorkspaceSync } from "./sync.js";

/**
 * KOBE-475: content the server lost from object storage is listed by `GET blobs/lost`; the agent
 * uploads what it still holds unchanged (no commit), and nothing else.
 */
const quiet = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
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
  server.lost.clear();
  server.noLostEndpoint = false;
  server.requests.length = 0;
});

async function chmodTree(dir: string): Promise<void> {
  await chmod(dir, 0o755).catch(() => {});
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) await chmodTree(path.join(dir, e.name));
  }
}

async function started(): Promise<{ root: string; sync: WorkspaceSync }> {
  const root = await mkdtemp(path.join(tmpdir(), "kobe-resend-"));
  roots.push(root);
  const sync = new WorkspaceSync({
    root,
    client: new SyncClient({ serverUrl, readToken: () => Promise.resolve(server.token) }),
    logger: quiet,
    intervalMs: 60_000,
    restoreWaitMs: 2_000,
  });
  syncs.push(sync);
  sync.start();
  await sync.ready();
  return { root, sync };
}

async function put(root: string, rel: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), content);
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const commits = () => server.requests.filter((r) => r === "POST /commit").length;

describe("resending lost content (KOBE-475)", () => {
  it("uploads unchanged files whose content the server lost, without a commit", async () => {
    const { root, sync } = await started();
    await put(root, "mortgage.py", "print('rate')\n");
    await put(root, "data/airbnb_sales.csv", "a,b\n1,2\n");
    await put(root, "fine.txt", "fine");
    await sync.push();
    const revs = server.livePaths().map((p) => server.rows.get(p)?.rev);
    for (const content of ["print('rate')\n", "a,b\n1,2\n"]) {
      server.blobs.delete(sha(content));
      server.lost.add(sha(content));
    }
    const before = commits();

    const stats = await sync.push();
    expect(stats.uploaded).toBe(2);
    expect(server.lost.size).toBe(0);
    expect(server.content("mortgage.py")).toBe("print('rate')\n");
    expect(server.content("data/airbnb_sales.csv")).toBe("a,b\n1,2\n");
    expect(commits()).toBe(before);
    expect(server.livePaths().map((p) => server.rows.get(p)?.rev)).toEqual(revs);
  });

  it("never resends a file changed since it synced (that is a normal push)", async () => {
    const { root, sync } = await started();
    await put(root, "notes.md", "v1");
    await sync.push();
    server.blobs.delete(sha("v1"));
    server.lost.add(sha("v1"));
    await put(root, "notes.md", "v2 edited");
    await utimes(path.join(root, "notes.md"), new Date(), new Date(Date.now() + 5_000));
    await sync.push();
    expect(server.lost.has(sha("v1"))).toBe(true);
    expect(server.content("notes.md")).toBe("v2 edited");
  });

  it("does nothing for content it does not hold", async () => {
    const { sync } = await started();
    server.lost.add(sha("not here"));
    const stats = await sync.push();
    expect(stats.uploaded).toBe(0);
    expect(server.requests.filter((r) => r.startsWith("PUT /blobs/"))).toEqual([]);
  });

  it("works against a server without the endpoint (404: nothing to resend)", async () => {
    server.noLostEndpoint = true;
    const { root, sync } = await started();
    await put(root, "a.txt", "a");
    const stats = await sync.push();
    expect(stats.uploaded).toBe(1);
    expect(server.content("a.txt")).toBe("a");
  });
});
