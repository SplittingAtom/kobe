import type { KobeToolsRequest, KobeToolsResponse, ProjectCommitResultFrame } from "@kobe/protocol";
import { projectCommitFrameSchema } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { PushPathError } from "../workspace/sync.js";
import { ProjectCommitBroker } from "./project-commit-broker.js";

const THREAD = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e";
const RUN = "6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f";

type CommitRequest = Extract<KobeToolsRequest, { op: "project.commit" }>;
const request = (id = "kt_1"): CommitRequest => ({
  id,
  op: "project.commit",
  tool_call_id: `call_${id}`,
  tool: "commit_project",
  input: { message: "Add the Q3 numbers" },
});
const result = (request_id: string, seq = 5): ProjectCommitResultFrame => ({
  v: 1,
  type: "project.commit_result",
  request_id,
  ok: true,
  op: "project_commit",
  outcome: { status: "committed", seq },
});

function setup(options: { sends?: boolean; push?: () => Promise<unknown>; write?: boolean } = {}) {
  const frames: Record<string, unknown>[] = [];
  const order: string[] = [];
  const replies: KobeToolsResponse[] = [];
  const broker = new ProjectCommitBroker({
    send: (frame) => {
      order.push("send");
      frames.push(frame as unknown as Record<string, unknown>);
      return options.sends ?? true;
    },
    push:
      options.push ??
      (async () => {
        order.push("push");
        return { changes: 1 };
      }),
    canCommit: (runId) => runId === RUN && options.write !== false,
  });
  const reply = (r: KobeToolsResponse) => replies.push(r);
  return { broker, frames, order, replies, reply };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("ProjectCommitBroker (KOBE-580, CM6)", () => {
  it("pushes the working copy first, then sends project.commit, then relays the result", async () => {
    const { broker, frames, order, replies, reply } = setup();
    broker.commit(THREAD, RUN, request(), reply);
    await settle();
    expect(order).toEqual(["push", "send"]);
    const frame = frames[0] as Record<string, unknown>;
    expect(projectCommitFrameSchema.parse(frame)).toEqual({
      v: 1,
      type: "project.commit",
      request_id: expect.stringMatching(/^pc_/),
      run_id: RUN,
      thread_id: THREAD,
      tool_call_id: "call_kt_1",
      tool: "commit_project",
      input: { message: "Add the Q3 numbers" },
    });
    expect(replies).toEqual([]);
    expect(broker.onResult(result(frame.request_id as string, 9))).toBe(true);
    expect(replies).toEqual([
      { id: "kt_1", ok: true, op: "project_commit", outcome: { status: "committed", seq: 9 } },
    ]);
    expect(broker.onResult(result(frame.request_id as string))).toBe(false); // answered once
    expect(broker.pendingCount).toBe(0);
  });

  it("relays every outcome and a server refusal as they are", async () => {
    for (const outcome of [
      { status: "commit_conflict", head_seq: 4 },
      { status: "nothing_to_commit" },
      { status: "pending_approval" },
    ] as const) {
      const { broker, frames, replies, reply } = setup();
      broker.commit(THREAD, RUN, request(), reply);
      await settle();
      const id = frames[0]?.request_id as string;
      broker.onResult({ ...result(id), outcome } as ProjectCommitResultFrame);
      expect(replies).toEqual([{ id: "kt_1", ok: true, op: "project_commit", outcome }]);
    }
    const { broker, frames, replies, reply } = setup();
    broker.commit(THREAD, RUN, request(), reply);
    await settle();
    const error = { code: "not_allowed", message: "refused in a scheduled run" };
    broker.onResult({
      v: 1,
      type: "project.commit_result",
      request_id: frames[0]?.request_id as string,
      ok: false,
      error,
    });
    expect(replies).toEqual([{ id: "kt_1", ok: false, error }]);
  });

  it("sends nothing when the push fails, and answers exactly once", async () => {
    const failing = setup({
      push: () => Promise.reject(new PushPathError("the workspace is still being restored")),
    });
    failing.broker.commit(THREAD, RUN, request(), failing.reply);
    await settle();
    expect(failing.frames).toEqual([]);
    expect(failing.replies).toEqual([
      {
        id: "kt_1",
        ok: false,
        error: { code: "not_synced", message: "the workspace is still being restored" },
      },
    ]);
    const unreachable = setup({ sends: false });
    unreachable.broker.commit(THREAD, RUN, request(), unreachable.reply);
    await settle();
    expect(unreachable.replies).toMatchObject([{ ok: false, error: { code: "unavailable" } }]);
  });

  it("needs a run, allows one commit per thread at a time, and fails pending ones when the run ends", async () => {
    const { broker, frames, replies, reply } = setup();
    broker.commit(THREAD, undefined, request("kt_0"), reply);
    expect(replies.at(-1)).toMatchObject({ id: "kt_0", ok: false, error: { code: "not_allowed" } });
    broker.commit(THREAD, RUN, request("kt_1"), reply);
    broker.commit(THREAD, RUN, request("kt_2"), reply);
    expect(replies.at(-1)).toMatchObject({ id: "kt_2", ok: false, error: { code: "unavailable" } });
    await settle();
    broker.failRun(RUN, "run ended");
    expect(replies.at(-1)).toEqual({
      id: "kt_1",
      ok: false,
      error: { code: "unavailable", message: "run ended" },
    });
    expect(broker.onResult(result(frames[0]?.request_id as string))).toBe(false);
  });

  it("refuses a run whose viewer may only read the project, before pushing anything", async () => {
    const { broker, frames, order, replies, reply } = setup({ write: false });
    broker.commit(THREAD, RUN, request(), reply);
    await settle();
    expect(order).toEqual([]);
    expect(frames).toEqual([]);
    expect(replies).toEqual([
      {
        id: "kt_1",
        ok: false,
        error: { code: "not_allowed", message: "you can read this project but not change it" },
      },
    ]);
  });
});
