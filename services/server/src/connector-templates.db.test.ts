import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnvelope } from "@kobe/db";
import { driftNoticesFor } from "./connectors/drift-recipients.js";
import { notifyDrift } from "./connectors/drift-notify.js";
import type { ProbeResult } from "./connectors/probe.js";
import { refreshConnector } from "./connectors/refresh.js";
import { servedTemplate } from "./connectors/template-store.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-433 (MA-1, spec mcp-apps-host §5): a connector's `ui://` templates are pinned with its
 * tools, hashed by Kobe, drift like tools (changed and new ones are not served until approved,
 * removed ones go), are named in the drift event, email and notice, and are probed with the
 * KOBE-431 credential, so an `auth_required` skip leaves them as they were.
 */
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("expected a value");
  return v;
};
const BASE = "/v1/site/connectors";
const MIME = "text/html;profile=mcp-app";
const ADMIN_KEY = "admin-key-0123456789abcdef";
const team = randomUUID();
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

let h: Harness;
let root: TestBrowser;
let rootId = "";

interface Upstream {
  tools: Record<string, unknown>[];
  resources: Record<string, unknown>[];
  /** Answer only this key (api_key connectors). */
  key?: string;
}
const upstreams = new Map<string, Upstream>();
const probedKeys: (string | undefined)[] = [];

const appTool = (name: string, uri: string) => ({
  name,
  description: "Opens the app",
  inputSchema: { type: "object" },
  annotations: { readOnlyHint: true },
  _meta: { ui: { resourceUri: uri } },
});
const template = (uri: string, text: string, meta: Record<string, unknown> = {}) => ({
  uri,
  mimeType: MIME,
  text,
  meta: { "io.splittingatom/contentHash": sha(text), ...meta },
});

function answer(url: string, key: string | undefined): ProbeResult {
  const up = upstreams.get(new URL(url).hostname);
  if (!up) return { ok: false, failure: "unreachable" };
  if (up.key !== undefined && key !== up.key) return { ok: false, failure: "auth_required" };
  return { ok: true, tools: up.tools, uiResources: up.resources };
}

beforeAll(async () => {
  h = await openHarness({
    envelope: must(loadEnvelope({ KOBE_ENVELOPE_KEY: "e".repeat(48) })),
    connectors: { resolve: async () => ["93.184.216.34"] },
    connectorProbe: {
      probe: async (url, apiKey) => {
        probedKeys.push(apiKey);
        return answer(url, apiKey);
      },
    },
  });
  rootId = await h.createUser("root@apps.test", "admin");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'apps', 'apps')`, [team]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin')`,
    [team, rootId],
  );
  root = await h.signIn("root@apps.test");
  await root.put("/v1/me/teams/active", { teamId: team });
  root.team = team;
});
afterAll(async () => {
  await h?.close();
});

const db = () => h.deps.database.db;
const refresh = (id: string) =>
  refreshConnector(db(), h.deps.connectorProbe, id, { envelope: h.deps.envelope });
const rows = async (id: string) =>
  (
    await h.admin.query<{
      uri: string;
      sha256: string;
      status: string;
      html: string;
      proposed: Record<string, unknown> | null;
      pinned_by: string | null;
    }>(
      `SELECT uri, sha256, status, html, proposed, pinned_by FROM connector_ui_resources
        WHERE connector_id = $1 ORDER BY uri`,
      [id],
    )
  ).rows;
const events = async (action: string, connectorId: string) =>
  (
    await h.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE action = $1 AND target->>'connectorId' = $2 ORDER BY seq`,
      [action, connectorId],
    )
  ).rows.map((r) => r.target);

/** Registers (and so pins) a `none`-auth connector served by `up`. */
async function register(name: string, up: Upstream) {
  upstreams.set(`${name}.example`, up);
  const res = await root.post(BASE, { name, url: `https://${name}.example/mcp` });
  expect(res.status).toBe(201);
  return { id: res.json.connector.id as string, pin: res.json.pin as Record<string, unknown> };
}

describe("pinning templates (ac-1)", () => {
  it("stores each named template with Kobe's own SHA-256 and audits URI and hash", async () => {
    const html = "<!doctype html><p>Explorer</p>";
    const { id, pin } = await register("apps-pin", {
      tools: [appTool("open_explorer", "ui://apps/explorer"), { name: "plain", inputSchema: {} }],
      resources: [
        template("ui://apps/explorer", html, { ui: { prefersBorder: false } }),
        template("ui://apps/unnamed", "<p>not named by any tool</p>"),
      ],
    });
    expect(pin).toEqual({ ok: true, tools: 2, templates: 1 });
    expect(await rows(id)).toEqual([
      {
        uri: "ui://apps/explorer",
        sha256: sha(html),
        status: "pinned",
        html,
        proposed: null,
        pinned_by: rootId,
      },
    ]);
    expect(await servedTemplate(db(), id, "ui://apps/explorer")).toMatchObject({
      html,
      sha256: sha(html),
    });
    const [pinned] = await events("mcp.connector.pinned", id);
    expect(pinned?.templates).toEqual([{ uri: "ui://apps/explorer", sha256: sha(html) }]);
    expect(JSON.stringify(pinned)).not.toContain("Explorer</p>");
  });

  it("fails the pin with a clear code on a hash mismatch, a wrong type or a template too large", async () => {
    const cases = [
      [
        "apps-hash",
        { ...template("ui://x/a", "a"), meta: { "io.splittingatom/contentHash": sha("b") } },
        "ui_resource_hash_mismatch",
      ],
      ["apps-type", { ...template("ui://x/a", "a"), mimeType: "text/html" }, "ui_resource_invalid"],
      ["apps-size", template("ui://x/a", "x".repeat(512 * 1024 + 1)), "ui_resource_invalid"],
      ["apps-proxy", { uri: "ui://x/a", error: "too_large" }, "ui_resource_invalid"],
    ] as const;
    for (const [name, resource, failure] of cases) {
      const { id, pin } = await register(name, {
        tools: [appTool("open", "ui://x/a")],
        resources: [resource],
      });
      expect(pin, name).toMatchObject({ ok: false, failure, message: expect.any(String) });
      expect(await rows(id), name).toEqual([]);
      const [connector] = (
        await h.admin.query(`SELECT tools_hash FROM connectors WHERE id = $1`, [id])
      ).rows;
      expect(connector, name).toEqual({ tools_hash: null });
    }
  });

  it("drops the templates when the connector's URL changes", async () => {
    const { id } = await register("apps-url", {
      tools: [appTool("open", "ui://u/a")],
      resources: [template("ui://u/a", "a")],
    });
    expect(await rows(id)).toHaveLength(1);
    upstreams.set("apps-url2.example", { tools: [], resources: [] });
    const res = await root.patch(`${BASE}/${id}`, { url: "https://apps-url2.example/mcp" });
    expect(res.status).toBe(200);
    expect(await rows(id)).toEqual([]);
  });
});

describe("template drift (ac-2)", () => {
  it("drifts a changed template, adds a new one as drifted, removes a gone one", async () => {
    const up: Upstream = {
      tools: [appTool("open", "ui://d/app"), appTool("other", "ui://d/old")],
      resources: [template("ui://d/app", "v1"), template("ui://d/old", "old")],
    };
    const { id } = await register("apps-drift", up);
    await h.admin.query(
      `INSERT INTO team_connectors (team_id, connector_id, exposure, enabled_by) VALUES ($1, $2, 'all', $3)`,
      [team, id, rootId],
    );
    expect(await refresh(id)).toEqual({ status: "unchanged" });

    up.tools = [
      appTool("open", "ui://d/app"),
      appTool("other", "ui://d/old"),
      appTool("more", "ui://d/new"),
    ];
    up.resources = [template("ui://d/app", "<script>v2</script>"), template("ui://d/new", "new")];
    expect(await refresh(id)).toMatchObject({
      status: "drifted",
      templates: { changed: 1, added: 1, removed: 1 },
    });
    expect(await rows(id)).toMatchObject([
      {
        uri: "ui://d/app",
        status: "drifted",
        html: "v1",
        proposed: { html: "<script>v2</script>", sha256: sha("<script>v2</script>") },
      },
      { uri: "ui://d/new", status: "drifted", html: "new", proposed: null, pinned_by: null },
    ]);
    // Neither is served: the changed one keeps its approved bytes only for review.
    expect(await servedTemplate(db(), id, "ui://d/app")).toBeUndefined();
    expect(await servedTemplate(db(), id, "ui://d/new")).toBeUndefined();
    expect(await servedTemplate(db(), id, "ui://d/old")).toBeUndefined();

    const drift = await events("mcp.connector.drift", id);
    expect(drift.at(-1)?.templates).toEqual({
      changed: ["ui://d/app"],
      added: ["ui://d/new"],
      removed: ["ui://d/old"],
    });
    // The same live state again is no new event.
    expect(await refresh(id)).toEqual({ status: "unchanged" });

    const notice = (await driftNoticesFor(db(), { id: rootId, siteRole: "admin" })).find(
      (n) => n.connectorId === id,
    );
    expect(notice?.templates).toEqual(["ui://d/app", "ui://d/new"]);
    await notifyDrift({ db: db(), mailer: h.mailer, publicUrl: "https://kobe.test" });
    const mail = h.mailer.to("root@apps.test").filter((m) => m.subject.includes("apps-drift"));
    expect(mail).toHaveLength(1);
    expect(must(mail[0]).text).toContain("ui://d/app");
    expect(must(mail[0]).text).toContain("ui://d/new");
    expect(must(mail[0]).text).not.toContain("<script>");
  });

  it("drifts an approved template whose live one became invalid, and recovers", async () => {
    const up: Upstream = {
      tools: [appTool("open", "ui://i/app")],
      resources: [template("ui://i/app", "ok")],
    };
    const { id } = await register("apps-invalid", up);
    up.resources = [{ ...template("ui://i/app", "ok"), mimeType: "text/plain" }];
    expect(await refresh(id)).toMatchObject({ status: "drifted", templates: { changed: 1 } });
    expect(await rows(id)).toMatchObject([
      { status: "drifted", html: "ok", proposed: { invalid: "ui_resource_invalid" } },
    ]);
    expect(await servedTemplate(db(), id, "ui://i/app")).toBeUndefined();
    up.resources = [template("ui://i/app", "ok")];
    expect(await refresh(id)).toEqual({ status: "unchanged" });
    expect(await rows(id)).toMatchObject([{ status: "pinned", proposed: null }]);
    expect(await servedTemplate(db(), id, "ui://i/app")).toBeDefined();
  });
});

describe("the refresh credential covers templates (ac-4)", () => {
  it("probes with the admin's key, and an auth_required skip leaves the templates as they were", async () => {
    const up: Upstream = {
      tools: [appTool("open", "ui://k/app")],
      resources: [template("ui://k/app", "k1")],
      key: ADMIN_KEY,
    };
    upstreams.set("apps-key.example", up);
    const created = await root.post(BASE, {
      name: "apps-key",
      url: "https://apps-key.example/mcp",
      authKind: "api_key",
    });
    const id = created.json.connector.id as string;
    expect(created.json.pin).toMatchObject({ ok: false, failure: "auth_required" });
    await h.admin.query(
      `INSERT INTO team_connectors (team_id, connector_id, exposure, enabled_by) VALUES ($1, $2, 'all', $3)`,
      [team, id, rootId],
    );
    expect((await root.put(`/v1/connector-grants/${id}`, { api_key: ADMIN_KEY })).status).toBe(201);
    expect((await root.post(`${BASE}/${id}/pin`)).json.pin).toEqual({
      ok: true,
      tools: 1,
      templates: 1,
    });

    probedKeys.length = 0;
    up.resources = [template("ui://k/app", "k2")];
    expect(await refresh(id)).toMatchObject({ status: "drifted", templates: { changed: 1 } });
    expect(probedKeys).toEqual([ADMIN_KEY]);

    // Approve nothing; drop the admin's key: the refresh skips and touches no template.
    const before = await rows(id);
    await root.delete(`/v1/connector-grants/${id}`);
    up.resources = [template("ui://k/app", "k3")];
    expect(await refresh(id)).toEqual({ status: "skipped", reason: "auth_required" });
    expect(await rows(id)).toEqual(before);
    const [skip] = (
      await h.admin.query(`SELECT refresh_skipped FROM connectors WHERE id = $1`, [id])
    ).rows;
    expect(skip).toEqual({ refresh_skipped: "auth_required" });
  });
});
