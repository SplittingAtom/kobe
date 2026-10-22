import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { KobeToolsRequest, KobeToolsResponse, NotebookRunResultFrame } from "@kobe/protocol";
import { describe, expect, it, vi } from "vitest";
import { MAX_PENDING_RUNS_PER_THREAD, NotebookBroker } from "./notebook-broker.js";

const THREAD = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e";
const RUN = "6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f";
/** Under CI load file I/O can take seconds; the tests allow more than that. */
const SETTLE_MS = 15_000;
type Req = Extract<KobeToolsRequest, { op: "notebook.run" }>;
const request = (input: Req["input"], id = "kt_1"): Req => ({
  id,
  op: "notebook.run",
  tool_call_id: `call_${id}`,
  tool: "run_python",
  input,
});

async function setup(options: { sendOk?: boolean; sync?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "nb-broker-"));
  await writeFile(path.join(root, "a.ipynb"), "{}");
  const sent: Record<string, unknown>[] = [];
  const pushed: string[] = [];
  const replies: KobeToolsResponse[] = [];
  const broker = new NotebookBroker({
    root,
    send: (frame) => {
      sent.push(frame as unknown as Record<string, unknown>);
      return options.sendOk ?? true;
    },
    ...(options.sync === false
      ? {}
      : {
          pushPath: (rel: string) => {
            pushed.push(rel);
            return Promise.resolve({ path: rel, rev: 1, sha256: "e".repeat(64), size: 2 });
          },
        }),
  });
  // Every request ends in exactly one frame sent or one reply: wait for that many (file I/O is
  // slow under load), not for a fixed time (KOBE-415).
  const settle = (outcomes: number) =>
    vi.waitFor(() => expect(sent.length + replies.length).toBe(outcomes), { timeout: SETTLE_MS });
  return {
    broker,
    sent,
    pushed,
    replies,
    reply: (r: KobeToolsResponse) => replies.push(r),
    settle,
  };
}

describe("NotebookBroker (KOBE-464)", { timeout: SETTLE_MS + 5_000 }, () => {
  it("sends code at once with the agent's run and thread, and relays the answer", async () => {
    const { broker, sent, pushed, replies, reply, settle } = await setup();
    broker.run(THREAD, RUN, request({ code: "1+1" }), reply);
    await settle(1);
    expect(pushed).toEqual([]);
    expect(sent[0]).toMatchObject({
      type: "notebook.run",
      run_id: RUN,
      thread_id: THREAD,
      tool_call_id: "call_kt_1",
      tool: "run_python",
      input: { code: "1+1" },
    });
    const result: NotebookRunResultFrame = {
      v: 1,
      type: "notebook.run_result",
      request_id: sent[0]?.request_id as string,
      ok: true,
      op: "notebook_run",
      status: "ok",
      execution_count: 1,
      text: "2",
      truncated: false,
      saved: null,
    };
    expect(broker.onResult(result)).toBe(true);
    expect(broker.onResult(result)).toBe(false);
    expect(replies).toEqual([
      {
        id: "kt_1",
        ok: true,
        op: "notebook_run",
        status: "ok",
        execution_count: 1,
        text: "2",
        truncated: false,
        saved: null,
      },
    ]);
  });

  it("pushes a file before naming it, and refuses paths outside the workspace", async () => {
    const { broker, sent, pushed, replies, reply, settle } = await setup();
    broker.run(THREAD, RUN, request({ path: "/workspace/a.ipynb", cell_id: "c1" }), reply);
    await settle(1);
    expect(replies).toEqual([
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "invalid_path" }),
      }),
    ]);
    broker.run(THREAD, RUN, request({ path: "a.ipynb", cell_id: "c1" }, "kt_2"), reply);
    await settle(2);
    expect(pushed).toEqual(["a.ipynb"]);
    expect(sent).toHaveLength(1);
  });

  it("refuses a path without workspace sync, and without a run", async () => {
    const { broker, sent, replies, reply, settle } = await setup({ sync: false });
    broker.run(THREAD, RUN, request({ path: "a.ipynb", cell_id: "c1" }), reply);
    broker.run(THREAD, undefined, request({ code: "1" }, "kt_2"), reply);
    await settle(2);
    expect(sent).toEqual([]);
    expect(replies.map((r) => !r.ok && r.error.code)).toEqual(["not_synced", "not_allowed"]);
  });

  it("bounds runs in flight per thread and fails them when the run ends", async () => {
    const { broker, replies, reply, settle } = await setup();
    for (let i = 0; i <= MAX_PENDING_RUNS_PER_THREAD; i++) {
      broker.run(THREAD, RUN, request({ code: "1" }, `kt_${i}`), reply);
    }
    await settle(MAX_PENDING_RUNS_PER_THREAD + 1);
    expect(replies.map((r) => !r.ok && r.error.code)).toEqual(["unavailable"]);
    broker.failRun(RUN, "run ended");
    expect(replies).toHaveLength(MAX_PENDING_RUNS_PER_THREAD + 1);
  });
});
