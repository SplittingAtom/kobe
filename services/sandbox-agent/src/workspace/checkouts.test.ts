import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeSyncServer } from "../testing/fake-sync-server.js";
import { SyncClient } from "./client.js";
import { ensureParents, inCheckout, isLockedPath, lockServerOwned, projectSlugOf } from "./fs.js";
import { relockCheckout, unlockCheckout } from "./checkouts.js";
import { WorkspaceSync } from "./sync.js";

/**
 * Project checkouts in workspace sync (CM4, KOBE-580): a checked-out `projects/<slug>/` is free
 * area (scanned, pushed, 0664/0775) while its slug is in the latest pull; it is relocked and
 * brought back to the head when the slug leaves; the set is recomputed from every pull.
 */
const quiet = { debug: () => {}, info: () => {}, warn: () => {} };
const server = new FakeSyncServer();
let serverUrl: string;
const roots: string[] = [];
const syncs: WorkspaceSync[] = [];
const ACME = { project_id: "11111111-1111-4111-8111-111111111111", slug: "acme" };

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
  server.checkouts.length = 0;
  server.requests.length = 0;
});

async function chmodTree(dir: string): Promise<void> {
  await chmod(dir, 0o755).catch(() => {});
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) await chmodTree(path.join(dir, e.name));
  }
}

async function volume(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "kobe-co-"));
  roots.push(root);
  return root;
}

async function started(root: string): Promise<WorkspaceSync> {
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
  return sync;
}

const checkOut = (seq = 1) => server.checkouts.push({ ...ACME, base_commit_seq: seq });
const endCheckout = () => server.checkouts.splice(0);
const text = (root: string, rel: string) => readFile(path.join(root, rel), "utf8");
const mode = async (root: string, rel: string) => (await lstat(path.join(root, rel))).mode & 0o777;
const exists = (root: string, rel: string) =>
  lstat(path.join(root, rel)).then(
    () => true,
    () => false,
  );
const downloads = () => server.requests.filter((r) => r.startsWith("GET /file")).length;
const commits = () => server.requests.filter((r) => r === "POST /commit").length;

/** The head of two projects, as the server mounts them. */
function mountProjects(): void {
  server.serverWrite("projects/acme/run.sh", "#!/bin/sh\n", true);
  server.serverWrite("projects/acme/brief.md", "v1");
  server.serverWrite("projects/acme/docs/spec.md", "spec v1");
  server.serverWrite("projects/other/readme.md", "other");
}

describe("checkout paths", () => {
  it("maps paths to their project and checkout", () => {
    const set = new Set(["acme"]);
    expect(projectSlugOf("projects/acme/a/b.md")).toBe("acme");
    expect(projectSlugOf("projects/acme")).toBe("acme");
    expect(projectSlugOf("projects/")).toBeUndefined();
    expect(projectSlugOf("notes/projects/acme/x")).toBeUndefined();
    expect(inCheckout("projects/acme/a.md", set)).toBe(true);
    expect(inCheckout("projects/acme2/a.md", set)).toBe(false);
    expect(isLockedPath("projects/acme/a.md", set)).toBe(false);
    expect(isLockedPath("projects/other/a.md", set)).toBe(true);
    expect(isLockedPath("uploads/x/a.md", set)).toBe(true);
    expect(isLockedPath("notes/a.md", set)).toBe(false);
    expect(isLockedPath("projects/acme/a.md")).toBe(true); // no checkouts: read-only
  });
});

describe("workspace sync with project checkouts (CM4)", () => {
  it("restores a checked-out folder writable and pushes it; other projects stay read-only", async () => {
    mountProjects();
    checkOut();
    const root = await volume();
    const sync = await started(root);
    expect([...sync.checkouts]).toEqual(["acme"]);
    expect(await mode(root, "projects")).toBe(0o555);
    expect(await mode(root, "projects/acme")).toBe(0o775);
    expect(await mode(root, "projects/acme/docs")).toBe(0o775);
    expect(await mode(root, "projects/acme/brief.md")).toBe(0o664);
    expect(await mode(root, "projects/acme/run.sh")).toBe(0o775);
    expect(await mode(root, "projects/other")).toBe(0o555);
    expect(await mode(root, "projects/other/readme.md")).toBe(0o444);

    await writeFile(path.join(root, "projects/acme/brief.md"), "v2 by the agent");
    await mkdir(path.join(root, "projects/acme/new"));
    await writeFile(path.join(root, "projects/acme/new/notes.md"), "fresh");
    await rm(path.join(root, "projects/acme/docs/spec.md"));
    await chmod(path.join(root, "projects/other"), 0o755); // same uid: a model can undo the mode
    await chmod(path.join(root, "projects/other/readme.md"), 0o644);
    await writeFile(path.join(root, "projects/other/readme.md"), "vandalised");

    const stats = await sync.push();
    expect(stats).toMatchObject({ changes: 3, rejected: 0, conflicts: 0 });
    expect(server.content("projects/acme/brief.md")).toBe("v2 by the agent");
    expect(server.content("projects/acme/new/notes.md")).toBe("fresh");
    expect(server.content("projects/acme/docs/spec.md")).toBeUndefined();
    expect(server.content("projects/other/readme.md")).toBe("other");
    expect(await text(root, "projects/other/readme.md")).toBe("other");
    expect(await mode(root, "projects/other/readme.md")).toBe(0o444);
    // The folders the push made stay shared; nothing locked them.
    expect(await mode(root, "projects/acme/brief.md")).toBe(0o664);
  });

  it("unlocks a folder when its checkout starts on a pull, idempotently, without downloading", async () => {
    mountProjects();
    const root = await volume();
    const sync = await started(root);
    expect(await mode(root, "projects/acme/brief.md")).toBe(0o444);
    checkOut();
    const before = downloads();
    await sync.pull();
    expect(await mode(root, "projects/acme")).toBe(0o775);
    expect(await mode(root, "projects/acme/docs/spec.md")).toBe(0o664);
    expect(await mode(root, "projects/acme/run.sh")).toBe(0o775);
    await sync.pull();
    await sync.pull();
    expect(await mode(root, "projects/acme/brief.md")).toBe(0o664);
    expect(downloads()).toBe(before);
    expect((await sync.push()).changes).toBe(0);
  });

  it("downloads server writes into a checkout as shared files (Update), keeping local edits beside them", async () => {
    mountProjects();
    checkOut();
    const root = await volume();
    const sync = await started(root);
    await writeFile(path.join(root, "projects/acme/brief.md"), "my edit, not pushed");
    server.serverWrite("projects/acme/docs/spec.md", "spec v2 from Update");
    server.serverWrite("projects/acme/brief.md", "v2 from Update");
    await sync.pull();
    expect(await text(root, "projects/acme/docs/spec.md")).toBe("spec v2 from Update");
    expect(await mode(root, "projects/acme/docs/spec.md")).toBe(0o664);
    expect(await text(root, "projects/acme/brief.md")).toBe("v2 from Update");
    const names = await readdir(path.join(root, "projects/acme"));
    expect(names.some((n) => n.startsWith("brief.conflict-"))).toBe(true);
  });

  it("relocks the folder when the slug leaves the pull, and brings it back to the head", async () => {
    mountProjects();
    checkOut();
    const root = await volume();
    const sync = await started(root);
    // Pushed work, then unpushed work.
    await writeFile(path.join(root, "projects/acme/brief.md"), "v2 pushed");
    await writeFile(path.join(root, "projects/acme/pushed-new.md"), "pushed new file");
    await sync.push();
    await writeFile(path.join(root, "projects/acme/docs/spec.md"), "spec edit, not pushed");
    await mkdir(path.join(root, "projects/acme/scratch"));
    await writeFile(path.join(root, "projects/acme/scratch/tmp.md"), "never pushed");

    // Discard on the server: the member's rows go back to the head, the checkout ends.
    endCheckout();
    server.serverWrite("projects/acme/brief.md", "v1");
    server.serverDelete("projects/acme/pushed-new.md");
    const commitsBefore = commits();
    await sync.pull();

    expect([...sync.checkouts]).toEqual([]);
    expect(await text(root, "projects/acme/brief.md")).toBe("v1");
    expect(await text(root, "projects/acme/docs/spec.md")).toBe("spec v1");
    expect(await exists(root, "projects/acme/pushed-new.md")).toBe(false);
    expect(await exists(root, "projects/acme/scratch/tmp.md")).toBe(false);
    // Never lost: what the server never had is kept outside the read-only area.
    expect(await text(root, "kobe-moved/projects/acme/scratch/tmp.md")).toBe("never pushed");
    expect(await mode(root, "projects/acme")).toBe(0o555);
    expect(await mode(root, "projects/acme/docs")).toBe(0o555);
    expect(await mode(root, "projects/acme/brief.md")).toBe(0o444);
    expect(await mode(root, "projects/acme/docs/spec.md")).toBe(0o444);
    // From now on the folder is read-only: edits are reverted, nothing is committed there.
    await sync.push();
    expect(server.content("projects/acme/brief.md")).toBe("v1");
    expect(server.livePaths().filter((p) => p.startsWith("projects/acme/"))).toEqual([
      "projects/acme/brief.md",
      "projects/acme/docs/spec.md",
      "projects/acme/run.sh",
    ]);
    expect(commits()).toBe(commitsBefore + 1); // only the kobe-moved file, in the free area
    expect(server.content("kobe-moved/projects/acme/scratch/tmp.md")).toBe("never pushed");
  });

  it("recomputes checkouts after hibernation: kept while listed, relocked when it ended meanwhile", async () => {
    mountProjects();
    checkOut();
    const root = await volume();
    const first = await started(root);
    await writeFile(path.join(root, "projects/acme/brief.md"), "v2 pushed before sleeping");
    await first.flush(5_000);

    // Woken with the checkout still there: writable, the working copy kept.
    const second = await started(root);
    expect([...second.checkouts]).toEqual(["acme"]);
    expect(await mode(root, "projects/acme/brief.md")).toBe(0o664);
    expect(await text(root, "projects/acme/brief.md")).toBe("v2 pushed before sleeping");
    await second.flush(5_000);
    await writeFile(path.join(root, "projects/acme/later.md"), "written after the last push");

    // Discarded while asleep: the restore relocks the folder and brings back the head.
    endCheckout();
    server.serverWrite("projects/acme/brief.md", "v1");
    const third = await started(root);
    expect([...third.checkouts]).toEqual([]);
    expect(await text(root, "projects/acme/brief.md")).toBe("v1");
    expect(await mode(root, "projects/acme")).toBe(0o555);
    expect(await mode(root, "projects/acme/brief.md")).toBe(0o444);
    expect(await exists(root, "projects/acme/later.md")).toBe(false);
    expect(await text(root, "kobe-moved/projects/acme/later.md")).toBe(
      "written after the last push",
    );
  });

  it("never pushes into a project folder the server does not list as checked out", async () => {
    mountProjects();
    checkOut();
    const root = await volume();
    const sync = await started(root);
    await writeFile(path.join(root, "projects/acme/brief.md"), "edit");
    // The server ended the checkout but this sandbox has not pulled yet: the push is refused...
    endCheckout();
    const stats = await sync.push();
    expect(stats.rejected).toBe(1);
    expect(server.content("projects/acme/brief.md")).toBe("v1");
    // ...and the next pull relocks and restores the head.
    await sync.pull();
    expect(await text(root, "projects/acme/brief.md")).toBe("v1");
    expect(await mode(root, "projects/acme/brief.md")).toBe(0o444);
  });
});

describe("checkout permissions on disk (fs.ts)", () => {
  async function lockedProject(): Promise<string> {
    const root = await volume();
    await ensureParents(root, "projects/acme/docs/x.md");
    await writeFile(path.join(root, "projects/acme/docs/spec.md"), "spec", { mode: 0o444 });
    await writeFile(path.join(root, "projects/acme/run.sh"), "#!/bin/sh\n", { mode: 0o555 });
    await lockServerOwned(root, ["projects/"]);
    return root;
  }

  it("unlocks to 0775/0664 (executables 0775), keeps projects/ locked, and lockServerOwned leaves it", async () => {
    const root = await lockedProject();
    const executable = (rel: string) => rel === "projects/acme/run.sh"; // as the manifest says
    await unlockCheckout(root, "acme", executable);
    await unlockCheckout(root, "acme", executable); // idempotent
    expect(await mode(root, "projects")).toBe(0o555);
    expect(await mode(root, "projects/acme")).toBe(0o775);
    expect(await mode(root, "projects/acme/docs/spec.md")).toBe(0o664);
    expect(await mode(root, "projects/acme/run.sh")).toBe(0o775);
    await lockServerOwned(root, ["projects/"], new Set(["acme"]));
    expect(await mode(root, "projects/acme/docs")).toBe(0o775);
    expect(await mode(root, "projects")).toBe(0o555);
    // A new folder made for a download inside the checkout is shared, too.
    await ensureParents(root, "projects/acme/new/deep/f.md", new Set(["acme"]));
    expect(await mode(root, "projects/acme/new/deep")).toBe(0o775);
    expect(await mode(root, "projects")).toBe(0o755); // owner-only while being filled
  });

  it("relocks: group write off top down, links reported as foreign, then locked read-only", async () => {
    const root = await lockedProject();
    await unlockCheckout(root, "acme");
    await writeFile(path.join(root, "projects/acme/docs/new.md"), "tool output");
    await symlink("/etc/passwd", path.join(root, "projects/acme/docs/link"));
    const foreign = await relockCheckout(root, "acme");
    expect(foreign).toEqual([{ rel: "projects/acme/docs/link", kind: "other" }]);
    expect(await mode(root, "projects/acme")).toBe(0o755);
    expect(await mode(root, "projects/acme/docs")).toBe(0o755);
    await lockServerOwned(root, ["projects/"]);
    expect(await mode(root, "projects/acme/docs")).toBe(0o555);
    expect(await mode(root, "projects/acme/docs/new.md")).toBe(0o444);
  });

  it("never unlocks through a link planted inside the checkout (KOBE-580 review)", async () => {
    const root = await lockedProject();
    await ensureParents(root, "projects/other/x.md");
    await writeFile(path.join(root, "projects/other/readme.md"), "other", { mode: 0o444 });
    await mkdir(path.join(root, "mine"));
    await writeFile(path.join(root, "mine/own.md"), "mine", { mode: 0o600 });
    await lockServerOwned(root, ["projects/"]);
    await unlockCheckout(root, "acme");
    // A tool swaps a subfolder for a link to another project, and plants links to files.
    await rm(path.join(root, "projects/acme/docs"), { recursive: true });
    await symlink(path.join(root, "projects/other"), path.join(root, "projects/acme/docs"));
    await symlink(path.join(root, "mine/own.md"), path.join(root, "projects/acme/own.md"));
    await unlockCheckout(root, "acme"); // e.g. the next restore
    expect(await mode(root, "projects/other")).toBe(0o555);
    expect(await mode(root, "projects/other/readme.md")).toBe(0o444);
    expect(await mode(root, "mine/own.md")).toBe(0o600);
    // Locking does not follow them either; relock reports them for the sync to move out.
    await lockServerOwned(root, ["projects/"]);
    expect(await mode(root, "mine/own.md")).toBe(0o600);
    expect(await mode(root, "projects/other")).toBe(0o555);
    await unlockCheckout(root, "acme");
    const foreign = await relockCheckout(root, "acme");
    expect(foreign.map((f) => f.rel).sort()).toEqual([
      "projects/acme/docs",
      "projects/acme/own.md",
    ]);
    expect(await mode(root, "projects/other")).toBe(0o555);
  });

  it("does nothing when the slug folder itself is a link", async () => {
    const root = await lockedProject();
    await ensureParents(root, "projects/other/x.md");
    await lockServerOwned(root, ["projects/"]);
    await chmod(path.join(root, "projects"), 0o755);
    await symlink(path.join(root, "projects/other"), path.join(root, "projects/evil"));
    await unlockCheckout(root, "evil");
    expect(await relockCheckout(root, "evil")).toEqual([]);
    expect(await mode(root, "projects/other")).toBe(0o555);
  });

  it("ignores a slug that is not a plain folder name", async () => {
    const root = await lockedProject();
    expect(await relockCheckout(root, "..")).toEqual([]);
    expect(await relockCheckout(root, "missing")).toEqual([]);
    await unlockCheckout(root, "a/b");
    expect(await mode(root, "projects/acme")).toBe(0o555);
  });
});
