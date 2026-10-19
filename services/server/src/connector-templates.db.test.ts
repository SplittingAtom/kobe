import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnvelope } from "@kobe/db";
import { canonicalJson } from "@kobe/protocol";
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
  /** The proxy skipped the template part (e.g. resources/list failed). */
  skipped?: string;
  /** Runs while the probe is in flight (a concurrent admin edit). */
  during?: () => Promise<unknown>;
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

async function answer(url: string, key: string | undefined): Promise<ProbeResult> {
  const up = upstreams.get(new URL(url).hostname);
  if (!up) return { ok: false, failure: "unreachable" };
  if (up.key !== undefined && key !== up.key) return { ok: false, failure: "auth_required" };
  await up.during?.();
  return up.skipped === undefined
    ? { ok: true, tools: up.tools, uiResources: up.resources }
    : { ok: true, tools: up.tools, uiSkipped: up.skipped };
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
      invalid: [],
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
    expect(await refresh(id)).toMatchObject({
      status: "drifted",
      templates: { changed: 0, invalid: 1 },
    });
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

describe("review fixes (KOBE-433 review)", () => {
  const toolsOf = async (id: string) =>
    (await h.admin.query(`SELECT tools_snapshot FROM connectors WHERE id = $1`, [id])).rows[0]
      ?.tools_snapshot as { name: string; status: string; ui?: unknown; sha256: string }[];

  it("HIGH-1: a tool pinned before KOBE-433 does not drift when its upstream names a template", async () => {
    // G10's stored state: the tool pinned without `_meta`, so without `ui` in its hash.
    const plain = { name: "open", description: "Opens the app", inputSchema: { type: "object" } };
    const up: Upstream = { tools: [plain], resources: [] };
    const { id } = await register("apps-legacy", up);
    // What G10 left: pin_version 1 (the column default on upgrade, 0153).
    await h.admin.query(`UPDATE connectors SET pin_version = 1 WHERE id = $1`, [id]);
    const [before] = await toolsOf(id);
    expect(before).not.toHaveProperty("ui");
    // Exactly G10's pin: SHA-256 of the canonical {name, description, inputSchema}.
    expect(before?.sha256).toBe(
      sha(
        canonicalJson({
          name: "open",
          description: "Opens the app",
          inputSchema: { type: "object" },
        }),
      ),
    );
    up.tools = [{ ...plain, _meta: { ui: { resourceUri: "ui://l/app" } } }];
    up.resources = [template("ui://l/app", "<p>app</p>")];
    expect(await refresh(id)).toMatchObject({
      status: "drifted",
      changed: 0,
      added: 0,
      removed: 0,
      templates: { added: 1 },
    });
    const [after] = await toolsOf(id);
    expect(after).toMatchObject({
      name: "open",
      status: "pinned",
      ui: { resource_uri: "ui://l/app" },
    });
    expect(await rows(id)).toMatchObject([{ uri: "ui://l/app", status: "drifted" }]);
    expect(await refresh(id)).toEqual({ status: "unchanged" });
    const [version] = (
      await h.admin.query(`SELECT pin_version FROM connectors WHERE id = $1`, [id])
    ).rows;
    expect(version).toEqual({ pin_version: 2 });
  });

  it("NEW-1: after KOBE-433 a tool that starts naming an approved template drifts", async () => {
    const plain = { name: "other", description: "d", inputSchema: { type: "object" } };
    const up: Upstream = {
      tools: [appTool("open", "ui://a/app"), plain],
      resources: [template("ui://a/app", "<p>app</p>")],
    };
    const { id } = await register("apps-new1", up);
    expect(await rows(id)).toMatchObject([{ uri: "ui://a/app", status: "pinned" }]);
    up.tools = [
      appTool("open", "ui://a/app"),
      { ...plain, _meta: { ui: { resourceUri: "ui://a/app" } } },
    ];
    expect(await refresh(id)).toMatchObject({ status: "drifted", changed: 1 });
    const other = (await toolsOf(id)).find((t) => t.name === "other");
    expect(other).toMatchObject({ status: "drifted" });
    expect(other).not.toHaveProperty("ui");
  });

  it("NEW-2: an outdated proxy's template skip is stored, audited once and shown to site admins", async () => {
    const up: Upstream = {
      tools: [appTool("open", "ui://p/app")],
      resources: [template("ui://p/app", "ok")],
    };
    const { id } = await register("apps-outdated", up);
    up.skipped = "proxy_outdated";
    expect(await refresh(id)).toMatchObject({ templatesSkipped: "proxy_outdated" });
    expect(await refresh(id)).toMatchObject({ templatesSkipped: "proxy_outdated" });
    expect(await events("mcp.connector.templates_skipped", id)).toEqual([
      { connectorId: id, name: "apps-outdated", reason: "proxy_outdated" },
    ]);
    const view = await root.get(`${BASE}/${id}`);
    expect(view.json.connector.templatesSkipped).toBe("proxy_outdated");
    const notice = (await driftNoticesFor(db(), { id: rootId, siteRole: "admin" })).find(
      (n) => n.connectorId === id,
    );
    expect(notice).toMatchObject({ templatesSkipped: "proxy_outdated" });
    await notifyDrift({ db: db(), mailer: h.mailer, publicUrl: "https://kobe.test" });
    const mail = h.mailer.to("root@apps.test").filter((m) => m.subject.includes("apps-outdated"));
    expect(mail).toHaveLength(1);
    expect(must(mail[0]).subject).toMatch(/app templates are not checked/);
    // A checked pass clears it.
    delete up.skipped;
    expect(await refresh(id)).toEqual({ status: "unchanged" });
    expect((await root.get(`${BASE}/${id}`)).json.connector.templatesSkipped).toBeNull();
  });

  it("HIGH-2: an invalid new template is reported once with its reason, never as removed", async () => {
    const up: Upstream = {
      tools: [appTool("open", "ui://v/app")],
      resources: [template("ui://v/app", "ok")],
    };
    const { id } = await register("apps-report", up);
    await h.admin.query(
      `INSERT INTO team_connectors (team_id, connector_id, exposure, enabled_by) VALUES ($1, $2, 'all', $3)`,
      [team, id, rootId],
    );
    up.tools = [...up.tools, appTool("more", "ui://v/bad")];
    up.resources = [
      template("ui://v/app", "ok"),
      { ...template("ui://v/bad", "x"), meta: { "io.splittingatom/contentHash": sha("y") } },
    ];
    expect(await refresh(id)).toMatchObject({
      status: "drifted",
      templates: { added: 0, invalid: 1 },
    });
    expect((await events("mcp.connector.drift", id)).at(-1)?.templates).toEqual({
      changed: [],
      added: [],
      removed: [],
      invalid: [{ uri: "ui://v/bad", reason: "ui_resource_hash_mismatch" }],
    });
    expect(await refresh(id)).toEqual({ status: "unchanged" });
    expect(await servedTemplate(db(), id, "ui://v/bad")).toBeUndefined();
    const notice = (await driftNoticesFor(db(), { id: rootId, siteRole: "admin" })).find(
      (n) => n.connectorId === id,
    );
    expect(notice).toMatchObject({
      templates: ["ui://v/bad"],
      invalidTemplates: [{ uri: "ui://v/bad", reason: "ui_resource_hash_mismatch" }],
    });
    await notifyDrift({ db: db(), mailer: h.mailer, publicUrl: "https://kobe.test" });
    const mail = h.mailer.to("root@apps.test").filter((m) => m.subject.includes("apps-report"));
    expect(mail).toHaveLength(1);
    expect(must(mail[0]).text).toMatch(/ui:\/\/v\/bad \(its declared contentHash does not match/);
  });

  it("MEDIUM-1: NUL fails a pin with ui_resource_invalid (no 500) and never breaks the tools' refresh", async () => {
    const { pin } = await register("apps-nul", {
      tools: [appTool("open", "ui://n/app")],
      resources: [template("ui://n/app", "a\u0000b")],
    });
    expect(pin).toMatchObject({ ok: false, failure: "ui_resource_invalid" });

    const up: Upstream = {
      tools: [appTool("open", "ui://n2/app")],
      resources: [template("ui://n2/app", "ok")],
    };
    const { id } = await register("apps-nul2", up);
    up.tools = [...up.tools, { name: "later", inputSchema: { type: "object" } }];
    up.resources = [
      template("ui://n2/app", "ok", { ui: { csp: { connectDomains: ["x\u0000"] } } }),
    ];
    expect(await refresh(id)).toMatchObject({
      status: "drifted",
      added: 1,
      templates: { invalid: 1 },
    });
    expect((await toolsOf(id)).map((t) => [t.name, t.status])).toEqual([
      ["open", "pinned"],
      ["later", "drifted"],
    ]);
  });

  it("MEDIUM-3: a skipped template part leaves templates alone while tools refresh", async () => {
    const up: Upstream = {
      tools: [appTool("open", "ui://s/app")],
      resources: [template("ui://s/app", "ok")],
    };
    const { id } = await register("apps-skip", up);
    const before = await rows(id);
    up.tools = [...up.tools, { name: "later", inputSchema: { type: "object" } }];
    up.resources = [];
    up.skipped = "rpc_error";
    expect(await refresh(id)).toMatchObject({
      status: "drifted",
      added: 1,
      templates: { changed: 0, added: 0, removed: 0, invalid: 0 },
      templatesSkipped: "rpc_error",
    });
    expect(await rows(id)).toEqual(before);
    expect(await servedTemplate(db(), id, "ui://s/app")).toBeDefined();
  });

  it("a refresh racing a URL change writes no template", async () => {
    const up: Upstream = {
      tools: [appTool("open", "ui://r/app")],
      resources: [template("ui://r/app", "v1")],
    };
    const { id } = await register("apps-race", up);
    upstreams.set("apps-race2.example", { tools: [], resources: [] });
    up.resources = [template("ui://r/app", "v2")];
    up.during = () => root.patch(`${BASE}/${id}`, { url: "https://apps-race2.example/mcp" });
    expect(await refresh(id)).toEqual({ status: "skipped", reason: "changed" });
    expect(await rows(id)).toEqual([]);
  });

  it("serves nothing of a disabled or deleted connector", async () => {
    const { id } = await register("apps-off", {
      tools: [appTool("open", "ui://o/app")],
      resources: [template("ui://o/app", "ok")],
    });
    expect(await servedTemplate(db(), id, "ui://o/app")).toBeDefined();
    await h.admin.query(`UPDATE connectors SET status = 'disabled' WHERE id = $1`, [id]);
    expect(await servedTemplate(db(), id, "ui://o/app")).toBeUndefined();
    await h.admin.query(
      `UPDATE connectors SET status = 'active', deleted_at = now() WHERE id = $1`,
      [id],
    );
    expect(await servedTemplate(db(), id, "ui://o/app")).toBeUndefined();
  });
});
