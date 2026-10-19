import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { appIdOf } from "./apps/app-id.js";
import { claimAppResultsInTx } from "./apps/claim.js";
import { approvalKeyring } from "./approvals/index.js";
import { inputDigest } from "./mcp/decide.js";
import { createInternalApp } from "./routes/internal.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { strFromU8, unzipSync } from "fflate";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import {
  INTERNAL_KEY,
  MCP_SESSION_KEY,
  enableConnector,
  leaseRun,
  mcpToken,
  piName,
  registerConnector,
} from "./testing/mcp-fixtures.js";

/**
 * KOBE-438 (MA-9, spec MA10): a model call to a UI tool gets a capture ticket; mcp-proxy's report
 * of the upstream's full result is stored (and nothing a sandbox or a forged ticket sends is); the
 * run's tool.result claims it and carries the server's `app` marker; each viewer sees the app or
 * the text card with its reason; a reload reads the stored result; quota and size give text; a
 * fork copies the results; an export carries none of it.
 */
const fx = new EventStreamFixture();
const objects = new MemoryObjects();
const blobs = { objects, prefix: "kobe/" };
const live = new Set<string>();
let internal: ReturnType<typeof createInternalApp>;
const URI = "ui://c/explorer";
const HTML = "<!doctype html><p>explorer</p>";
const TEMPLATE_SHA = "e".repeat(64);
type Body = Record<string, any>;

beforeAll(async () => {
  await fx.setup([{}], () => ({
    sandboxWire: { sweep: false },
    approvalKeys: approvalKeyring("a".repeat(48)),
    blobs,
  }));
  const deps = fx.replica(0).deps;
  internal = createInternalApp({
    internalKey: INTERNAL_KEY,
    mcp: deps.mcp,
    appResults: deps.appResults,
    auth: {
      db: fx.db,
      sessionKey: MCP_SESSION_KEY,
      liveness: { isLive: ({ sandboxId }) => Promise.resolve(live.has(sandboxId)) },
    },
  });
});
afterAll(() => fx.teardown());

async function world() {
  const owner = await fx.person(`o${randomUUID().slice(0, 4)}`);
  const member = await fx.person(`m${randomUUID().slice(0, 4)}`);
  const team = await fx.team(`apps-${randomUUID().slice(0, 6)}`, owner, [member]);
  const sandboxId = randomUUID();
  live.add(sandboxId);
  const runId = await fx.run(team, owner);
  const threadId = await leaseRun(fx.admin, team, runId, owner.id, sandboxId);
  const connector = await registerConnector(fx.admin, {
    tools: [
      { name: "open_explorer", readOnly: true, ui: { resource_uri: URI } },
      { name: "get_issue", readOnly: true },
    ],
  });
  await enableConnector(fx.admin, team, connector.id, owner.id, "all");
  await fx.admin.query(
    `INSERT INTO connector_ui_resources
       (connector_id, uri, mime_type, html, sha256, pinned_hash, status, approved)
     VALUES ($1, $2, 'text/html;profile=mcp-app', $3, $4, $4, 'pinned', true)`,
    [connector.id, URI, HTML, TEMPLATE_SHA],
  );
  const token = mcpToken({ sandboxId, teamId: team, userId: owner.id });
  return { team, owner, member, connector, token, threadId, runId, sandboxId };
}
type World = Awaited<ReturnType<typeof world>>;

async function post(path: string, body: unknown, token: string, key = INTERNAL_KEY) {
  const res = await internal.request(`/internal/v1/mcp${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      "kobe-sandbox-token": token,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Body };
}
const ARGS = { q: "tables" };
const decide = (w: World, tool = "open_explorer") =>
  post(
    `/connectors/${w.connector.id}/calls`,
    { tool, thread_id: w.threadId, arguments: ARGS },
    w.token,
  );
const report = (
  w: World,
  ticket: string,
  result: unknown,
  token = w.token,
  input: unknown = ARGS,
) => post(`/connectors/${w.connector.id}/results`, { ticket, input, result }, token);

const RESULT = {
  content: [{ type: "text", text: "3 namespaces" }],
  structuredContent: { namespaces: ["a", "b", "c"] },
};

async function rows(team: string) {
  const { rows } = await fx.admin.query<Body>(
    `SELECT id, storage, tool_call_id, prompt_entry_id, result, bytes FROM thread_app_results
      WHERE team_id = $1 ORDER BY created_at`,
    [team],
  );
  return rows;
}

/** The run's tool call and result, as the ingest hands them to the claim. */
async function claim(w: World, toolCallId: string, tool = "open_explorer", args: object = ARGS) {
  return withTeam(fx.db, w.team, (tx) =>
    claimAppResultsInTx(tx, w.team, w.runId, [
      {
        type: "tool.call",
        payload: {
          tool_call_id: toolCallId,
          tool: piName(w.connector.name, tool),
          input: args,
          risk: "read",
        },
      },
      {
        type: "tool.result",
        payload: {
          tool_call_id: toolCallId,
          tool: piName(w.connector.name, tool),
          is_error: false,
          preview: "3 namespaces",
          truncated: false,
        },
      },
    ]),
  );
}

async function captured(w: World): Promise<string> {
  const allowed = await decide(w);
  expect(allowed.json).toMatchObject({
    decision: "allow",
    app_capture: { ticket: expect.any(String) },
  });
  const stored = await report(w, allowed.json.app_capture.ticket as string, RESULT);
  expect(stored).toEqual({ status: 201, json: { storage: "inline" } });
  return allowed.json.app_capture.ticket as string;
}

const views = (p: Person, threadId: string) => p.browser.get(`/v1/threads/${threadId}/app-results`);

describe("capture (ac-1)", () => {
  it("gives a UI tool's allow a ticket (and no other tool's), and stores the reported result", async () => {
    const w = await world();
    expect((await decide(w, "get_issue")).json.app_capture).toBeUndefined();
    await captured(w);
    expect(await rows(w.team)).toEqual([
      expect.objectContaining({ storage: "inline", tool_call_id: null, result: RESULT }),
    ]);
  });

  it("stores nothing a sandbox or a forged or foreign ticket sends", async () => {
    const w = await world();
    const ticket = (await decide(w)).json.app_capture.ticket as string;
    // The sandbox has its token but not the internal key.
    expect(
      (
        await post(
          `/connectors/${w.connector.id}/results`,
          { ticket, input: ARGS, result: RESULT },
          w.token,
          "x".repeat(40),
        )
      ).status,
    ).toBe(401);
    // A changed ticket, another sandbox's token, another connector.
    const [body, mac] = ticket.split(".") as [string, string];
    expect((await report(w, `${body}x.${mac}`, RESULT)).status).toBe(403);
    const other = randomUUID();
    live.add(other);
    const otherToken = mcpToken({ sandboxId: other, teamId: w.team, userId: w.owner.id });
    expect((await report(w, ticket, RESULT, otherToken)).status).toBe(403);
    expect(
      (
        await post(
          `/connectors/${randomUUID()}/results`,
          { ticket, input: ARGS, result: RESULT },
          w.token,
        )
      ).status,
    ).toBe(403);
    // An input other than the one the ticket was issued for.
    expect((await report(w, ticket, RESULT, w.token, { q: "other" })).status).toBe(403);
    // An error result is never stored.
    expect((await report(w, ticket, { ...RESULT, isError: true })).status).toBe(403);
    expect(await rows(w.team)).toEqual([]);
  });

  it("keeps a result over 256 KiB in the thread's own S3 tree, and reads it back", async () => {
    const w = await world();
    const big = { content: [{ type: "text", text: "x".repeat(300 * 1024) }] };
    const ticket = (await decide(w)).json.app_capture.ticket as string;
    expect((await report(w, ticket, big)).json).toEqual({ storage: "blob" });
    const { rows: stored } = await fx.admin.query<{ blob_ref: string }>(
      `SELECT blob_ref FROM thread_app_results WHERE team_id = $1`,
      [w.team],
    );
    const key = must(stored[0], "row").blob_ref;
    expect(key.startsWith(`kobe/teams/${w.team}/threads/${w.threadId}/apps/`)).toBe(true);
    expect(objects.objects.has(key)).toBe(true);
    // Not queued for deletion once its row committed.
    const { rows: queued } = await fx.admin.query(
      `SELECT 1 FROM retention_blob_deletions WHERE team_id = $1 AND key = $2`,
      [w.team, key],
    );
    expect(queued).toEqual([]);
    await claim(w, "tc1");
    const [view] = (await views(w.owner, w.threadId)).json.results as Body[];
    const read = await w.owner.browser.get(
      `/v1/threads/${w.threadId}/app-results/${view?.result_ref}`,
    );
    expect(read.json).toEqual({ input: ARGS, result: big });
  });

  it("keeps text only for a result over 4 MiB, and over the team's quota", async () => {
    const w = await world();
    const huge = { content: [{ type: "text", text: "x".repeat(4 * 1024 * 1024 + 1) }] };
    const ticket = (await decide(w)).json.app_capture.ticket as string;
    expect((await report(w, ticket, huge)).json).toEqual({ storage: "too_large" });
    await fx.admin.query(
      `INSERT INTO team_storage_quotas (team_id, max_bytes, updated_by) VALUES ($1, 10, $2)
       ON CONFLICT (team_id) DO UPDATE SET max_bytes = 10`,
      [w.team, w.owner.id],
    );
    expect((await report(w, ticket, RESULT)).json).toEqual({ storage: "too_large" });
    expect((await rows(w.team)).map((r) => r.result)).toEqual([null, null]);
  });

  it("refuses a report once the run has ended", async () => {
    const w = await world();
    const ticket = (await decide(w)).json.app_capture.ticket as string;
    await fx.complete(w.team, w.runId);
    expect((await report(w, ticket, RESULT)).status).toBe(409);
  });
});

describe("claim, views and reads (ac-2, ac-3, ac-4)", () => {
  it("claims the stored result for the run's tool.result and marks it", async () => {
    const w = await world();
    await captured(w);
    await fx.admin.query(`UPDATE runs SET user_entry_id = 'e1' WHERE id = $1`, [w.runId]);
    // Another tool, or other input, is not this result.
    const unrelated = await claim(w, "tc0", "open_explorer", { q: "other" });
    expect((unrelated[1]?.payload as Body).app).toBeUndefined();
    const marked = await claim(w, "tc1");
    const [row] = await rows(w.team);
    expect((marked[1]?.payload as Body).app).toEqual({
      connector_id: w.connector.id,
      app_id: appIdOf(w.connector.id, URI),
      template_sha256: TEMPLATE_SHA,
      result_ref: must(row, "row").id,
    });
    expect(row).toMatchObject({ tool_call_id: "tc1", prompt_entry_id: "e1" });
    // Claimed once: a second result for the same call gets no marker.
    expect(((await claim(w, "tc1"))[1]?.payload as Body).app).toBeUndefined();
    expect(inputDigest(ARGS)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("shows the owner the app and its stored result; a reload reads only Postgres", async () => {
    const w = await world();
    await captured(w);
    await claim(w, "tc1");
    const list = await views(w.owner, w.threadId);
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    const [view] = list.json.results as Body[];
    expect(view).toMatchObject({
      tool_call_id: "tc1",
      view: "app",
      app_id: appIdOf(w.connector.id, URI),
      template_sha256: TEMPLATE_SHA,
      app: { title: "open_explorer" },
    });
    const read = await w.owner.browser.get(
      `/v1/threads/${w.threadId}/app-results/${view?.result_ref}`,
    );
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toMatch(/^application\/json/);
    expect(read.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(read.json).toEqual({ input: ARGS, result: RESULT });
  });

  it("gives text with the right reason: drift, visibility, no access, a reader without the thread", async () => {
    const w = await world();
    await captured(w);
    await claim(w, "tc1");
    const reason = async (p: Person) => ((await views(p, w.threadId)).json.results as Body[])[0];
    // The member cannot see a private thread at all; shared, they act as themselves (T12).
    expect((await views(w.member, w.threadId)).status).toBe(404);
    await fx.admin.query(`UPDATE threads SET shared_to_team = true WHERE id = $1`, [w.threadId]);
    expect(await reason(w.member)).toMatchObject({ view: "app" });

    await fx.admin.query(
      `UPDATE connectors SET tools_snapshot = jsonb_set(tools_snapshot, '{0,ui,visibility}', '["model"]')
        WHERE id = $1`,
      [w.connector.id],
    );
    expect(await reason(w.owner)).toMatchObject({ view: "text", reason: "not_app_visible" });
    await fx.admin.query(
      `UPDATE connectors SET tools_snapshot = jsonb_set(tools_snapshot, '{0,ui}', $2::jsonb) WHERE id = $1`,
      [w.connector.id, JSON.stringify({ resource_uri: URI })],
    );
    expect(await reason(w.owner)).toMatchObject({ view: "app" });

    await fx.admin.query(`DELETE FROM team_connectors WHERE connector_id = $1`, [w.connector.id]);
    const gone = await reason(w.member);
    expect(gone).toMatchObject({ view: "text", reason: "no_access" });
    expect(
      (await w.member.browser.get(`/v1/threads/${w.threadId}/app-results/${gone?.result_ref}`))
        .status,
    ).toBe(409);
    await enableConnector(fx.admin, w.team, w.connector.id, w.owner.id, "all");

    await fx.admin.query(
      `UPDATE connector_ui_resources SET status = 'drifted' WHERE connector_id = $1`,
      [w.connector.id],
    );
    expect(await reason(w.owner)).toMatchObject({ view: "text", reason: "template_changed" });
  });

  it("copies results into a fork, placed by prompt entry and tool call", async () => {
    const w = await world();
    await captured(w);
    await fx.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
       VALUES ($1, $2, 'e1', NULL, 'message', $3)`,
      [w.team, w.threadId, JSON.stringify({ message: { role: "user", content: "open it" } })],
    );
    await fx.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
       VALUES ($1, $2, 'e2', 'e1', 'message', $3)`,
      [
        w.team,
        w.threadId,
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "tc1", name: "x", arguments: ARGS }],
          },
        }),
      ],
    );
    await fx.admin.query(`UPDATE threads SET leaf_entry_id = 'e2' WHERE id = $1`, [w.threadId]);
    await fx.admin.query(`UPDATE runs SET user_entry_id = 'e1' WHERE id = $1`, [w.runId]);
    await claim(w, "tc1");
    const forked = await w.owner.browser.post(`/v1/threads/${w.threadId}/fork`, {});
    expect(forked.status, JSON.stringify(forked.json)).toBe(201);
    const fork = forked.json.thread_id as string;
    const [copy] = (await views(w.owner, fork)).json.results as Body[];
    expect(copy).toMatchObject({
      tool_call_id: "tc1",
      user_entry_id: "e1",
      run_id: null,
      view: "app",
    });
    const read = await w.owner.browser.get(`/v1/threads/${fork}/app-results/${copy?.result_ref}`);
    expect(read.json).toEqual({ input: ARGS, result: RESULT });
  });

  it("copies a stored blob into the fork's own tree", async () => {
    const w = await world();
    const big = { content: [{ type: "text", text: "y".repeat(300 * 1024) }] };
    const ticket = (await decide(w)).json.app_capture.ticket as string;
    expect((await report(w, ticket, big)).json).toEqual({ storage: "blob" });
    await fx.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
       VALUES ($1, $2, 'e1', NULL, 'message', $3)`,
      [w.team, w.threadId, JSON.stringify({ message: { role: "user", content: "open it" } })],
    );
    await fx.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
       VALUES ($1, $2, 'e2', 'e1', 'message', $3)`,
      [
        w.team,
        w.threadId,
        JSON.stringify({
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "tc1", name: "x", arguments: ARGS }],
          },
        }),
      ],
    );
    await fx.admin.query(`UPDATE threads SET leaf_entry_id = 'e2' WHERE id = $1`, [w.threadId]);
    await fx.admin.query(`UPDATE runs SET user_entry_id = 'e1' WHERE id = $1`, [w.runId]);
    await claim(w, "tc1");
    const fork = (await w.owner.browser.post(`/v1/threads/${w.threadId}/fork`, {})).json
      .thread_id as string;
    const { rows: copies } = await fx.admin.query<{ blob_ref: string }>(
      `SELECT blob_ref FROM thread_app_results WHERE thread_id = $1`,
      [fork],
    );
    expect(
      must(copies[0], "copy").blob_ref.startsWith(`kobe/teams/${w.team}/threads/${fork}/apps/`),
    ).toBe(true);
    const [copy] = (await views(w.owner, fork)).json.results as Body[];
    expect(
      (await w.owner.browser.get(`/v1/threads/${fork}/app-results/${copy?.result_ref}`)).json,
    ).toEqual({ input: ARGS, result: big });
  });

  it("exports text only: never the structured result or the template", async () => {
    const w = await world();
    await captured(w);
    await claim(w, "tc1");
    const b = w.owner.browser;
    const res = await fx
      .replica(0)
      .app.request(`http://kobe.test/v1/threads/export?team=${w.team}`, {
        headers: {
          origin: "http://kobe.test",
          "x-forwarded-for": b.ip,
          cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        },
      });
    expect(res.status).toBe(200);
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
    const all = Object.values(files)
      .map((f) => strFromU8(f))
      .join("\n");
    expect(all).not.toContain("namespaces");
    expect(all).not.toContain("explorer</p>");
  });
});

describe("review fixes (KOBE-438 review)", () => {
  it("claims nothing when two identical calls are pending (LOW-1)", async () => {
    const w = await world();
    const t1 = (await decide(w)).json.app_capture.ticket as string;
    const t2 = (await decide(w)).json.app_capture.ticket as string;
    await report(w, t1, RESULT);
    await report(w, t2, { ...RESULT, structuredContent: { other: true } });
    expect(((await claim(w, "tc1"))[1]?.payload as Body).app).toBeUndefined();
    expect((await rows(w.team)).every((r) => r.tool_call_id === null)).toBe(true);
  });

  it("drops a run's unclaimed results when the run ends (MEDIUM-1)", async () => {
    const w = await world();
    await captured(w);
    await fx.complete(w.team, w.runId);
    expect(await rows(w.team)).toEqual([]);
  });

  it("holds the cap under parallel reports (KOBE-439 review LOW-B)", async () => {
    const w = await world();
    const tickets: string[] = [];
    for (let i = 0; i < 25; i++) tickets.push((await decide(w)).json.app_capture.ticket as string);
    const answers = await Promise.all(tickets.map((t) => report(w, t, RESULT)));
    expect(answers.filter((a) => a.status === 201)).toHaveLength(20);
    expect(answers.filter((a) => a.status === 429)).toHaveLength(5);
    expect(await rows(w.team)).toHaveLength(20);
  });

  it("a store does not wait on a foreign-key check of its run (KOBE-439 re-review LOW-K)", async () => {
    const w = await world();
    const ticket = (await decide(w)).json.app_capture.ticket as string;
    // An event writer's open transaction: its foreign-key check holds FOR KEY SHARE on the run.
    const holder = new pg.Client({ connectionString: fx.database.adminUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM runs WHERE id = $1 FOR KEY SHARE", [w.runId]);
      const waited = new Promise<"blocked">((r) => setTimeout(() => r("blocked"), 3_000));
      const stored = report(w, ticket, RESULT).then((a) => a.status);
      expect(await Promise.race([stored, waited])).toBe(201);
    } finally {
      await holder.query("ROLLBACK");
      await holder.end();
    }
  });

  it("caps a run's unclaimed results (MEDIUM-1)", async () => {
    const w = await world();
    for (let i = 0; i < 20; i++) {
      const ticket = (await decide(w)).json.app_capture.ticket as string;
      expect((await report(w, ticket, RESULT)).status).toBe(201);
    }
    const ticket = (await decide(w)).json.app_capture.ticket as string;
    expect((await report(w, ticket, RESULT)).status).toBe(429);
  });

  it("does not copy a result into a fork at the prompt, before its tool call (LOW-7)", async () => {
    const w = await world();
    await captured(w);
    await fx.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
       VALUES ($1, $2, 'e1', NULL, 'message', $3)`,
      [w.team, w.threadId, JSON.stringify({ message: { role: "user", content: "open it" } })],
    );
    await fx.admin.query(`UPDATE threads SET leaf_entry_id = 'e1' WHERE id = $1`, [w.threadId]);
    await fx.admin.query(`UPDATE runs SET user_entry_id = 'e1' WHERE id = $1`, [w.runId]);
    await claim(w, "tc1");
    const fork = (await w.owner.browser.post(`/v1/threads/${w.threadId}/fork`, {})).json
      .thread_id as string;
    expect((await views(w.owner, fork)).json.results).toEqual([]);
  });

  it("counts app results in the audited purge and queues their blobs (LOW-6)", async () => {
    const w = await world();
    const big = { content: [{ type: "text", text: "z".repeat(300 * 1024) }] };
    const ticket = (await decide(w)).json.app_capture.ticket as string;
    expect((await report(w, ticket, big)).json).toEqual({ storage: "blob" });
    await claim(w, "tc1");
    const { rows: stored } = await fx.admin.query<{ blob_ref: string }>(
      `SELECT blob_ref FROM thread_app_results WHERE team_id = $1`,
      [w.team],
    );
    const key = must(stored[0], "row").blob_ref;
    await fx.complete(w.team, w.runId);
    await fx.admin.query(`UPDATE threads SET deleted_at = now() WHERE id = $1`, [w.threadId]);
    expect((await w.owner.browser.post(`/v1/threads/${w.threadId}/purge`)).status).toBe(204);
    const { rows: audit } = await fx.admin.query<{ target: Body }>(
      `SELECT target FROM audit_log WHERE team_id = $1 AND action = 'thread.purged'`,
      [w.team],
    );
    expect(audit[0]?.target).toMatchObject({ appResults: 1, blobs: 1 });
    const { rows: queued } = await fx.admin.query(
      `SELECT 1 FROM retention_blob_deletions WHERE team_id = $1 AND key = $2`,
      [w.team, key],
    );
    expect(queued).toHaveLength(1);
    expect(await rows(w.team)).toEqual([]);
  });
});
