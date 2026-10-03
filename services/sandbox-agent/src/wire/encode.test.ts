import type { SandboxToServerFrame } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { encodePiEvent } from "../agent.js";
import { encodeOutbound } from "./encode.js";

const RUN = "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b";
const THREAD = "2c3d4e5f-6071-4829-9bac-1d2e3f4a5b6c";

/**
 * The server sizes a frame by its type before decoding it, read from the raw prefix (contract:
 * connection.ts), so every frame that may be large must start with `{"v":1,"type":"…"`.
 */
const PREFIX = /^\{"v":1,"type":"(pi\.event|policy\.check|command\.result)"/;

describe("outbound frames start with v and type", () => {
  it.each<[string, Record<string, unknown>]>([
    [
      "policy.check",
      {
        input: { path: "/workspace/a" },
        tool: "read",
        tool_call_id: "c1",
        thread_id: THREAD,
        run_id: RUN,
        request_id: "pc_1",
        type: "policy.check",
        v: 1,
      },
    ],
    [
      "command.result",
      { data: { ok: 1 }, ok: true, command_id: "c1", type: "command.result", v: 1 },
    ],
    [
      "pi.event",
      {
        event: { type: "agent_start" },
        seq: 1,
        thread_id: THREAD,
        run_id: RUN,
        type: "pi.event",
        v: 1,
      },
    ],
  ])("%s, whatever order its object was built in", (type, frame) => {
    const encoded = encodeOutbound(frame as unknown as SandboxToServerFrame);
    expect(encoded.ok && encoded.text).toMatch(PREFIX);
    expect(encoded.ok && encoded.text.startsWith(`{"v":1,"type":"${type}"`)).toBe(true);
  });

  it("pi.event frames built by the agent (including the dropped-event placeholder)", () => {
    expect(encodePiEvent(RUN, THREAD, 1, { type: "agent_start" })).toMatch(PREFIX);
    const huge = { type: "message_update", text: "x".repeat(5 * 1024 * 1024) };
    const placeholder = encodePiEvent(RUN, THREAD, 2, huge);
    expect(placeholder).toMatch(PREFIX);
    expect(placeholder).toContain("kobe.event_dropped");
  });
});
