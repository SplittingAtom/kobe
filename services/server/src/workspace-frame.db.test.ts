import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTeam } from "@kobe/db";
import { createApp } from "./app.js";
import { FRAME_HEADERS } from "./artifacts/serve.js";
import { WORKSPACE_FRAME_MAX_BYTES } from "./routes/workspace-frame.js";
import { EventStreamFixture, PUBLIC_URL, type Person } from "./testing/event-stream-fixture.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { TestBrowser } from "./testing/browser.js";
import {
  createWorkspaceSync,
  workspaceBlobKey,
  type WorkspaceSync,
} from "./workspace-sync/index.js";

/**
 * The workspace HTML frame (KOBE-268) against a real Postgres: the caller's own synced HTML file
 * as an iframe document with the artifact frame's headers, and nothing else: no cross-site
 * navigation, no other team, no other member's file, no other file type.
 */
const fx = new EventStreamFixture();
const objects = new MemoryObjects();
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const LIMITS = { maxFileBytes: 4 * 1024 * 1024, maxWorkspaceBytes: 16 * 1024 * 1024, maxFiles: 50 };
let sync: WorkspaceSync;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await fx.setup([{}]);
  sync = createWorkspaceSync({ db: fx.db, objects, prefix: "", limits: LIMITS, log: silent });
  app = createApp(fx.replica(0).deps, {
    workspaceFiles: { sync, waker: { wake: () => Promise.resolve() } },
  });
});

afterAll(() => fx.teardown());

/** A browser signed in as `p`, sending no X-Kobe-Team (an iframe can't). */
function browserFor(p: Person): TestBrowser {
  const b = new TestBrowser(app, PUBLIC_URL);
  for (const [k, v] of p.browser.cookies) b.cookies.set(k, v);
  return b;
}

async function world() {
  const alice = await fx.person("alice");
  const bob = await fx.person("bob");
  const team = await fx.team(`f-${randomBytes(3).toString("hex")}`, alice, [bob]);
  return { team, alice, bob, a: browserFor(alice), b: browserFor(bob) };
}

async function seed(team: string, who: Person, path: string, content: string | Buffer) {
  const data = Buffer.from(content);
  const owner = { teamId: team, userId: who.id };
  const hash = createHash("sha256").update(data).digest("hex");
  const key = workspaceBlobKey("", owner, hash);
  objects.objects.set(key, data);
  await withTeam(fx.db, team, (tx) =>
    sync.putServerFile(tx, owner, { path, sha256: hash, size: data.length, blobKey: key }, "user"),
  );
  return key;
}

const frame = (path: string, team: string | undefined) =>
  `/v1/workspace/frame?path=${encodeURIComponent(path)}${team === undefined ? "" : `&team=${team}`}`;

async function downloads(team: string) {
  const { rows } = await fx.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'workspace.file_downloaded'`,
    [team],
  );
  return rows.map((r) => r.target);
}

describe("GET /v1/workspace/frame", () => {
  it("serves the caller's html file with exactly the artifact frame headers", async () => {
    const w = await world();
    await seed(w.team, w.alice, "site/index.html", "<h1>hi</h1><script>1</script>");
    const res = await w.a.get(frame("site/index.html", w.team), {
      "sec-fetch-site": "same-origin",
    });
    expect(res.status).toBe(200);
    expect(res.text).toBe("<h1>hi</h1><script>1</script>");
    for (const [name, value] of Object.entries(FRAME_HEADERS)) {
      expect(res.headers.get(name), name).toBe(value);
    }
    expect(res.headers.get("content-security-policy")).toMatch(
      /^sandbox allow-scripts allow-forms;.*connect-src 'none'/,
    );
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await downloads(w.team)).toEqual([{ userId: w.alice.id, bytes: 29 }]);
    // .htm and upper case count as html.
    await seed(w.team, w.alice, "Old.HTM", "<p>old</p>");
    expect((await w.a.get(frame("Old.HTM", w.team))).text).toBe("<p>old</p>");
  });

  it("refuses cross-site navigations and foreign origins", async () => {
    const w = await world();
    await seed(w.team, w.alice, "a.html", "<p>x</p>");
    for (const site of ["cross-site", "same-site"]) {
      const res = await w.a.get(frame("a.html", w.team), { "sec-fetch-site": site });
      expect(res.status, site).toBe(403);
      expect(res.json).toMatchObject({ code: "forbidden_origin" });
    }
    const foreign = await w.a.get(frame("a.html", w.team), { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect((await w.a.get(frame("a.html", w.team), { "sec-fetch-site": "none" })).status).toBe(200);
    expect(await downloads(w.team)).toHaveLength(1);
  });

  it("requires the page's team, and refuses a team that is not the active one", async () => {
    const w = await world();
    await seed(w.team, w.alice, "a.html", "<p>x</p>");
    expect((await w.a.get(frame("a.html", undefined))).status).toBe(400);
    const stale = await w.a.get(frame("a.html", randomUUID()));
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: "team_mismatch", activeTeamId: w.team });
    // Alice in another team (now active) can't reach the first team's file under either id.
    const other = await fx.team(`g-${randomBytes(3).toString("hex")}`, w.alice);
    expect((await w.a.get(frame("a.html", w.team))).status).toBe(409);
    expect((await w.a.get(frame("a.html", other))).status).toBe(404);
    expect(await downloads(w.team)).toEqual([]);
  });

  it("never serves a teammate's file, even by exact path", async () => {
    const w = await world();
    await seed(w.team, w.alice, "secret.html", "<p>alice only</p>");
    const res = await w.b.get(frame("secret.html", w.team));
    expect(res.status).toBe(404);
    expect(res.text).not.toContain("alice only");
  });

  it("refuses non-html files before reading them", async () => {
    const w = await world();
    for (const path of ["notes.md", "pic.svg", "page.html.txt", "doc.pdf", "html"]) {
      await seed(w.team, w.alice, path, "<script>1</script>");
      const res = await w.a.get(frame(path, w.team));
      expect(res.status, path).toBe(400);
      expect(res.json, path).toMatchObject({ code: "not_frameable" });
      expect(res.headers.get("x-frame-options"), path).toBeNull();
    }
    expect(await downloads(w.team)).toEqual([]);
  });

  it("answers 404 for unknown, deleted, internal and lost files; 400 for bad paths", async () => {
    const w = await world();
    for (const bad of ["../x.html", "/x.html", "a/../x.html", ""]) {
      expect((await w.a.get(frame(bad, w.team))).status, bad).toBe(400);
    }
    const extra = await w.a.get(`${frame("x.html", w.team)}&download=1`);
    expect(extra.status).toBe(400);
    expect((await w.a.get(frame("nope.html", w.team))).status).toBe(404);
    expect((await w.a.get(frame(".kobe/state.html", w.team))).status).toBe(404);
    await seed(w.team, w.alice, "gone.html", "<p>gone</p>");
    await w.a.request("DELETE", "/v1/workspace/files?path=gone.html", undefined, {
      "x-kobe-team": w.team,
    });
    expect((await w.a.get(frame("gone.html", w.team))).status).toBe(404);
    const key = await seed(w.team, w.alice, "lost.html", "<p>lost</p>");
    objects.lost.add(key);
    expect((await w.a.get(frame("lost.html", w.team))).status).toBe(404);
  });

  it("refuses NUL, backslash and encoded traversal, before any lookup", async () => {
    const w = await world();
    await seed(w.team, w.alice, "x.html", "<p>x</p>");
    for (const raw of ["x%00.html", "a%5Cx.html", "%2e%2e%2fx.html", "a%2F%2e%2e%2Fx.html"]) {
      const res = await w.a.get(`/v1/workspace/frame?path=${raw}&team=${w.team}`);
      expect(res.status, raw).toBe(400);
    }
    expect(await downloads(w.team)).toEqual([]);
  });

  it("refuses a caller who is no longer a member of the team", async () => {
    // Every team role holds team.chat; losing membership is the way to lose it.
    const w = await world();
    await seed(w.team, w.bob, "b.html", "<p>bob</p>");
    await fx.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      w.team,
      w.bob.id,
    ]);
    const res = await w.b.get(frame("b.html", w.team));
    expect(res.status).toBe(403);
    expect(res.text).not.toContain("bob");
  });

  it("answers 413 for a stored object over the cap, and a clean 503 on a stream error", async () => {
    const w = await world();
    const key = await seed(w.team, w.alice, "grew.html", "<p>small</p>");
    objects.objects.set(key, Buffer.alloc(WORKSPACE_FRAME_MAX_BYTES + 1, 0x61));
    const grew = await w.a.get(frame("grew.html", w.team));
    expect(grew.status).toBe(413);
    expect(grew.json).toMatchObject({ code: "file_too_large" });

    await seed(w.team, w.alice, "broken.html", "<p>broken</p>");
    const failing = new Readable({
      read() {
        this.destroy(new Error("storage hiccup"));
      },
    });
    vi.spyOn(objects, "get").mockResolvedValueOnce({ body: failing, size: 13 });
    const broken = await w.a.get(frame("broken.html", w.team));
    expect(broken.status).toBe(503);
    expect(broken.json).toMatchObject({ code: "content_unavailable" });
    expect(broken.text).not.toContain("hiccup");
  });

  it("refuses files over the frame cap without reading them", async () => {
    const w = await world();
    await seed(w.team, w.alice, "big.html", Buffer.alloc(WORKSPACE_FRAME_MAX_BYTES + 1, 0x61));
    const res = await w.a.get(frame("big.html", w.team));
    expect(res.status).toBe(413);
    expect(res.json).toMatchObject({ code: "file_too_large" });
    expect(await downloads(w.team)).toEqual([]);
  });

  it("requires a session", async () => {
    const anon = new TestBrowser(app, PUBLIC_URL);
    expect((await anon.get(frame("a.html", randomUUID()))).status).toBe(401);
  });
});
