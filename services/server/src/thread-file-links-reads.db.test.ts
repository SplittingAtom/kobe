import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";

/**
 * The reads of thread–file links (KOBE-611, contract thread-file-links.ts, privacy TFM7): per
 * thread (batched and one), per path; only readable threads, files named only in the viewer's own
 * workspace or a readable project; a teammate's shared thread shows project files only and counts
 * the rest; another team sees nothing; caps and validation.
 */
const fx = new EventStreamFixture();

let a: Person;
let b: Person;
let c: Person;
let team = "";
let slug = "";
let projectId = "";
let privateThread = "";
let sharedThread = "";
let bThread = "";

async function thread(owner: Person, title: string, shared = false): Promise<string> {
  const { rows } = await fx.admin.query<{ id: string }>(
    `INSERT INTO threads (team_id, owner_user_id, title, shared_to_team) VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [team, owner.id, title, shared],
  );
  return must(rows[0], "thread").id;
}

async function link(
  threadId: string,
  scope: { owner?: string; project?: string },
  path: string,
  access: "read" | "write",
  lastAt: string,
) {
  await fx.admin.query(
    `INSERT INTO thread_file_links
       (team_id, thread_id, owner_user_id, project_id, path, access, first_at, last_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [team, threadId, scope.owner ?? null, scope.project ?? null, path, access, lastAt],
  );
}

beforeAll(async () => {
  await fx.setup([{}]);
  a = await fx.person("a");
  b = await fx.person("b");
  c = await fx.person("c");
  team = await fx.team(`tflr-${randomBytes(3).toString("hex")}`, a, [b]);
  await fx.team(`tflo-${randomBytes(3).toString("hex")}`, c);
  slug = `docs-${randomBytes(2).toString("hex")}`;
  const { rows } = await fx.admin.query<{ id: string }>(
    `INSERT INTO projects (team_id, slug, name, created_by) VALUES ($1, $2, 'Docs', $3) RETURNING id`,
    [team, slug, a.id],
  );
  projectId = must(rows[0], "project").id;
  privateThread = await thread(a, "A private");
  sharedThread = await thread(a, "A shared", true);
  bThread = await thread(b, "B own");
  await link(privateThread, { owner: a.id }, "notes/a.md", "read", "2026-11-01T10:00:00Z");
  await link(privateThread, { owner: a.id }, "notes/a.md", "write", "2026-11-01T11:00:00Z");
  await link(privateThread, { project: projectId }, "guide.md", "read", "2026-11-01T09:00:00Z");
  await link(sharedThread, { owner: a.id }, "secret.md", "read", "2026-11-02T10:00:00Z");
  await link(sharedThread, { project: projectId }, "guide.md", "write", "2026-11-02T11:00:00Z");
  await link(bThread, { owner: b.id }, "b.md", "read", "2026-11-03T10:00:00Z");
  await fx.admin.query(
    `UPDATE thread_file_links SET deleted_at = now() WHERE thread_id = $1 AND path = 'secret.md'`,
    [sharedThread],
  );
});

afterAll(async () => {
  await fx.teardown();
});

const batch = (p: Person, ids: readonly string[]) =>
  p.browser.get(`/v1/threads/file-links?threads=${ids.join(",")}`);

describe("GET /v1/threads/file-links and /v1/threads/{id}/file-links", () => {
  it("gives the owner every file of their threads, write winning over read", async () => {
    const res = await batch(a, [privateThread, sharedThread, bThread]);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toEqual({
      links: [
        {
          thread_id: privateThread,
          files: [
            {
              path: "notes/a.md",
              project_id: null,
              access: "write",
              last_at: "2026-11-01T11:00:00.000Z",
              deleted: false,
            },
            {
              path: `projects/${slug}/guide.md`,
              project_id: projectId,
              access: "read",
              last_at: "2026-11-01T09:00:00.000Z",
              deleted: false,
            },
          ],
          hidden_count: 0,
        },
        {
          thread_id: sharedThread,
          files: [
            {
              path: `projects/${slug}/guide.md`,
              project_id: projectId,
              access: "write",
              last_at: "2026-11-02T11:00:00.000Z",
              deleted: false,
            },
            {
              path: "secret.md",
              project_id: null,
              access: "read",
              last_at: "2026-11-02T10:00:00.000Z",
              deleted: true,
            },
          ],
          hidden_count: 0,
        },
        // B's private thread is not readable: left out.
      ],
    });
  });

  it("shows a teammate's shared thread with project files only, the rest counted (TFM7)", async () => {
    const res = await batch(b, [privateThread, sharedThread, bThread]);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      links: [
        {
          thread_id: sharedThread,
          files: [
            {
              path: `projects/${slug}/guide.md`,
              project_id: projectId,
              access: "write",
              last_at: "2026-11-02T11:00:00.000Z",
              deleted: false,
            },
          ],
          hidden_count: 1,
        },
        {
          thread_id: bThread,
          files: [
            {
              path: "b.md",
              project_id: null,
              access: "read",
              last_at: "2026-11-03T10:00:00.000Z",
              deleted: false,
            },
          ],
          hidden_count: 0,
        },
      ],
    });
    const one = await b.browser.get(`/v1/threads/${sharedThread}/file-links`);
    expect(one.status).toBe(200);
    expect(one.json).toMatchObject({ thread_id: sharedThread, hidden_count: 1 });
    expect((await b.browser.get(`/v1/threads/${privateThread}/file-links`)).status).toBe(404);
  });

  it("never shows another team's threads", async () => {
    const res = await batch(c, [privateThread, sharedThread]);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ links: [] });
    expect((await c.browser.get(`/v1/threads/${sharedThread}/file-links`)).status).toBe(404);
  });

  it("validates ids, the cap and unknown parameters", async () => {
    const many = Array.from(
      { length: 51 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    for (const query of [
      "",
      "?threads=",
      "?threads=nope",
      `?threads=${many.join(",")}`,
      `?threads=${privateThread}&extra=1`,
    ]) {
      expect((await a.browser.get(`/v1/threads/file-links${query}`)).status, query).toBe(400);
    }
    expect((await a.browser.get(`/v1/threads/not-a-uuid/file-links`)).status).toBe(400);
    // Repeated ids are read once.
    const dup = await a.browser.get(
      `/v1/threads/file-links?threads=${bThread}&threads=${sharedThread}&threads=${sharedThread}`,
    );
    expect(dup.status).toBe(200);
    expect((dup.json as { links: unknown[] }).links).toHaveLength(1);
  });
});

describe("GET /v1/workspace/file-threads", () => {
  const ask = (p: Person, paths: readonly string[]) =>
    p.browser.get(
      `/v1/workspace/file-threads?${paths.map((x) => `paths=${encodeURIComponent(x)}`).join("&")}`,
    );

  it("names readable threads newest first and counts the others", async () => {
    const res = await ask(b, [`projects/${slug}/guide.md`, "b.md", "notes/a.md"]);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toEqual({
      files: [
        {
          path: `projects/${slug}/guide.md`,
          threads: [
            {
              thread_id: sharedThread,
              title: "A shared",
              access: "write",
              last_at: "2026-11-02T11:00:00.000Z",
            },
          ],
          more: 1,
        },
        {
          path: "b.md",
          threads: [
            {
              thread_id: bThread,
              title: "B own",
              access: "read",
              last_at: "2026-11-03T10:00:00.000Z",
            },
          ],
          more: 0,
        },
        // B's own notes/a.md: A's link is in A's workspace, never B's.
        { path: "notes/a.md", threads: [], more: 0 },
      ],
    });
    const owner = await a.browser.get(
      `/v1/workspace/file-threads?paths=projects/${slug}/guide.md,notes/a.md`,
    );
    expect(owner.json).toMatchObject({
      files: [
        {
          threads: [{ thread_id: sharedThread }, { thread_id: privateThread }],
          more: 0,
        },
        { threads: [{ thread_id: privateThread, access: "write" }], more: 0 },
      ],
    });
  });

  it("counts a thread in Trash and shows nothing to another team", async () => {
    await fx.admin.query(`UPDATE threads SET deleted_at = now() WHERE id = $1`, [privateThread]);
    const res = await ask(a, ["notes/a.md"]);
    expect(res.json).toEqual({ files: [{ path: "notes/a.md", threads: [], more: 1 }] });
    await fx.admin.query(`UPDATE threads SET deleted_at = NULL WHERE id = $1`, [privateThread]);
    const other = await ask(c, [`projects/${slug}/guide.md`, "notes/a.md"]);
    expect(other.json).toEqual({
      files: [
        { path: `projects/${slug}/guide.md`, threads: [], more: 0 },
        { path: "notes/a.md", threads: [], more: 0 },
      ],
    });
  });

  it("takes repeated values whole (a comma in a name) and validates paths and the cap", async () => {
    const res = await ask(b, ["a,b.md", "b.md"]);
    expect(res.status).toBe(200);
    expect((res.json as { files: { path: string }[] }).files.map((f) => f.path)).toEqual([
      "a,b.md",
      "b.md",
    ]);
    const tooMany = Array.from({ length: 101 }, (_, i) => `f${i}.md`);
    for (const query of [
      "",
      "?paths=",
      "?paths=../x",
      "?paths=/abs",
      `?paths=${tooMany.join(",")}`,
      "?paths=a&x=1",
    ]) {
      expect((await b.browser.get(`/v1/workspace/file-threads${query}`)).status, query).toBe(400);
    }
  });
});
