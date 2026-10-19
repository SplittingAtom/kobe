import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProbeResult } from "./connectors/probe.js";
import { refreshConnector } from "./connectors/refresh.js";
import { servedTemplate } from "./connectors/template-store.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-434 (MA-2): site admins review changed and new templates (hashes, size, declared _meta.ui,
 * the bytes as JSON for an escaped diff and a stubbed preview) and approve them by the reviewed
 * hash; a stale hash or an invalid template is refused; approvals are audited with the templates.
 */
const BASE = "/v1/site/connectors";
const MIME = "text/html;profile=mcp-app";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const team = randomUUID();

let h: Harness;
let root: TestBrowser;
let alice: TestBrowser;
const up = {
  tools: [] as Record<string, unknown>[],
  resources: [] as Record<string, unknown>[],
};

const appTool = (name: string, uri: string) => ({
  name,
  inputSchema: { type: "object" },
  _meta: { ui: { resourceUri: uri } },
});
const template = (uri: string, text: string, meta: Record<string, unknown> = {}) => ({
  uri,
  mimeType: MIME,
  text,
  meta,
});

beforeAll(async () => {
  h = await openHarness({
    connectors: { resolve: async () => ["93.184.216.34"] },
    connectorProbe: {
      probe: async (): Promise<ProbeResult> => ({
        ok: true,
        tools: up.tools,
        uiResources: up.resources,
      }),
    },
  });
  await h.createUser("root@review.test", "admin");
  const aliceId = await h.createUser("alice@review.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'rv', 'rv')`, [team]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
    [team, aliceId],
  );
  root = await h.signIn("root@review.test");
  alice = await h.signIn("alice@review.test");
});
afterAll(async () => {
  await h?.close();
});

const db = () => h.deps.database.db;
const refresh = (id: string) => refreshConnector(db(), h.deps.connectorProbe, id);

describe("template review (KOBE-434)", () => {
  it("reviews, refuses a stale or invalid approval, approves by hash and audits it", async () => {
    up.tools = [
      appTool("open", "ui://r/app"),
      appTool("more", "ui://r/new"),
      appTool("bad", "ui://r/bad"),
    ];
    up.resources = [template("ui://r/app", "v1")];
    const created = await root.post(BASE, {
      name: "review-a",
      url: "https://review-a.example/mcp",
    });
    const id = created.json.connector.id as string;
    expect(created.json.pin).toMatchObject({ ok: true, templates: 1 });

    up.resources = [
      template("ui://r/app", "<p>v2</p>", { ui: { prefersBorder: true } }),
      template("ui://r/new", "<p>new</p>"),
      { ...template("ui://r/bad", "x"), mimeType: "text/plain" },
    ];
    await refresh(id);
    const listed = await root.get(`${BASE}/${id}`);
    expect(listed.json.connector.templatesDriftedCount).toBe(3);

    const review = await root.get(`${BASE}/${id}/templates`);
    expect(review.status).toBe(200);
    interface Version {
      pinnedHash: string;
    }
    const byUri: Record<string, { live: Version; approved: Version }> = Object.fromEntries(
      (review.json.templates as { uri: string; live: Version; approved: Version }[]).map((t) => [
        t.uri,
        t,
      ]),
    );
    const at = (uri: string) => {
      const t = byUri[uri];
      if (!t) throw new Error(`no review of ${uri}`);
      return t;
    };
    expect(byUri["ui://r/app"]).toMatchObject({
      change: "changed",
      approved: { sha256: sha("v1"), bytes: 2 },
      live: { sha256: sha("<p>v2</p>"), bytes: 9, meta: { prefersBorder: true } },
    });
    expect(byUri["ui://r/new"]).toMatchObject({
      change: "added",
      live: { sha256: sha("<p>new</p>") },
    });
    expect(byUri["ui://r/bad"]).toMatchObject({
      change: "invalid",
      invalid: "ui_resource_invalid",
    });
    expect(JSON.stringify(review.json)).not.toContain("<p>v2</p>");

    // The bytes, for the diff and the preview: JSON with no-store, nosniff and a CSP.
    const source = await root.get(
      `${BASE}/${id}/templates/source?uri=${encodeURIComponent("ui://r/app")}`,
    );
    expect(source.json.source).toEqual({ uri: "ui://r/app", approved: "v1", live: "<p>v2</p>" });
    expect(source.headers.get("content-type")).toMatch(/^application\/json/);
    expect(source.headers.get("cache-control")).toBe("no-store");
    expect(source.headers.get("x-content-type-options")).toBe("nosniff");
    expect(source.headers.get("content-security-policy")).toBe("default-src 'none'");

    const liveHash = at("ui://r/app").live.pinnedHash;
    const approvedHash = at("ui://r/app").approved.pinnedHash;
    // ac-1: a stale hash (the approved one, or one changed meanwhile) is refused.
    const stale = await root.post(`${BASE}/${id}/templates/approve`, {
      templates: [{ uri: "ui://r/app", pinnedHash: approvedHash }],
    });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: "stale", uri: "ui://r/app" });
    const bad = await root.post(`${BASE}/${id}/templates/approve`, {
      templates: [{ uri: "ui://r/bad", pinnedHash: "a".repeat(64) }],
    });
    expect(bad.json).toMatchObject({ code: "invalid", uri: "ui://r/bad" });
    // Still drifted: nothing is served until it is approved.
    expect(await servedTemplate(db(), id, "ui://r/app")).toBeUndefined();

    // Members cannot review or approve.
    expect((await alice.get(`${BASE}/${id}/templates`)).status).toBe(403);
    expect(
      (
        await alice.post(`${BASE}/${id}/templates/approve`, {
          templates: [{ uri: "ui://r/app", pinnedHash: liveHash }],
        })
      ).status,
    ).toBe(403);

    const ok = await root.post(`${BASE}/${id}/templates/approve`, {
      templates: [
        { uri: "ui://r/app", pinnedHash: liveHash },
        { uri: "ui://r/new", pinnedHash: at("ui://r/new").live.pinnedHash },
      ],
    });
    expect(ok.status).toBe(200);
    expect(ok.json.approved).toEqual(["ui://r/app", "ui://r/new"]);
    expect(await servedTemplate(db(), id, "ui://r/app")).toMatchObject({ html: "<p>v2</p>" });
    expect(await servedTemplate(db(), id, "ui://r/new")).toMatchObject({ html: "<p>new</p>" });

    // ac-3: audited with URI and hash.
    const [audit] = (
      await h.admin.query<{ target: Record<string, unknown> }>(
        `SELECT target FROM audit_log WHERE action = 'mcp.connector.reapproved'
          AND target->>'connectorId' = $1 ORDER BY seq DESC LIMIT 1`,
        [id],
      )
    ).rows;
    expect(audit?.target).toEqual({
      connectorId: id,
      name: "review-a",
      tools: [],
      templates: [
        { uri: "ui://r/app", sha256: sha("<p>v2</p>") },
        { uri: "ui://r/new", sha256: sha("<p>new</p>") },
      ],
    });
    // The same live bytes on the next refresh: nothing pending.
    expect(await refresh(id)).toEqual({ status: "unchanged" });
  });
});
