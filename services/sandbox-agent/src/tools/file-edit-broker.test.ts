import type {
  FileEditProposeResultFrame,
  KobeToolsRequest,
  KobeToolsResponse,
} from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { FileEditBroker, MAX_PENDING_PROPOSALS_PER_THREAD } from "./file-edit-broker.js";

const THREAD = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e";
const RUN = "6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f";
type Req = Extract<KobeToolsRequest, { op: "file.edit_propose" }>;
const input = { path: "notes.md", content: "new\n", summary: "Tidy" };
const request = (id = "kt_1"): Req => ({
  id,
  op: "file.edit_propose",
  tool_call_id: `call_${id}`,
  tool: "propose_file_edit",
  input,
});

function setup(sendOk = true) {
  const sent: Record<string, unknown>[] = [];
  const replies: KobeToolsResponse[] = [];
  const broker = new FileEditBroker({
    send: (frame) => {
      sent.push(frame as unknown as Record<string, unknown>);
      return sendOk;
    },
  });
  return { broker, sent, replies, reply: (r: KobeToolsResponse) => replies.push(r) };
}

describe("FileEditBroker (KOBE-462)", () => {
  it("sends file.edit_propose with the agent's own run and thread, then relays the answer", () => {
    const { broker, sent, replies, reply } = setup();
    broker.propose(THREAD, RUN, request(), reply);
    expect(sent[0]).toMatchObject({
      type: "file.edit_propose",
      run_id: RUN,
      thread_id: THREAD,
      tool_call_id: "call_kt_1",
      tool: "propose_file_edit",
      input,
    });
    const frame: FileEditProposeResultFrame = {
      v: 1,
      type: "file.edit_propose_result",
      request_id: sent[0]?.request_id as string,
      ok: true,
      op: "file_edit_propose",
      status: "awaiting_user",
      path: "notes.md",
      base_sha256: "d".repeat(64),
    };
    expect(broker.onResult(frame)).toBe(true);
    expect(replies).toEqual([
      {
        id: "kt_1",
        ok: true,
        op: "file_edit_propose",
        status: "awaiting_user",
        path: "notes.md",
        base_sha256: "d".repeat(64),
      },
    ]);
    expect(broker.onResult(frame)).toBe(false);
  });

  it("fails closed without a run, without a wire, past the cap and when the run ends", () => {
    const a = setup();
    a.broker.propose(THREAD, undefined, request(), a.reply);
    expect(a.replies[0]).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    const b = setup(false);
    b.broker.propose(THREAD, RUN, request(), b.reply);
    expect(b.replies[0]).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const c = setup();
    for (let i = 0; i <= MAX_PENDING_PROPOSALS_PER_THREAD; i += 1) {
      c.broker.propose(THREAD, RUN, request(`kt_${i}`), c.reply);
    }
    expect(c.replies).toHaveLength(1);
    c.broker.failRun(RUN, "run ended");
    expect(c.replies).toHaveLength(MAX_PENDING_PROPOSALS_PER_THREAD + 1);
    expect(c.replies.every((r) => !r.ok)).toBe(true);
  });
});
