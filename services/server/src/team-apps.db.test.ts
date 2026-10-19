import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadEnvelope } from "@kobe/db";
import type { AppCallRequest } from "./apps/app-caller.js";
import { appIdOf } from "./apps/app-id.js";
import type { ProbeResult } from "./connectors/probe.js";
import { withWebRtcGuard } from "./connectors/app-frame.js";
import { refreshConnector } from "./connectors/refresh.js";
import type { TestBrowser } from "./testing/browser.js";
import { logger } from "./logger.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-436 (MA-4): MCP Apps' own calls under the member's browser principal: only pinned,
 * read-only, app-visible, exposed tools of the app's own connector, policy at `app_bridge`
 * (deny rules deny, ask denies, no allow rule widens), every decision audited, the member's own
 * credential sent to the proxy only, and the template served as JSON only.
 */
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("expected a value");
  return v;
};
const SITE = "/v1/site/connectors";
const MIME = "text/html;profile=mcp-app";
const SITE_KEY = "site-key-0123456789abcdef";
const MEMBER_KEY = "member-key-0123456789abcd";
const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
const team = randomUUID();
const otherTeam = randomUUID();

let h: Harness;
let root: TestBrowser;
let alice: TestBrowser;
let bob: TestBrowser;
let aliceId = "";
let bobId = "";
let rootId = "";
const calls: AppCallRequest[] = [];
const upstream = new Map<string, { tools: Record<string, unknown>[]; resources: unknown[] }>();

const t = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  description: `${name} tool`,
  inputSchema: {
    type: "object",
    properties: { table: { type: "string" } },
    additionalProperties: false,
  },
  ...extra,
});
const READ = { annotations: { readOnlyHint: true } };
const TOOLS = [
  t("open_explorer", { ...READ, _meta: { ui: { resourceUri: "ui://cat/explorer" } } }),
  t("preview_table", { ...READ, _meta: { ui: { visibility: ["app"] } } }),
  t("query_sql", { ...READ, _meta: { ui: { visibility: ["model"] } } }),
  t("drop_table", { annotations: { destructiveHint: true } }),
  {
    name: "search",
    description: "search tool",
    // The review's catastrophic pattern (HIGH-1): exponential on "a"×n + "!".
    inputSchema: {
      type: "object",
      properties: { q: { type: "string", pattern: "^(\\w+\\s?)*$" } },
    },
    ...READ,
    _meta: { ui: { visibility: ["app"] } },
  },
];
const TEMPLATE = "<!doctype html><p>explorer</p>";
const RESOURCES = [{ uri: "ui://cat/explorer", mimeType: MIME, text: TEMPLATE, meta: {} }];

/** Every log line, to check no key is ever logged (ac-2). */
const logged: string[] = [];

beforeAll(async () => {
  for (const level of ["info", "warn", "error", "debug"] as const) {
    const real = logger[level].bind(logger);
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
      return (real as (...a: unknown[]) => void)(...args);
    }) as never);
  }
  h = await openHarness({
    envelope: must(loadEnvelope({ KOBE_ENVELOPE_KEY: "e".repeat(48) })),
    connectors: { resolve: async () => ["93.184.216.34"] },
    connectorProbe: {
      probe: async (url): Promise<ProbeResult> => {
        const up = upstream.get(new URL(url).hostname);
        return up
          ? { ok: true, tools: up.tools, uiResources: up.resources }
          : { ok: false, failure: "unreachable" };
      },
    },
    appCaller: {
      call: async (request) => {
        calls.push(request);
        return { ok: true, result: { content: [{ type: "text", text: "rows" }] } };
      },
    },
  });
  rootId = await h.createUser("root@apps4.test", "admin");
  aliceId = await h.createUser("alice@apps4.test");
  bobId = await h.createUser("bob@apps4.test");
  for (const id of [team, otherTeam]) {
    await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, $2, $2)`, [
      id,
      `t${id.slice(0, 6)}`,
    ]);
  }
  for (const [user, role] of [
    [rootId, "team_admin"],
    [aliceId, "member"],
    [bobId, "member"],
  ] as const) {
    await h.admin.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
      team,
      user,
      role,
    ]);
  }
  root = await h.signIn("root@apps4.test");
  alice = await h.signIn("alice@apps4.test");
  bob = await h.signIn("bob@apps4.test");
  for (const b of [root, alice, bob]) {
    await b.put("/v1/me/teams/active", { teamId: team });
    b.team = team;
  }
});
afterAll(async () => {
  await h?.close();
});

const db = () => h.deps.database.db;

async function connector(
  name: string,
  options: { authKind?: "none" | "api_key"; credentialSource?: "member" | "site" } = {},
): Promise<string> {
  upstream.set(`${name}.example`, { tools: TOOLS, resources: RESOURCES });
  const res = await root.post(SITE, {
    name,
    url: `https://${name}.example/mcp`,
    ...(options.authKind ? { authKind: options.authKind } : {}),
    ...(options.credentialSource ? { credentialSource: options.credentialSource } : {}),
  });
  const id = res.json.connector.id as string;
  if (options.credentialSource === "site") {
    expect((await root.put(`${SITE}/${id}/site-key`, { api_key: SITE_KEY })).status).toBe(200);
  }
  if (res.json.pin?.ok !== true) {
    // An api_key connector pins with a key (the site key above).
    expect((await root.post(`${SITE}/${id}/pin`)).json.pin).toMatchObject({ ok: true });
  }
  await enable(id, "all");
  return id;
}
const enable = (id: string, exposure: string, tools: string[] = []) =>
  h.admin.query(
    `INSERT INTO team_connectors (team_id, connector_id, exposure, enabled_tools, enabled_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (team_id, connector_id) DO UPDATE SET exposure = $3, enabled_tools = $4`,
    [team, id, exposure, tools, rootId],
  );
const appCall = (who: TestBrowser, appId: string, tool: string, args: unknown = { table: "t" }) =>
  who.post(`/v1/team/apps/${appId}/calls`, { tool, arguments: args });
const audits = async (connectorId: string) =>
  (
    await h.admin.query<{ team_id: string; actor_id: string; target: Record<string, unknown> }>(
      `SELECT team_id, actor_id, target FROM audit_log
        WHERE action = 'mcp.app_call' AND target->>'connectorId' = $1 ORDER BY seq`,
      [connectorId],
    )
  ).rows;

describe("app calls (ac-1, ac-4)", () => {
  it("lists the app, serves the template as JSON only (ac-5), and allows a read app-visible tool", async () => {
    const id = await connector("apps4-none");
    const appId = appIdOf(id, "ui://cat/explorer");
    const list = await alice.get("/v1/team/apps");
    expect(list.json.apps).toContainEqual({
      appId,
      connectorId: id,
      connectorName: "apps4-none",
      iconUrl: null,
      tool: "open_explorer",
      title: "open_explorer",
      uri: "ui://cat/explorer",
      sha256: sha(TEMPLATE),
    });

    const template = await alice.get(`/v1/team/apps/${appId}/template`);
    expect(template.status).toBe(200);
    expect(template.headers.get("content-type")).toMatch(/^application\/json/);
    expect(template.headers.get("cache-control")).toBe("no-store");
    expect(template.headers.get("x-content-type-options")).toBe("nosniff");
    expect(template.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(template.json).toEqual({
      html: TEMPLATE,
      sha256: sha(TEMPLATE),
      connectorId: id,
      uri: "ui://cat/explorer",
    });

    calls.length = 0;
    const ok = await appCall(alice, appId, "preview_table");
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ result: { content: [{ type: "text", text: "rows" }] } });
    expect(calls).toEqual([
      {
        connectorId: id,
        url: "https://apps4-none.example/mcp",
        tool: "preview_table",
        arguments: { table: "t" },
      },
    ]);
    const [row] = await audits(id);
    expect(row).toMatchObject({
      team_id: team,
      actor_id: aliceId,
      target: {
        connectorId: id,
        userId: aliceId,
        tool: "preview_table",
        decision: "allowed",
        reason: "allowed",
        templateSha256: sha(TEMPLATE),
      },
    });
  });

  it("denies and audits write, model-only, unknown, other-connector, drifted and bad-argument calls", async () => {
    const id = await connector("apps4-deny");
    const other = await connector("apps4-other");
    const appId = appIdOf(id, "ui://cat/explorer");
    upstream.set("apps4-other.example", {
      tools: [...TOOLS, t("only_other", READ)],
      resources: RESOURCES,
    });
    calls.length = 0;
    const cases: [string, unknown, number, string][] = [
      ["drop_table", { table: "t" }, 403, "tool_not_read_only"],
      ["query_sql", { table: "t" }, 403, "tool_not_app_visible"],
      ["only_other", { table: "t" }, 403, "tool_not_in_app"],
      ["preview_table", { table: 7 }, 422, "invalid_arguments"],
      ["preview_table", { extra: "x" }, 422, "invalid_arguments"],
      ["preview_table", "not an object", 422, "invalid_arguments"],
    ];
    for (const [tool, args, status, code] of cases) {
      const res = await appCall(alice, appId, tool, args);
      expect([tool, res.status, res.json.error?.code]).toEqual([tool, status, code]);
    }
    // A tool that drifted upstream is refused until it is re-approved.
    upstream.set("apps4-deny.example", {
      tools: TOOLS.map((x) =>
        x.name === "preview_table" ? { ...x, description: "now different" } : x,
      ),
      resources: RESOURCES,
    });
    await refreshConnector(db(), h.deps.connectorProbe, id);
    expect((await appCall(alice, appId, "preview_table")).json.error.code).toBe("tool_drifted");
    expect(calls).toEqual([]);
    expect((await audits(id)).map((r) => [r.target.decision, r.target.reason])).toEqual([
      ["denied", "tool_not_read_only"],
      ["denied", "tool_not_app_visible"],
      ["denied", "tool_not_in_app"],
      ["denied", "invalid_arguments"],
      ["denied", "invalid_arguments"],
      ["denied", "invalid_arguments"],
      ["denied", "tool_drifted"],
    ]);
    expect(other).not.toBe(id);
  });

  it("refuses outside a custom exposure, and once the team disables the connector", async () => {
    const id = await connector("apps4-exp");
    const appId = appIdOf(id, "ui://cat/explorer");
    await enable(id, "custom", ["mcp__apps4_exp__open_explorer"]);
    expect((await appCall(alice, appId, "preview_table")).json.error.code).toBe(
      "connector_exposure",
    );
    await enable(id, "custom", ["mcp__apps4_exp__open_explorer", "mcp__apps4_exp__preview_table"]);
    expect((await appCall(alice, appId, "preview_table")).status).toBe(200);
    await h.admin.query(`DELETE FROM team_connectors WHERE connector_id = $1`, [id]);
    const gone = await appCall(alice, appId, "preview_table");
    expect([gone.status, gone.json.error.code]).toEqual([404, "app_not_available"]);
    expect(
      (await alice.get("/v1/team/apps")).json.apps.map((a: { appId: string }) => a.appId),
    ).not.toContain(appId);
    expect((await audits(id)).map((r) => r.target.reason)).toEqual([
      "connector_exposure",
      "allowed",
      "app_not_available",
    ]);
  });

  it("a team deny rule denies, an ask rule denies, and a user allow rule never widens (ac-4)", async () => {
    const id = await connector("apps4-rules");
    const appId = appIdOf(id, "ui://cat/explorer");
    const rule = (scope: string, effect: string, glob: string, user: string | null = null) =>
      h.admin.query(
        `INSERT INTO tool_rules (team_id, scope, user_id, effect, tool_glob, created_by, remember_scope)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [team, scope, user, effect, glob, rootId, scope === "user" ? "forever" : null],
      );
    await rule("user", "allow", "mcp__apps4_rules__drop_table", aliceId);
    expect((await appCall(alice, appId, "drop_table")).json.error.code).toBe("tool_not_read_only");
    const ask = await rule("team", "ask", "mcp__apps4_rules__preview_table");
    expect((await appCall(alice, appId, "preview_table")).json.error.code).toBe("app_no_prompt");
    await h.admin.query(`DELETE FROM tool_rules WHERE id = $1`, [ask.rows[0]?.id]);
    await rule("team", "deny", "mcp__apps4_rules__*");
    expect((await appCall(alice, appId, "preview_table")).json.error.code).toBe("team_deny_rule");
  });
});

describe("member app frame and tools/list (KOBE-437, MA-5)", () => {
  const frameUrl = (appId: string, query: Record<string, string>) =>
    `/v1/team/apps/${appId}/frame?${new URLSearchParams(query).toString()}`;

  it("serves only the approved template as text/html with the sandboxing header CSP", async () => {
    const id = await connector("apps5-frame");
    const appId = appIdOf(id, "ui://cat/explorer");
    const ok = { team, sha256: sha(TEMPLATE) };
    const frame = await alice.get(frameUrl(appId, ok), { "sec-fetch-dest": "iframe" });
    expect(frame.status).toBe(200);
    // The pinned bytes, after the WebRTC guard (review MEDIUM-2).
    expect(frame.text).toBe(withWebRtcGuard(TEMPLATE));
    expect(frame.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(frame.headers.get("content-security-policy")).toBe(
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; " +
        "style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src 'none'; " +
        "connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; " +
        "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; " +
        "webrtc 'block'",
    );
    expect(frame.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(frame.headers.get("referrer-policy")).toBe("no-referrer");
    expect(frame.headers.get("cache-control")).toMatch(/no-store/);
    expect(frame.headers.get("x-content-type-options")).toBe("nosniff");

    // Only into a frame of Kobe's own page, for the team the page names, for the bytes it names.
    const status = async (who: TestBrowser, q: Record<string, string>, hdr = {}) =>
      (await who.get(frameUrl(appId, q), hdr)).status;
    expect(await status(alice, ok, { "sec-fetch-dest": "document" })).toBe(403);
    expect(await status(alice, ok, { "sec-fetch-site": "cross-site" })).toBe(403);
    expect(await status(alice, { sha256: ok.sha256 })).toBe(400);
    expect(await status(alice, { team })).toBe(400);
    expect(await status(alice, { ...ok, extra: "1" })).toBe(400);
    expect(await status(alice, { ...ok, team: otherTeam })).toBe(409);
    expect(await status(alice, { ...ok, sha256: sha("other") })).toBe(409);
    expect(await status(alice, ok)).toBe(200);
    expect(await status(alice, { ...ok }, { "sec-fetch-dest": "iframe" })).toBe(200);
    // An unknown app answers JSON, never HTML.
    const missing = await alice.get(frameUrl("f".repeat(64), ok));
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toMatch(/^application\/json/);

    // A drifted template is never served to members.
    upstream.set("apps5-frame.example", {
      tools: TOOLS,
      resources: [{ ...RESOURCES[0], text: "<p>changed upstream</p>" }],
    });
    await refreshConnector(db(), h.deps.connectorProbe, id);
    expect(await status(alice, ok)).toBe(404);
    expect(await status(alice, { ...ok, sha256: sha("<p>changed upstream</p>") })).toBe(404);
  });

  it("refuses a member without a key (404) and someone removed from the team (403)", async () => {
    const own = await connector("apps5-own", { authKind: "api_key" });
    const ownApp = appIdOf(own, "ui://cat/explorer");
    const url = frameUrl(ownApp, { team, sha256: sha(TEMPLATE) });
    // Bob holds no key for this connector: the app is not his.
    expect((await bob.get(url)).status).toBe(404);
    expect((await bob.get(`/v1/team/apps/${ownApp}/tools`)).status).toBe(404);
    const id = await connector("apps5-gone");
    const goneApp = appIdOf(id, "ui://cat/explorer");
    const gone = frameUrl(goneApp, { team, sha256: sha(TEMPLATE) });
    const daveId = await h.createUser("dave@apps5.test");
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
      [team, daveId],
    );
    const dave = await h.signIn("dave@apps5.test");
    await dave.put("/v1/me/teams/active", { teamId: team });
    dave.team = team;
    expect((await dave.get(gone)).status).toBe(200);
    await h.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      team,
      daveId,
    ]);
    expect((await dave.get(gone)).status).toBe(403);
  });

  it("lists only the tools the app may call, in MCP's shape", async () => {
    const id = await connector("apps5-tools");
    const appId = appIdOf(id, "ui://cat/explorer");
    const res = await alice.get(`/v1/team/apps/${appId}/tools`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const names = (res.json.tools as { name: string }[]).map((x) => x.name).sort();
    expect(names).toEqual(["open_explorer", "preview_table", "search"]);
    expect(res.json.tools).toContainEqual({
      name: "preview_table",
      description: "preview_table tool",
      inputSchema: TOOLS[1]?.inputSchema,
      annotations: { readOnlyHint: true },
    });
    // A custom exposure narrows it like a call.
    const piName = (n: string) => `mcp__apps5_tools__${n}`;
    await enable(id, "custom", [piName("open_explorer")]);
    const narrowed = await alice.get(`/v1/team/apps/${appId}/tools`);
    expect((narrowed.json.tools as { name: string }[]).map((x) => x.name)).toEqual([
      "open_explorer",
    ]);
    expect((await alice.get(`/v1/team/apps/${"f".repeat(64)}/tools`)).status).toBe(404);
  });
});

describe("hostile inputs (review HIGH-1, MEDIUM-1)", () => {
  it("refuses a catastrophic pattern within the deadline, audited, and the server keeps answering", async () => {
    const id = await connector("apps4-redos");
    const appId = appIdOf(id, "ui://cat/explorer");
    const started = Date.now();
    const res = await appCall(alice, appId, "search", { q: `${"a".repeat(50)}!` });
    expect([res.status, res.json.error?.code]).toEqual([422, "invalid_arguments"]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await appCall(alice, appId, "search", { q: "fine words" })).status).toBe(200);
    expect((await audits(id)).map((r) => r.target.reason)).toEqual([
      "invalid_arguments",
      "allowed",
    ]);
  });

  it("takes one validation per member at a time: a second is busy (503), not invalid", async () => {
    const id = await connector("apps4-busy");
    const appId = appIdOf(id, "ui://cat/explorer");
    const slow = appCall(alice, appId, "search", { q: `${"a".repeat(50)}!` });
    // Give the first call time to reach the pool.
    await new Promise((r) => setTimeout(r, 30));
    const busy = await appCall(alice, appId, "search", { q: "fine words" });
    expect([busy.status, busy.json.error?.code]).toEqual([503, "validation_busy"]);
    // Bob is not held up by Alice's task.
    expect((await appCall(bob, appId, "search", { q: "fine words" })).status).toBe(200);
    expect((await slow).json.error?.code).toBe("invalid_arguments");
    expect((await audits(id)).map((r) => r.target.reason).sort()).toEqual([
      "allowed",
      "invalid_arguments",
      "validation_busy",
    ]);
  });

  it("refuses a body over 96 KiB before parsing it", async () => {
    const id = await connector("apps4-big");
    const appId = appIdOf(id, "ui://cat/explorer");
    const res = await appCall(alice, appId, "preview_table", { table: "x".repeat(100 * 1024) });
    expect(res.status).toBe(413);
  });
});

describe("rate limit (spec T10)", () => {
  it("allows a burst of 30 calls per member, then refuses with 429, audited once", async () => {
    const id = await connector("apps4-rate");
    const appId = appIdOf(id, "ui://cat/explorer");
    // Calls take a few ms each and tokens refill at 5 per second: go until refused.
    const statuses: number[] = [];
    while (statuses.length < 200 && statuses.at(-1) !== 429) {
      statuses.push((await appCall(root, appId, "preview_table")).status);
    }
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(30);
    expect((await audits(id)).filter((r) => r.target.reason === "rate_limited")).toHaveLength(1);
  });
});

describe("credentials (ac-2) and who may call (ac-3)", () => {
  it("sends the site key or the member's own key to the proxy only", async () => {
    const id = await connector("apps4-site", { authKind: "api_key", credentialSource: "site" });
    const appId = appIdOf(id, "ui://cat/explorer");
    calls.length = 0;
    const res = await appCall(alice, appId, "preview_table");
    expect(res.status).toBe(200);
    expect(calls[0]?.credential).toEqual({ kind: "api_key", apiKey: SITE_KEY });

    const own = await connector("apps4-own", { authKind: "api_key" });
    const ownApp = appIdOf(own, "ui://cat/explorer");
    // Bob has no key: the app is not his, and a call is refused (audited).
    expect(
      (await bob.get("/v1/team/apps")).json.apps.map((a: { appId: string }) => a.appId),
    ).not.toContain(ownApp);
    expect((await appCall(bob, ownApp, "preview_table")).json.error.code).toBe("app_not_available");
    expect((await alice.put(`/v1/connector-grants/${own}`, { api_key: MEMBER_KEY })).status).toBe(
      201,
    );
    calls.length = 0;
    expect((await appCall(alice, ownApp, "preview_table")).status).toBe(200);
    expect(calls[0]?.credential).toEqual({ kind: "api_key", apiKey: MEMBER_KEY });

    // No key in any response, audit row or event.
    const everything = JSON.stringify([
      res.json,
      (await alice.get("/v1/team/apps")).json,
      (await h.admin.query(`SELECT target FROM audit_log`)).rows,
      (await h.admin.query(`SELECT * FROM events`).catch(() => ({ rows: [] }))).rows,
    ]);
    expect(everything).not.toContain(SITE_KEY);
    expect(everything).not.toContain(MEMBER_KEY);
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain(SITE_KEY);
    expect(logged.join("\n")).not.toContain(MEMBER_KEY);
  });

  it("refuses a member removed from the team and a deactivated member at once", async () => {
    const id = await connector("apps4-who");
    const appId = appIdOf(id, "ui://cat/explorer");
    expect((await appCall(bob, appId, "preview_table")).status).toBe(200);
    await h.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      team,
      bobId,
    ]);
    expect((await appCall(bob, appId, "preview_table")).status).toBe(403);
    expect((await root.post(`/v1/site/users/${aliceId}/deactivate`)).status).toBe(200);
    expect((await appCall(alice, appId, "preview_table")).status).toBe(401);
  });
});
