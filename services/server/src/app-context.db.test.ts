import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appIdOf } from "./apps/app-id.js";
import { APP_CONTEXT_PREAMBLE, withAppContext } from "./apps/context-block.js";
import { enableConnector, registerConnector } from "./testing/mcp-fixtures.js";
import { RunFixture, type RunWorld } from "./testing/run-fixture.js";

/**
 * KOBE-439 (MA-7, spec §8): context chips go with the member's message. Each part must name an
 * app the member can open now, with the same approved template; the run's input (what Pi gets,
 * what its user entry, the history and exports keep) carries it fenced as untrusted data before
 * the member's text. Sizes are capped.
 */
const f = new RunFixture();
beforeAll(() => f.setup());
afterAll(() => f.teardown());

const URI = "ui://c/explorer";
const SHA = "e".repeat(64);

async function app(w: RunWorld) {
  const connector = await registerConnector(f.fx.admin, {
    tools: [{ name: "open_explorer", readOnly: true, ui: { resource_uri: URI } }],
  });
  await enableConnector(f.fx.admin, w.team, connector.id, w.owner.id, "all");
  await f.fx.admin.query(
    `INSERT INTO connector_ui_resources
       (connector_id, uri, mime_type, html, sha256, pinned_hash, status, approved)
     VALUES ($1, $2, 'text/html;profile=mcp-app', '<p>x</p>', $3, $3, 'pinned', true)`,
    [connector.id, URI, SHA],
  );
  return {
    connector,
    part: {
      connector_id: connector.id,
      app_id: appIdOf(connector.id, URI),
      template_sha256: SHA,
      data: { structuredContent: { table: "c.n.t" } },
    },
  };
}

describe("app context on a message (KOBE-439)", () => {
  it("reaches Pi fenced and marked untrusted, before the member's text (ac-3)", async () => {
    const w = await f.world();
    const { connector, part } = await app(w);
    const ws = await f.connect(w);
    const threadId = await f.thread(w.owner);
    const res = await f.send(w.owner, threadId, "Use this table", 0, { app_context: [part] });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const runId = res.json.run_id as string;
    const expected = withAppContext(
      [{ connectorName: connector.name, data: part.data }],
      "Use this table",
    );
    expect(expected.startsWith(APP_CONTEXT_PREAMBLE)).toBe(true);
    expect(expected).toContain(
      `<app-context source="connector:${connector.name}" untrusted="true">`,
    );
    expect((await f.run(w.team, runId)).input).toBe(expected);
    expect((await ws.started(runId)).message).toBe(expected);
  });

  it("refuses a part for an app the member cannot open, or another template", async () => {
    const w = await f.world();
    const { part } = await app(w);
    const threadId = await f.thread(w.owner);
    for (const bad of [
      { ...part, template_sha256: "f".repeat(64) },
      { ...part, app_id: "a".repeat(64) },
    ]) {
      const res = await f.send(w.owner, threadId, "x", 0, { app_context: [bad] });
      expect([res.status, res.json.code]).toEqual([422, "app_context_invalid"]);
    }
    await f.fx.admin.query(`DELETE FROM team_connectors WHERE team_id = $1`, [w.team]);
    const gone = await f.send(w.owner, threadId, "x", 0, { app_context: [part] });
    expect(gone.status).toBe(422);
  });

  it("caps each part at 8 KiB (ac-4)", async () => {
    const w = await f.world();
    const { part } = await app(w);
    const threadId = await f.thread(w.owner);
    const big = { ...part, data: { structuredContent: { x: "y".repeat(9 * 1024) } } };
    expect((await f.send(w.owner, threadId, "x", 0, { app_context: [big] })).status).toBe(400);
  });
});
