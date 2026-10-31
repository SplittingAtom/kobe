import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProbeResult } from "./connectors/probe.js";
import { refreshConnector } from "./connectors/refresh.js";
import type { TestBrowser } from "./testing/browser.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-531 (spec MA3 as amended 2026-10-31): a site admin sets where each pinned template's app
 * opens (`chat`, `artifacts`, `rail`). Site permission as for approval; 400 on an unknown value,
 * 404 on an unknown connector or template; audited as a site event; drift leaves it alone.
 */
const BASE = "/v1/site/connectors";
const MIME = "text/html;profile=mcp-app";
const team = randomUUID();

let h: Harness;
let root: TestBrowser;
let alice: TestBrowser;
let rootId = "";
const up = {
  tools: [] as Record<string, unknown>[],
  resources: [] as Record<string, unknown>[],
};

const appTool = (name: string, uri: string) => ({
  name,
  inputSchema: { type: "object" },
  _meta: { ui: { resourceUri: uri } },
});
const template = (uri: string, text: string) => ({ uri, mimeType: MIME, text, meta: {} });

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
  rootId = await h.createUser("root@placement.test", "admin");
  const aliceId = await h.createUser("alice@placement.test");
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'pl', 'pl')`, [team]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
    [team, aliceId],
  );
  root = await h.signIn("root@placement.test");
  alice = await h.signIn("alice@placement.test");
});
afterAll(async () => {
  await h?.close();
});

const placementOf = async (id: string, uri: string) =>
  (
    await h.admin.query<{ placement: string }>(
      `SELECT placement FROM connector_ui_resources WHERE connector_id = $1 AND uri = $2`,
      [id, uri],
    )
  ).rows[0]?.placement;

describe("template placement (KOBE-531)", () => {
  it("sets, validates, audits and survives drift", async () => {
    up.tools = [appTool("open", "ui://p/app")];
    up.resources = [template("ui://p/app", "v1")];
    const created = await root.post(BASE, { name: "place-a", url: "https://place-a.example/mcp" });
    const id = created.json.connector.id as string;
    const path = `${BASE}/${id}/templates/placement`;

    // The review shows each template's placement (default chat).
    const review = await root.get(`${BASE}/${id}/templates`);
    expect(review.json.templates).toMatchObject([{ uri: "ui://p/app", placement: "chat" }]);

    // Members cannot set it; bad values and unknown targets are refused.
    expect((await alice.put(path, { uri: "ui://p/app", placement: "rail" })).status).toBe(403);
    expect((await root.put(path, { uri: "ui://p/app", placement: "side" })).status).toBe(400);
    expect((await root.put(path, { uri: "ui://p/app" })).status).toBe(400);
    expect((await root.put(path, { uri: "ui://p/none", placement: "rail" })).status).toBe(404);
    expect(
      (
        await root.put(`${BASE}/${randomUUID()}/templates/placement`, {
          uri: "ui://p/app",
          placement: "rail",
        })
      ).status,
    ).toBe(404);
    expect((await root.put(`${BASE}/nope/templates/placement`, {})).status).toBe(404);
    expect(await placementOf(id, "ui://p/app")).toBe("chat");

    const set = await root.put(path, { uri: "ui://p/app", placement: "artifacts" });
    expect(set.status).toBe(200);
    expect(set.json).toEqual({ uri: "ui://p/app", placement: "artifacts" });
    expect(await placementOf(id, "ui://p/app")).toBe("artifacts");

    const audits = (
      await h.admin.query<{ actor_id: string; team_id: string | null; target: unknown }>(
        `SELECT actor_id, team_id, target FROM audit_log
          WHERE action = 'mcp.connector.template_placement_set' AND target->>'connectorId' = $1`,
        [id],
      )
    ).rows;
    expect(audits).toEqual([
      {
        actor_id: rootId,
        team_id: null,
        target: {
          connectorId: id,
          name: "place-a",
          uri: "ui://p/app",
          previous: "chat",
          placement: "artifacts",
        },
      },
    ]);

    // The same value again changes nothing and is not audited again.
    expect((await root.put(path, { uri: "ui://p/app", placement: "artifacts" })).status).toBe(200);
    const again = await h.admin.query(
      `SELECT 1 FROM audit_log
        WHERE action = 'mcp.connector.template_placement_set' AND target->>'connectorId' = $1`,
      [id],
    );
    expect(again.rowCount).toBe(1);

    // Not part of the pin: drift and re-approval leave it alone.
    up.resources = [template("ui://p/app", "v2")];
    expect(await refreshConnector(h.deps.database.db, h.deps.connectorProbe, id)).toMatchObject({
      status: "drifted",
    });
    expect(await placementOf(id, "ui://p/app")).toBe("artifacts");
    const drifted = await root.get(`${BASE}/${id}/templates`);
    const live = (drifted.json.templates as { live: { pinnedHash: string } }[])[0]?.live;
    const approved = await root.post(`${BASE}/${id}/templates/approve`, {
      templates: [{ uri: "ui://p/app", pinnedHash: live?.pinnedHash }],
    });
    expect(approved.status).toBe(200);
    expect(await placementOf(id, "ui://p/app")).toBe("artifacts");
  });
});
