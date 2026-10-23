import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CAPABILITY_FILE_EDITS } from "@kobe/protocol";
import { createDb, type KobeDatabase } from "@kobe/db";
import { approvalKeyring } from "./approvals/index.js";
import { createPolicyEngine } from "./policy/engine.js";
import { createDbRuleSource, createDbSettingsSource } from "./policy/rule-store.js";
import { EventStreamFixture, must, type Person } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";

/**
 * KOBE-493: the server's `policy.check` never lets Pi `write`/`edit` change the file the run's
 * member is viewing (`runs.viewing.path`, also set by Retry and regenerate): with `file_edits`
 * the call is denied with an actionable error (recorded as the call's decision); without it the
 * member is asked, in every mode, Dangerous included; nobody to ask means a deny.
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const listeners: Awaited<ReturnType<typeof sandboxListener>>[] = [];
const sandboxes: FakeSandbox[] = [];
const extraDbs: KobeDatabase[] = [];
const KEY = approvalKeyring("approval-key-for-tests-".padEnd(48, "v"));
const VIEWED = "notes/plan.md";
const REFUSAL =
  "The user is viewing notes/plan.md. Propose the change with propose_file_edit instead; nothing was written.";

beforeAll(async () => {
  await fx.setup([{}], () => {
    const database = createDb(fx.database.appUrl);
    extraDbs.push(database);
    return {
      approvalKeys: KEY,
      approvals: { pollMs: 100 },
      sandboxWire: {
        sweep: false,
        engine: createPolicyEngine({
          rules: createDbRuleSource(database.db),
          settings: createDbSettingsSource(database.db, 0),
        }),
        tuning: { batchWindowMs: 20, resultPollMs: 200 },
      },
    };
  });
  listeners.push(await sandboxListener(fx.replica(0).deps, auth));
});

afterAll(async () => {
  for (const s of sandboxes) s.close();
  for (const l of listeners) await l.close();
  await fx.teardown();
  for (const d of extraDbs) await d.close();
});

interface World {
  readonly team: string;
  readonly owner: Person;
  readonly runId: string;
  readonly threadId: string;
  readonly sb: FakeSandbox;
}

/** A running `ask-on-write` run viewing {@link VIEWED}, on a sandbox with `capabilities`. */
async function world(capabilities: readonly string[]): Promise<World> {
  const owner = await fx.person(`v${randomBytes(2).toString("hex")}`);
  const team = await fx.team(`vf-${randomBytes(3).toString("hex")}`, owner);
  const runId = await fx.run(team, owner);
  const viewing = {
    path: VIEWED,
    sha256: "a".repeat(64),
    size: 3,
    content: "abc",
    truncated: false,
  };
  await fx.admin.query(
    `UPDATE runs SET approval_mode = 'ask-on-write', viewing = $2::jsonb WHERE id = $1`,
    [runId, JSON.stringify(viewing)],
  );
  const { rows } = await fx.admin.query<{ thread_id: string }>(
    `SELECT thread_id FROM runs WHERE id = $1`,
    [runId],
  );
  const threadId = must(rows[0], "run").thread_id;
  const sandboxId = randomUUID();
  const token = auth.issue({ sandboxId, teamId: team, userId: owner.id });
  const sb = await FakeSandbox.connect(must(listeners[0], "listener").url, token);
  if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
  sandboxes.push(sb);
  sb.hello(sandboxId, [], "1.0.0", capabilities);
  await sb.ready();
  const started = await fx
    .replica(0)
    .deps.sandboxWire.router.startRun(
      { teamId: team, userId: owner.id },
      { runId, threadId, message: "hello" },
    );
  expect(started).toEqual({ ok: true });
  return { team, owner, runId, threadId, sb };
}

let nextRequest = 0;
function check(w: World, tool: string, input: Record<string, unknown>) {
  const requestId = `r${(nextRequest += 1)}`;
  w.sb.send({
    v: 1,
    type: "policy.check",
    request_id: requestId,
    run_id: w.runId,
    thread_id: w.threadId,
    tool_call_id: `call-${requestId}`,
    tool,
    input,
  });
  return {
    result: () =>
      w.sb.until(() => w.sb.frames("policy.result").find((f) => f.request_id === requestId)),
    pending: () =>
      w.sb.until(() => w.sb.frames("policy.pending").find((f) => f.request_id === requestId)),
  };
}

async function deniedEvents(w: World) {
  const { rows } = await fx.admin.query<{ payload: { reasons: { message: string }[] } }>(
    `SELECT payload FROM run_events WHERE run_id = $1 AND type = 'policy.denied' ORDER BY seq`,
    [w.runId],
  );
  return rows.map((r) => r.payload.reasons[0]?.message);
}

async function pendingReasons(w: World) {
  const { rows } = await fx.admin.query<{ reasons: { code: string; message: string }[] }>(
    `SELECT reasons FROM approvals WHERE run_id = $1 ORDER BY created_at`,
    [w.runId],
  );
  return rows.map((r) => r.reasons[0]);
}

async function pinDangerous(w: World): Promise<void> {
  await pinAgent(w, { approval_mode: "dangerous", tools: { allow: ["write", "edit"] } });
}

/** Creates and publishes a team agent with `frontmatter`, pinned to the world's run. */
async function pinAgent(w: World, frontmatter: Record<string, unknown>): Promise<void> {
  const created = await w.owner.browser.post("/v1/agents", {
    scope: "team",
    frontmatter: {
      name: `Agent ${randomBytes(2).toString("hex")}`,
      ...frontmatter,
    },
    prompt: "Do it.",
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.agent.id as string;
  const published = await w.owner.browser.request(
    "POST",
    `/v1/agents/${id}/publish`,
    {},
    { "if-match": "*" },
  );
  expect(published.status, JSON.stringify(published.json)).toBe(201);
  await fx.admin.query(
    `UPDATE threads SET agent_scope = 'team', agent_id = $2, agent_version = 1 WHERE id = $1`,
    [w.threadId, id],
  );
  await fx.admin.query(`UPDATE runs SET agent_version = 1 WHERE id = $1`, [w.runId]);
}

describe("the viewed-file guard (KOBE-493)", () => {
  it("ac-1: with file_edits, write and edit to the viewed file are refused, however it is named", async () => {
    const w = await world([CAPABILITY_FILE_EDITS]);
    for (const [tool, input] of [
      ["write", { path: VIEWED, content: "x" }],
      ["write", { path: `/workspace/${VIEWED}`, content: "x" }],
      ["edit", { path: `./notes/../${VIEWED}`, edits: [{ oldText: "a", newText: "b" }] }],
    ] as const) {
      const result = await check(w, tool, input).result();
      expect(result.decision, JSON.stringify(input)).toBe("deny");
      expect(result).toMatchObject({ message: REFUSAL });
      expect(result.reasons[0]).toMatchObject({ code: "viewed_file", message: REFUSAL });
    }
    expect(w.sb.frames("policy.pending")).toHaveLength(0);
    // Recorded as the call's decision (existing path): one policy.denied per call.
    expect(await deniedEvents(w)).toEqual([REFUSAL, REFUSAL, REFUSAL]);
  });

  it("ac-3: other files, a different case, propose_file_edit and open_file are unaffected", async () => {
    const w = await world([CAPABILITY_FILE_EDITS]);
    expect(
      (await check(w, "write", { path: "notes/other.md", content: "x" }).result()).decision,
    ).toBe("allow");
    expect(
      (await check(w, "write", { path: "Notes/Plan.md", content: "x" }).result()).decision,
    ).toBe("allow");
    const proposed = await check(w, "propose_file_edit", {
      path: VIEWED,
      content: "new",
      summary: "Tighten",
    }).result();
    expect(proposed.decision).toBe("allow");
    expect((await check(w, "open_file", { path: VIEWED }).result()).decision).toBe("allow");
  });

  it("ac-1: in Dangerous mode too", async () => {
    const w = await world([CAPABILITY_FILE_EDITS]);
    await pinDangerous(w);
    const result = await check(w, "write", { path: VIEWED, content: "x" }).result();
    expect(result.decision).toBe("deny");
    expect(result.reasons[0]?.message).toBe(REFUSAL);
  });

  it("ac-2: without file_edits the member is asked, in ask-on-write and in Dangerous mode", async () => {
    const w = await world([]);
    await check(w, "write", { path: VIEWED, content: "x" }).pending();
    const dangerous = await world([]);
    await pinDangerous(dangerous);
    await check(dangerous, "edit", { path: VIEWED, edits: [] }).pending();
    for (const reason of [...(await pendingReasons(w)), ...(await pendingReasons(dangerous))]) {
      expect(reason).toMatchObject({ code: "viewed_file" });
      expect(reason?.message).toContain("The user is viewing notes/plan.md");
    }
    // Other files still run as before (sandbox writes don't ask in ask-on-write).
    expect((await check(w, "write", { path: "a.md", content: "x" }).result()).decision).toBe(
      "allow",
    );
  });

  it("ac-2: without file_edits, nobody to ask (auto mode) means a deny, never an allow", async () => {
    const w = await world([]);
    await fx.admin.query(`UPDATE runs SET approval_mode = 'auto' WHERE id = $1`, [w.runId]);
    await fx.admin.query(
      `INSERT INTO tool_rules (team_id, scope, effect, tool_glob, created_by)
       VALUES ($1, 'team', 'allow', 'write', $2)`,
      [w.team, w.owner.id],
    );
    const result = await check(w, "write", { path: VIEWED, content: "x" }).result();
    expect(result.decision).toBe("deny");
    expect(result.reasons.map((r) => r.code)).toEqual(["mode_auto_not_allowlisted", "viewed_file"]);
    expect((await check(w, "write", { path: "a.md", content: "x" }).result()).decision).toBe(
      "allow",
    );
  });

  it("does nothing for a run that views no file", async () => {
    const w = await world([CAPABILITY_FILE_EDITS]);
    await fx.admin.query(`UPDATE runs SET viewing = NULL WHERE id = $1`, [w.runId]);
    expect((await check(w, "write", { path: VIEWED, content: "x" }).result()).decision).toBe(
      "allow",
    );
  });

  it("asks instead of pointing at propose_file_edit when the agent's tools.deny removes it", async () => {
    const w = await world([CAPABILITY_FILE_EDITS]);
    await pinAgent(w, { tools: { deny: ["propose_file_edit"] } });
    await check(w, "write", { path: VIEWED, content: "x" }).pending();
    expect(await pendingReasons(w)).toEqual([
      expect.objectContaining({ code: "viewed_file", stage: "ask_rule" }),
    ]);
    expect(await deniedEvents(w)).toEqual([]);
  });

  it("its approval offers no remember, refuses one, and is not approved in bulk", async () => {
    const w = await world([]);
    const first = await check(w, "write", { path: VIEWED, content: "x" }).pending();
    await check(w, "edit", { path: VIEWED, edits: [] }).pending();
    const options = await w.owner.browser.get(`/v1/approvals/${first.approval_id}/remember`);
    expect(options.status, JSON.stringify(options.json)).toBe(200);
    expect(options.json).toMatchObject({
      can_remember: false,
      reason:
        "The user is viewing this file, so an approval to change it directly is never remembered.",
      choices: [],
      approve_all: null,
    });
    const remembered = await w.owner.browser.post(`/v1/approvals/${first.approval_id}`, {
      decision: "allow",
      remember: { tool_glob: "write", scope: "day" },
    });
    expect(remembered).toMatchObject({ status: 403, json: { code: "remember_not_allowed" } });
    expect(JSON.stringify(remembered.json)).toContain("The user is viewing this file");
    const allowed = await w.owner.browser.post(`/v1/approvals/${first.approval_id}`, {
      decision: "allow",
    });
    expect(allowed.status, JSON.stringify(allowed.json)).toBe(200);
  });
});
