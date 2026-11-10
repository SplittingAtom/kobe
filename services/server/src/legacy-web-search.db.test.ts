import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LEGACY_WEB_SEARCH_MESSAGE } from "@kobe/protocol";
import { EventStreamFixture } from "./testing/event-stream-fixture.js";
import { FakeSandbox, FakeSandboxAuth, isFake, sandboxListener } from "./testing/fake-sandbox.js";

/**
 * KOBE-606 removed the built-in web search. A sandbox image from before it still announces the
 * `web_search` capability and may call the tool: the policy denies `web_search` as an unknown tool,
 * and a `web_search.query` frame that arrives anyway is answered unavailable, with the connection
 * kept (no crash, no close).
 */
const fx = new EventStreamFixture();
const auth = new FakeSandboxAuth();
const sandboxes: FakeSandbox[] = [];
let listener: Awaited<ReturnType<typeof sandboxListener>>;

beforeAll(async () => {
  await fx.setup([{}], () => ({
    sandboxWire: {
      sweep: false,
      tuning: { batchWindowMs: 20, resultPollMs: 200, lostGraceMs: 0, helloTimeoutMs: 1_000 },
    },
  }));
  listener = await sandboxListener(fx.replica(0).deps, auth);
});
afterAll(async () => {
  for (const s of sandboxes) s.close();
  await listener.close();
  await fx.teardown();
});

describe("a legacy agent's web_search (KOBE-606)", () => {
  it("is denied by policy, and a query frame is answered unavailable on a live connection", async () => {
    const owner = await fx.person(`u${randomBytes(2).toString("hex")}`);
    const team = await fx.team(`lw-${randomBytes(3).toString("hex")}`, owner);
    const runId = await fx.run(team, owner);
    const { rows } = await fx.admin.query<{ thread_id: string }>(
      `SELECT thread_id FROM runs WHERE team_id = $1 AND id = $2`,
      [team, runId],
    );
    const threadId = rows[0]?.thread_id ?? "";
    const sandboxId = randomUUID();
    const sb = await FakeSandbox.connect(
      listener.url,
      auth.issue({ sandboxId, teamId: team, userId: owner.id }),
    );
    if (!isFake(sb)) throw new Error(`upgrade refused: ${sb.status}`);
    sandboxes.push(sb);
    sb.hello(sandboxId, [], undefined, ["artifacts", "web_search"]);
    await sb.ready();
    const started = await fx
      .replica(0)
      .deps.sandboxWire.router.startRun(
        { teamId: team, userId: owner.id },
        { runId, threadId, message: "hi" },
      );
    expect(started).toEqual({ ok: true });

    const ids = { run_id: runId, thread_id: threadId, tool_call_id: "c1", tool: "web_search" };
    sb.send({ v: 1, type: "policy.check", request_id: "p1", ...ids, input: { query: "kobe" } });
    const decision = await sb.until(
      () => sb.frames("policy.result").find((r) => r.request_id === "p1"),
      3000,
    );
    expect(decision.decision).toBe("deny");

    for (const request_id of ["s1", "s2"]) {
      sb.send({ v: 1, type: "web_search.query", request_id, ...ids, input: { query: "kobe" } });
      const answer = await sb.until(
        () => sb.frames("web_search.result").find((r) => r.request_id === request_id),
        3000,
      );
      expect(answer).toMatchObject({
        ok: true,
        available: false,
        reason: "not_configured",
        message: LEGACY_WEB_SEARCH_MESSAGE,
      });
    }
  });
});
