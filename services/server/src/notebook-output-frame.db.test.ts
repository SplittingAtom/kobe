import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { FRAME_HEADERS } from "./artifacts/serve.js";
import { WEBRTC_GUARD } from "./connectors/app-frame.js";
import { NOTEBOOK_OUTPUT_FRAME_MESSAGE } from "./routes/notebook-output-frame.js";
import { EventStreamFixture, PUBLIC_URL, type Person } from "./testing/event-stream-fixture.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { TestBrowser } from "./testing/browser.js";
import { createWorkspaceSync } from "./workspace-sync/index.js";

/**
 * The notebook output frame (KOBE-465, docs/specs/notebooks.md NB4): a fixed shell document with
 * the artifact frame's headers, which shows the HTML its parent page posts to it. Kernel HTML is
 * never served from or injected into Kobe's page: it lands only in this opaque, network-less frame.
 */
const fx = new EventStreamFixture();
const silent = { error: () => {}, warn: () => {}, info: () => {} };
const LIMITS = { maxFileBytes: 1024 * 1024, maxWorkspaceBytes: 4 * 1024 * 1024, maxFiles: 10 };
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  await fx.setup([{}]);
  const sync = createWorkspaceSync({
    db: fx.db,
    objects: new MemoryObjects(),
    prefix: "",
    limits: LIMITS,
    log: silent,
  });
  app = createApp(fx.replica(0).deps, {
    workspaceFiles: { sync, waker: { wake: () => Promise.resolve() } },
  });
});

afterAll(() => fx.teardown());

function browserFor(p: Person): TestBrowser {
  const b = new TestBrowser(app, PUBLIC_URL);
  for (const [k, v] of p.browser.cookies) b.cookies.set(k, v);
  return b;
}

async function member() {
  const alice = await fx.person("alice");
  const team = await fx.team(`nf-${randomBytes(3).toString("hex")}`, alice);
  return { team, a: browserFor(alice) };
}

const url = (team: string | undefined) =>
  `/v1/workspace/output-frame${team === undefined ? "" : `?team=${team}`}`;

describe("GET /v1/workspace/output-frame", () => {
  it("serves the fixed shell with exactly the artifact frame headers and the WebRTC guard", async () => {
    const m = await member();
    const res = await m.a.get(url(m.team), {
      "sec-fetch-site": "same-origin",
      "sec-fetch-dest": "iframe",
    });
    expect(res.status).toBe(200);
    for (const [name, value] of Object.entries(FRAME_HEADERS)) {
      expect(res.headers.get(name), name).toBe(value);
    }
    expect(res.headers.get("content-security-policy")).toMatch(
      /^sandbox allow-scripts allow-forms;.*connect-src 'none'/,
    );
    expect(res.text.startsWith("<!doctype html>")).toBe(true);
    expect(res.text).toContain(WEBRTC_GUARD);
    // Shows only what its parent posts, once, with the expected message type.
    expect(res.text).toContain("e.source!==window.parent");
    expect(res.text).toContain(JSON.stringify(NOTEBOOK_OUTPUT_FRAME_MESSAGE));
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("refuses cross-site navigations, foreign origins and non-frame loads", async () => {
    const m = await member();
    for (const site of ["cross-site", "same-site"]) {
      const res = await m.a.get(url(m.team), { "sec-fetch-site": site });
      expect(res.status, site).toBe(403);
      expect(res.json).toMatchObject({ code: "forbidden_origin" });
    }
    expect((await m.a.get(url(m.team), { origin: "https://evil.example" })).status).toBe(403);
    expect((await m.a.get(url(m.team), { "sec-fetch-dest": "document" })).status).toBe(403);
  });

  it("requires the page's active team and refuses other parameters", async () => {
    const m = await member();
    expect((await m.a.get(url(undefined))).status).toBe(400);
    expect((await m.a.get(`${url(m.team)}&html=x`)).status).toBe(400);
    const stale = await m.a.get(url(randomUUID()));
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: "team_mismatch", activeTeamId: m.team });
  });

  it("refuses a signed-out request", async () => {
    const m = await member();
    const anon = new TestBrowser(app, PUBLIC_URL);
    expect((await anon.get(url(m.team))).status).toBe(401);
  });
});
