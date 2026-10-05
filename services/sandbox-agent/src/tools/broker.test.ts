import type {
  ArtifactPutFrame,
  ArtifactResultFrame,
  KobeToolsRequest,
  KobeToolsResponse,
} from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { ArtifactBroker, MAX_PENDING_PUTS_PER_THREAD } from "./broker.js";

const THREAD = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e";
const RUN = "6c7d8e9f-0a1b-4c2d-9e3f-4a5b6c7d8e9f";
const ARTIFACT = "7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a";
const request = (id = "kt_1", extra: Partial<KobeToolsRequest> = {}): KobeToolsRequest =>
  ({
    id,
    op: "artifact.put",
    tool_call_id: `call_${id}`,
    tool: "create_artifact",
    input: { kind: "markdown", title: "t", content: "# hi" },
    ...extra,
  }) as KobeToolsRequest;

function setup(sends = true) {
  const frames: ArtifactPutFrame[] = [];
  const broker = new ArtifactBroker({ send: (f) => (frames.push(f), sends) });
  const replies: KobeToolsResponse[] = [];
  return { broker, frames, replies, reply: (r: KobeToolsResponse) => replies.push(r) };
}
const ok = (request_id: string): ArtifactResultFrame => ({
  v: 1,
  type: "artifact.result",
  request_id,
  ok: true,
  artifact_id: ARTIFACT,
  version: 1,
});

describe("ArtifactBroker", () => {
  it("sends artifact.put with the agent's run and thread and the extension's ids", () => {
    const t = setup();
    t.broker.put(THREAD, RUN, request(), t.reply);
    expect(t.frames).toEqual([
      {
        v: 1,
        type: "artifact.put",
        request_id: "ap_1",
        run_id: RUN,
        thread_id: THREAD,
        tool_call_id: "call_kt_1",
        tool: "create_artifact",
        input: { kind: "markdown", title: "t", content: "# hi" },
      },
    ]);
    expect(t.broker.pendingCount).toBe(1);
  });

  it("maps the ok result back with the extension's request id", () => {
    const t = setup();
    t.broker.put(THREAD, RUN, request("kt_7"), t.reply);
    expect(t.broker.onResult(ok("ap_1"))).toBe(true);
    expect(t.replies).toEqual([{ id: "kt_7", ok: true, artifact_id: ARTIFACT, version: 1 }]);
    expect(t.broker.pendingCount).toBe(0);
  });

  it("maps a server error back (open code)", () => {
    const t = setup();
    t.broker.put(THREAD, RUN, request("kt_7"), t.reply);
    t.broker.onResult({
      v: 1,
      type: "artifact.result",
      request_id: "ap_1",
      ok: false,
      error: { code: "not_allowed", message: "no" },
    });
    expect(t.replies).toEqual([
      { id: "kt_7", ok: false, error: { code: "not_allowed", message: "no" } },
    ]);
  });

  it("drops a result nobody waits for", () => {
    const t = setup();
    expect(t.broker.onResult(ok("ap_99"))).toBe(false);
    expect(t.replies).toEqual([]);
  });

  it("errors without an active run, without sending", () => {
    const t = setup();
    t.broker.put(THREAD, undefined, request(), t.reply);
    expect(t.frames).toEqual([]);
    expect(t.replies).toMatchObject([{ ok: false, error: { code: "not_allowed" } }]);
  });

  it("errors when the wire is not ready", () => {
    const t = setup(false);
    t.broker.put(THREAD, RUN, request(), t.reply);
    expect(t.replies).toMatchObject([{ ok: false, error: { code: "unavailable" } }]);
    expect(t.broker.pendingCount).toBe(0);
  });

  it("refuses a frame over 1 MiB with too_large, without sending", () => {
    const t = setup();
    const input = { kind: "html", title: "t", content: "\u0001".repeat(512 * 1024) };
    t.broker.put(THREAD, RUN, request("kt_1", { input } as never), t.reply);
    expect(t.frames).toEqual([]);
    expect(t.replies).toMatchObject([{ ok: false, error: { code: "too_large" } }]);
  });

  it("caps requests in flight per thread", () => {
    const t = setup();
    for (let i = 0; i <= MAX_PENDING_PUTS_PER_THREAD; i += 1) {
      t.broker.put(THREAD, RUN, request(`kt_${i}`), t.reply);
    }
    expect(t.frames).toHaveLength(MAX_PENDING_PUTS_PER_THREAD);
    expect(t.replies).toMatchObject([{ error: { code: "unavailable" } }]);
  });

  it("fails by run, thread and all", () => {
    const t = setup();
    t.broker.put(THREAD, RUN, request("a"), t.reply);
    t.broker.put("other", "run2", request("b"), t.reply);
    t.broker.failRun(RUN, "run ended");
    expect(t.replies).toMatchObject([{ id: "a", ok: false }]);
    t.broker.failThread("other", "closed");
    expect(t.replies).toHaveLength(2);
    t.broker.put(THREAD, RUN, request("c"), t.reply);
    t.broker.failAll("lost");
    expect(t.replies).toHaveLength(3);
    expect(t.broker.pendingCount).toBe(0);
  });
});
