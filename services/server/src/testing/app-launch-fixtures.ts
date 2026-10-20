import { expect } from "vitest";
import { appIdOf } from "../apps/app-id.js";
import { enableConnector, registerConnector } from "./mcp-fixtures.js";
import type { RunFixture, RunWorld } from "./run-fixture.js";

/**
 * Fixtures of the KOBE-458 tests (a rail launch's new-thread agent, an agentless thread taking an
 * agent): a team default model, a pinned app on its own connector, published agents, reads.
 */
type Person = RunWorld["owner"];

/** The team's default model, so a run with an agent that pins none can start. */
export async function teamModel(f: RunFixture, w: RunWorld): Promise<void> {
  const admin = f.fx.admin;
  await admin.query(
    `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
     VALUES ('openai', 'openai', 'openai', 'v2.test.sealed-provider-key', $1) ON CONFLICT (id) DO NOTHING`,
    [w.owner.id],
  );
  await admin.query(
    `INSERT INTO model_catalog (alias, provider_id, model, created_by)
     VALUES ('fast', 'openai', 'fast-fake', $1) ON CONFLICT (alias) DO NOTHING`,
    [w.owner.id],
  );
  await admin.query(
    `INSERT INTO team_models (team_id, alias, is_default, enabled_by) VALUES ($1, 'fast', true, $2)`,
    [w.team, w.owner.id],
  );
}

/** A connector with one app (`open_picker`, template pinned and approved), enabled for the team. */
export async function pinnedApp(f: RunFixture, w: RunWorld, uri = "ui://c/picker") {
  const sha = "a".repeat(64);
  const connector = await registerConnector(f.fx.admin, {
    tools: [{ name: "open_picker", readOnly: true, ui: { resource_uri: uri } }],
  });
  await enableConnector(f.fx.admin, w.team, connector.id, w.owner.id, "all");
  await f.fx.admin.query(
    `INSERT INTO connector_ui_resources
       (connector_id, uri, mime_type, html, sha256, pinned_hash, status, approved)
     VALUES ($1, $2, 'text/html;profile=mcp-app', '<p>x</p>', $3, $3, 'pinned', true)`,
    [connector.id, uri, sha],
  );
  return { connector, appId: appIdOf(connector.id, uri) };
}

/** A published agent of `who` (team or personal scope); its id. */
export async function publishedAgent(
  who: Person,
  scope: "team" | "personal",
  name: string,
  publish = true,
): Promise<string> {
  const created = await who.browser.post("/v1/agents", {
    scope,
    frontmatter: { name, connectors: "all" },
    prompt: `You are ${name}.`,
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  if (publish) {
    const pub = await who.browser.request(
      "POST",
      `/v1/agents/${id}/publish`,
      {},
      { "if-match": "*" },
    );
    expect(pub.status, JSON.stringify(pub.json)).toBe(201);
  }
  return id;
}

export async function threadAgent(f: RunFixture, threadId: string) {
  const { rows } = await f.fx.admin.query<{
    agent_id: string | null;
    agent_scope: string | null;
    agent_version: number | null;
  }>(`SELECT agent_id, agent_scope, agent_version FROM threads WHERE id = $1`, [threadId]);
  return rows[0];
}

/** The connectors of a run's `run.start.mcp` (KOBE-451 `runs.mcp_connector_ids`). */
export async function runConnectors(f: RunFixture, runId: string): Promise<string[] | null> {
  const { rows } = await f.fx.admin.query<{ ids: string[] | null }>(
    `SELECT mcp_connector_ids AS ids FROM runs WHERE id = $1`,
    [runId],
  );
  return rows[0]?.ids ?? null;
}
