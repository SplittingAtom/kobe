import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { orbitExperimentSchema } from "./agents/orbit/orbit-schema.js";
import type { TestBrowser } from "./testing/browser.js";
import { enableConnector, piName, registerConnector } from "./testing/mcp-fixtures.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * Orbit export over HTTP (KOBE-91): a published version as YAML, the model alias resolved to a
 * provider id, team walls, rights per role, and the audit event.
 */
type Person = "alice" | "bob" | "carol" | "erin";
// Finance: alice team_admin, bob builder, carol member. Marketing: erin builder.
const finance = randomUUID();
const marketing = randomUUID();
const as = {} as Record<Person, TestBrowser>;
const ids = {} as Record<Person, string>;
let h: Harness;
const ANY = { "if-match": "*" };

beforeAll(async () => {
  h = await openHarness({ agents: { publishRate: { windowMs: 60_000, max: 10_000 } } });
  for (const who of ["alice", "bob", "carol", "erin"] as const) {
    ids[who] = await h.createUser(`${who}@orbit.test`);
  }
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'finance', 'Finance'), ($2, 'marketing', 'Marketing')`,
    [finance, marketing],
  );
  const members: [string, Person, string][] = [
    [finance, "alice", "team_admin"],
    [finance, "bob", "builder"],
    [finance, "carol", "member"],
    [marketing, "erin", "builder"],
  ];
  for (const [team, who, role] of members) {
    await h.admin.query(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
      team,
      ids[who],
      role,
    ]);
  }
  await h.admin.query(
    `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
     VALUES ('anthropic', 'anthropic', 'anthropic', 'v2.test.sealed-provider-key', $1)`,
    [ids.alice],
  );
  for (const [alias, model] of [
    ["smart", "claude-smart"],
    ["fast", "claude-fast"],
    ["other", "claude-other"],
  ] as const) {
    await h.admin.query(
      `INSERT INTO model_catalog (alias, provider_id, model, created_by) VALUES ($1, 'anthropic', $2, $3)`,
      [alias, model, ids.alice],
    );
  }
  // Finance enables smart (default) and fast; Marketing enables nothing.
  for (const [alias, isDefault] of [
    ["smart", true],
    ["fast", false],
  ] as const) {
    await h.admin.query(
      `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, $2, $3, $4)`,
      [finance, alias, isDefault, ids.alice],
    );
  }
  for (const who of ["alice", "bob", "carol", "erin"] as const) {
    as[who] = await h.signIn(`${who}@orbit.test`);
    const team = who === "erin" ? marketing : finance;
    const res = await as[who].put("/v1/me/teams/active", { teamId: team });
    expect(res.status).toBe(200);
    as[who].team = team;
  }
});

afterAll(async () => {
  await h?.close();
});

async function published(who: Person, extra: object = {}): Promise<string> {
  const created = await as[who].post("/v1/agents", {
    scope: "team",
    frontmatter: { name: `Exporter ${randomUUID().slice(0, 6)}`, ...extra },
    prompt: "You export.",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  const res = await as[who].request("POST", `/v1/agents/${id}/publish`, {}, ANY);
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return id;
}

const orbit = (who: Person, id: string, version = 1) =>
  as[who].get(`/v1/agents/${id}/versions/${version}/orbit`);

describe("GET /v1/agents/:id/versions/:version/orbit (KOBE-91)", () => {
  it("exports a published version as an attachment, with the alias resolved", async () => {
    const id = await published("bob", { model: "fast" });
    const res = await orbit("bob", id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^application\/yaml/);
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="exporter-.*-v1\.orbit\.yaml"$/,
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.text).not.toMatch(/MCP tools are not included/);
    const config = orbitExperimentSchema.parse(parse(res.text));
    expect(config.setup.agents[0]?.model).toBe("anthropic/claude-fast");
    expect(config.setup.agents[0]?.system_prompt).toBe("You export.");
  });

  it("uses the team default when the agent pins no model", async () => {
    const id = await published("bob");
    const config = parse((await orbit("bob", id)).text);
    expect(config.setup.agents[0].model).toBe("anthropic/claude-smart");
  });

  it("answers 409 model_not_resolvable when the pinned alias is not enabled for the team", async () => {
    const id = await published("bob", { model: "other" });
    const res = await orbit("bob", id);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("model_not_resolvable");
  });

  it("answers 409 when nothing is pinned and the team has no default", async () => {
    const id = await published("erin");
    expect((await orbit("erin", id)).status).toBe(409);
  });

  it("404s an unknown version and a malformed one", async () => {
    const id = await published("bob");
    expect((await orbit("bob", id, 9)).status).toBe(404);
    expect((await orbit("bob", id, 0)).status).toBe(400);
  });

  it("exports only published versions: a never-published agent and an unpublished draft give 404", async () => {
    const draftOnly = await as.bob.post("/v1/agents", {
      scope: "team",
      frontmatter: { name: "Draft only" },
      prompt: "Never published.",
    });
    const draftId = draftOnly.json.agent.id as string;
    expect((await orbit("bob", draftId)).status).toBe(404);

    const id = await published("bob");
    const edited = await as.bob.put(
      `/v1/agents/${id}`,
      { frontmatter: { name: "Edited" }, prompt: "Unpublished draft text." },
      ANY,
    );
    expect(edited.status).toBe(200);
    const next = await orbit("bob", id, 2);
    expect(next.status).toBe(404);
    expect(next.json.code).toBe("version_not_found");
    // v1 still exports as published, never the newer draft.
    const v1 = await orbit("bob", id, 1);
    expect(v1.status).toBe(200);
    expect(v1.text).toContain("You export.");
    expect(v1.text).not.toContain("Unpublished draft text.");
  });

  it("refuses members (403) and other teams (404)", async () => {
    const id = await published("bob");
    expect((await orbit("carol", id)).status).toBe(403);
    expect((await orbit("erin", id)).status).toBe(404);
  });

  it("is audited per export, in the team, with the version", async () => {
    const id = await published("bob");
    await orbit("bob", id);
    await orbit("alice", id);
    const { rows } = await h.admin.query(
      `SELECT team_id, target FROM audit_log WHERE action = 'agent.orbit_exported' AND target->>'agentId' = $1 ORDER BY seq`,
      [id],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      team_id: finance,
      target: { agentId: id, scope: "team", version: 1 },
    });
  });

  it("does not audit a failed export", async () => {
    const id = await published("bob", { model: "other" });
    await orbit("bob", id);
    const { rows } = await h.admin.query(
      `SELECT 1 FROM audit_log WHERE action = 'agent.orbit_exported' AND target->>'agentId' = $1`,
      [id],
    );
    expect(rows).toHaveLength(0);
  });
});

describe("MCP tools in the export (KOBE-112 ac-2)", () => {
  const SECRET_URL = "https://mcp.example.com/hook/secret-path-4711";

  async function withConnector(options: {
    exposure?: "read_only" | "all" | "custom";
    tools?: object;
  }) {
    const connector = await registerConnector(h.admin, { url: SECRET_URL, authKind: "api_key" });
    await enableConnector(h.admin, finance, connector.id, ids.alice, options.exposure ?? "all", []);
    const id = await published("bob", {
      connectors: [connector.name],
      ...(options.tools === undefined ? {} : { tools: options.tools }),
    });
    return { id, connector };
  }
  const toolsOf = async (id: string) =>
    (parse((await orbit("bob", id)).text).setup.agents[0].tools as string[]).filter((t) =>
      t.startsWith("mcp__"),
    );

  it("lists the exposed tools by their mcp__<server>__<tool> names, never URL or credential", async () => {
    const { id, connector } = await withConnector({});
    const res = await orbit("bob", id);
    expect(res.status, res.text).toBe(200);
    const config = orbitExperimentSchema.parse(parse(res.text));
    const mcp = config.setup.agents[0]?.tools.filter((t) => t.startsWith("mcp__"));
    expect(mcp).toEqual(
      ["get_issue", "create_issue", "delete_issue"].map((t) => piName(connector.name, t)).sort(),
    );
    expect(res.text).not.toContain("secret-path-4711");
    expect(res.text).not.toContain("mcp.example.com");
    expect(res.text).not.toMatch(/api_key|Bearer/i);
  });

  it("follows team exposure and the agent's own tool globs", async () => {
    const readOnly = await withConnector({ exposure: "read_only" });
    expect(await toolsOf(readOnly.id)).toEqual([piName(readOnly.connector.name, "get_issue")]);
    const allowed = await withConnector({ tools: { allow: ["mcp__*__get_*"] } });
    expect(await toolsOf(allowed.id)).toEqual([piName(allowed.connector.name, "get_issue")]);
  });

  it("a connector the team has not enabled adds no tools (and does not fail the export)", async () => {
    const connector = await registerConnector(h.admin);
    const id = await published("bob", { connectors: [connector.name] });
    expect(await toolsOf(id)).toEqual([]);
  });
});
