import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CAPABILITY_THREAD_CONTEXT,
  THREAD_CONTEXT_MAX_BYTES,
  threadContextError,
  threadContextSchema,
  type ServerToSandboxFrame,
  type ThreadContextErrorCode,
} from "@kobe/protocol";
import { RunFixture, type FakeWorkspace, type RunWorld } from "./testing/run-fixture.js";
import type { TestResponse } from "./testing/browser.js";

/**
 * The context viewer's route (KOBE-470, docs/specs/context-viewer.md): `GET /v1/threads/{id}/context`
 * asks the owner's sandbox (`thread.context`) for the latest model call's context and returns it
 * validated. Owner only (a shared project reader is refused, other members get 404), a sandbox
 * that is not connected is woken (202), errors are fixed messages, and nothing stays in Postgres.
 */
const f = new RunFixture();

beforeAll(async () => {
  await f.setup();
});
afterAll(async () => {
  await f.teardown();
});

const ANSWER = {
  source: "model_call",
  captured_at: "2026-10-21T10:00:00.000Z",
  model: "openai/gpt-fake",
  context_window: 128_000,
  total_tokens: 30,
  tokens_basis: "usage",
  sections: [
    {
      kind: "system_prompt",
      label: "Pi's prompt",
      text: "You are Pi",
      tokens: 20,
      chars: 10,
      truncated: false,
    },
    {
      kind: "user_message",
      label: "User",
      text: "secret plans",
      tokens: 10,
      chars: 12,
      truncated: false,
    },
  ],
  truncated: false,
  omitted_sections: 0,
};

type ContextFrame = Extract<ServerToSandboxFrame, { type: "thread.context" }>;

/** Answers every `thread.context` with `answer(frame)` (a command.result body). */
function answerContext(ws: FakeWorkspace, answer: (f: ContextFrame) => object): void {
  const previous = ws.sb.respond;
  ws.sb.respond = (frame) => {
    if (frame.type !== "thread.context") return previous?.(frame);
    return { v: 1, type: "command.result", command_id: frame.command_id, ...answer(frame) };
  };
}

async function world(
  capabilities: readonly string[] = ["skill_bundles", CAPABILITY_THREAD_CONTEXT],
) {
  const w = await f.world(1);
  const ws = await f.connect(w, 0, capabilities);
  const threadId = await f.thread(w.owner);
  return { w, ws, threadId };
}

const read = (w: RunWorld, threadId: string, who = w.owner, replica = 1) =>
  f.on(replica, who).get(`/v1/threads/${threadId}/context`);

const expectError = (res: TestResponse, code: ThreadContextErrorCode, status: number) => {
  expect(res.status, JSON.stringify(res.json)).toBe(status);
  expect(res.json).toEqual(threadContextError(code));
};

const commandRows = async (team: string) =>
  (
    await f.fx.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sandbox_commands WHERE team_id = $1 AND kind = 'thread.context'`,
      [team],
    )
  ).rows[0]?.n;

describe("GET /v1/threads/{id}/context (KOBE-470)", () => {
  it("reads the owner's sandbox and returns the sections, stored nowhere", async () => {
    const { w, ws, threadId } = await world();
    answerContext(ws, () => ({ ok: true, data: ANSWER }));
    const res = await read(w, threadId);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(threadContextSchema.parse(res.json)).toEqual({ ...ANSWER, thread_id: threadId });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const [frame] = ws.sb.frames("thread.context") as ContextFrame[];
    expect(frame).toMatchObject({ thread_id: threadId, max_bytes: THREAD_CONTEXT_MAX_BYTES });
    // The command row (and its result) is gone once read; no run, no event, no audit.
    expect(await commandRows(w.team)).toBe("0");
    const runs = await f.fx.admin.query(`SELECT 1 FROM runs WHERE team_id = $1`, [w.team]);
    expect(runs.rowCount).toBe(0);
  });

  it("refuses a teammate the thread is shared with, and hides it from everyone else", async () => {
    const { w, ws, threadId } = await world();
    answerContext(ws, () => ({ ok: true, data: ANSWER }));
    const reader = w.others[0];
    if (!reader) throw new Error("no member");
    await f.fx.activate(reader, w.team);
    expect((await read(w, threadId, reader)).status).toBe(404);
    await f.fx.admin.query(
      `UPDATE threads SET shared_to_team = true WHERE team_id = $1 AND id = $2`,
      [w.team, threadId],
    );
    // The reader sees the shared thread (D23) but never its context.
    const shared = await f.on(1, reader).get(`/v1/threads/${threadId}`);
    expect(shared.status, JSON.stringify(shared.json)).toBe(200);
    expectError(await read(w, threadId, reader), "not_owner", 403);
    expect(ws.sb.frames("thread.context")).toEqual([]);
    expect((await read(w, randomUUID())).status).toBe(404);
  });

  it("wakes a sandbox that is not connected and says so (202)", async () => {
    const w = await f.world(0);
    const threadId = await f.thread(w.owner);
    const res = await read(w, threadId);
    expect(res.status, JSON.stringify(res.json)).toBe(202);
    expect(res.json).toEqual({ status: "waking", retry_after_ms: 2000 });
    expect(await commandRows(w.team)).toBe("0");
  });

  it("answers fixed errors: an older agent, a busy session, a failed or invalid read", async () => {
    const old = await world(["skill_bundles"]);
    expectError(await read(old.w, old.threadId), "context_unsupported", 409);

    const { w, ws, threadId } = await world();
    const answers: object[] = [
      { ok: false, error: { code: "pi_rejected", message: "the thread is compacting" } },
      { ok: false, error: { code: "internal", message: "ENOENT /workspace/.kobe/secret" } },
      { ok: true, data: { ...ANSWER, sections: [{ kind: "nope" }] } },
    ];
    answerContext(ws, () => answers.shift() ?? { ok: true, data: ANSWER });
    expectError(await read(w, threadId), "thread_busy", 409);
    expectError(await read(w, threadId), "context_unavailable", 502);
    expectError(await read(w, threadId), "context_unavailable", 502);
    expect((await read(w, threadId)).status).toBe(200);
    expect(await commandRows(w.team)).toBe("0");
  });

  it("restores the thread's session before asking (entry sync first)", async () => {
    const { w, ws, threadId } = await world();
    answerContext(ws, () => ({ ok: true, data: ANSWER }));
    expect((await read(w, threadId)).status).toBe(200);
    const sent = ws.sb.received
      .filter((frame) => frame.type === "pi.command" || frame.type === "thread.context")
      .map((frame) => (frame.type === "pi.command" ? frame.command.type : frame.type));
    expect(sent).toEqual(["get_entries", "thread.context"]);
  });
});
