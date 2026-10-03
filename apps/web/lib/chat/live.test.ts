import type { KobeEvent, KobeEventPayload, KobeEventType } from "@kobe/protocol";
import { describe, expect, it } from "vitest";
import { MAX_ITEMS, applyRunEvents, newLiveRun, type LiveRun } from "./live";

const RUN = "00000000-0000-4000-8000-000000000101";
const THREAD = "00000000-0000-4000-8000-000000000201";

let seq = 0;
function ev<T extends KobeEventType>(
  type: T,
  payload: KobeEventPayload<T>,
  at?: number,
): KobeEvent {
  seq = at ?? seq + 1;
  return { run_id: RUN, seq, ts: "2026-10-02T10:00:00Z", type, payload } as KobeEvent;
}

function apply(run: LiveRun, events: KobeEvent[]) {
  return applyRunEvents(run, events);
}

describe("applyRunEvents", () => {
  it("assembles deltas per message and content index, then drops them when the entry commits", () => {
    seq = 0;
    const events = [
      ev("run.started", { thread_id: THREAD, agent_id: null, agent_version: null }),
      ev("reasoning.delta", { message_id: "m1", content_index: 0, delta: "think" }),
      ev("text.delta", { message_id: "m1", content_index: 1, delta: "Hel" }),
      ev("text.delta", { message_id: "m1", content_index: 1, delta: "lo" }),
    ];
    const { run } = apply(newLiveRun(RUN), events);
    expect(run.started).toBe(true);
    expect(run.messages).toEqual([
      {
        messageId: "m1",
        parts: [
          { kind: "reasoning", contentIndex: 0, text: "think" },
          { kind: "text", contentIndex: 1, text: "Hello" },
        ],
      },
    ]);
    const committed = apply(run, [
      ev("entry.committed", {
        entry_id: "e1",
        parent_id: null,
        entry_type: "message",
        payload: { type: "message", message: { role: "user", content: "q" } },
      }),
      ev("entry.committed", {
        entry_id: "e2",
        parent_id: "e1",
        entry_type: "message",
        message_id: "m1",
        payload: { type: "message", message: { role: "assistant", content: [] } },
      }),
      ev("text.delta", { message_id: "m1", content_index: 1, delta: "late" }),
    ]);
    expect(committed.run.messages).toEqual([]);
    expect(committed.run.promptCommitted).toBe(true);
    expect(committed.run.committed).toEqual(["e1", "e2"]);
    expect(committed.entries.map((e) => e.entryId)).toEqual(["e1", "e2"]);
  });

  it("drops events at or below the last seq, so a replay from 0 changes nothing", () => {
    seq = 0;
    const events = [
      ev("run.started", { thread_id: THREAD, agent_id: null, agent_version: null }),
      ev("text.delta", { message_id: "m1", content_index: 0, delta: "a" }),
      ev("text.delta", { message_id: "m1", content_index: 0, delta: "b" }),
    ];
    const once = apply(newLiveRun(RUN), events).run;
    const twice = apply(once, events).run;
    expect(twice).toBe(once);
    const overlap = apply(apply(newLiveRun(RUN), events.slice(0, 2)).run, events).run;
    expect(overlap).toEqual(once);
  });

  it("tracks tool calls, results, policy denials, egress blocks and approvals by tool call", () => {
    seq = 0;
    const { run } = apply(newLiveRun(RUN), [
      ev("tool.call", {
        tool_call_id: "tc1",
        message_id: "m1",
        tool: "bash",
        input: { cmd: "pip install x" },
        risk: "destructive",
      }),
      ev("egress.blocked", { domain: "pypi.org", tool_call_id: "tc1", request_access: true }),
      ev("tool.result", {
        tool_call_id: "tc1",
        tool: "bash",
        is_error: true,
        preview: "blocked",
        truncated: false,
      }),
      ev("policy.denied", {
        tool_call_id: "tc2",
        tool: "mcp__jira__delete",
        reasons: [
          {
            code: "team_deny_rule",
            stage: "team_deny",
            message: "Deleting Jira issues is not allowed",
          },
        ],
      }),
      ev("egress.blocked", { domain: "example.com", request_access: false }),
    ]);
    expect(run.tools.tc1?.call?.tool).toBe("bash");
    expect(run.tools.tc1?.result?.is_error).toBe(true);
    expect(run.tools.tc1?.egressBlocked.map((b) => b.domain)).toEqual(["pypi.org"]);
    expect(run.tools.tc2?.denied?.reasons[0]?.message).toBe("Deleting Jira issues is not allowed");
    expect(run.notices.map((n) => n.type)).toEqual(["egress.blocked"]);
    expect(run.messages).toEqual([
      { messageId: "m1", parts: [{ kind: "tool", toolCallId: "tc1" }] },
    ]);
  });

  it("removes live tool parts once an entry with that tool call commits", () => {
    seq = 0;
    const { run } = apply(newLiveRun(RUN), [
      ev("tool.call", { tool_call_id: "tc1", tool: "read", input: {}, risk: "read" }),
      ev("entry.committed", {
        entry_id: "e2",
        parent_id: "e1",
        entry_type: "message",
        payload: {
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }],
          },
        },
      }),
    ]);
    expect(run.messages).toEqual([]);
  });

  it("clears the waking notice at the first sign of work and keeps the terminal event last", () => {
    seq = 0;
    const waking = apply(newLiveRun(RUN), [ev("sandbox.waking", { reason: "hibernated" })]).run;
    expect(waking.waking).toBe("hibernated");
    const working = apply(waking, [
      ev("text.delta", { message_id: "m1", content_index: 0, delta: "x" }),
    ]).run;
    expect(working.waking).toBeUndefined();
    const ended = apply(working, [
      ev("run.completed", { leaf_entry_id: "e9" }),
      ev("text.delta", { message_id: "m2", content_index: 0, delta: "after the end" }),
    ]).run;
    expect(ended.terminal?.type).toBe("run.completed");
    expect(ended.messages).toEqual([]); // completed: the entries are the record
    expect(ended.lastSeq).toBe(3); // nothing after the terminal event
  });

  it("ignores events of another run", () => {
    const other = {
      ...ev("text.delta", { message_id: "m1", content_index: 0, delta: "x" }),
      run_id: THREAD,
    };
    expect(apply(newLiveRun(RUN), [other]).run.lastSeq).toBe(0);
  });

  it("dedupes blocked domains, artifacts and files, and keeps at most 50 of each", () => {
    seq = 0;
    const events: KobeEvent[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(
        ev("egress.blocked", { domain: "pypi.org", tool_call_id: "tc1", request_access: true }),
      );
      events.push(ev("egress.blocked", { domain: "pypi.org", request_access: true }));
    }
    for (let i = 0; i < 80; i++) {
      events.push(ev("egress.blocked", { domain: `d${i}.example`, request_access: false }));
      events.push(
        ev("file.shared", {
          file_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          tool_call_id: "tc1",
          name: "f",
          size: 1,
        }),
      );
    }
    const { run } = apply(newLiveRun(RUN), events);
    expect(run.tools.tc1?.egressBlocked).toHaveLength(1);
    expect(run.notices).toHaveLength(MAX_ITEMS);
    expect(run.notices.at(-1)).toMatchObject({ payload: { domain: "d79.example" } });
    const domains = run.notices.map((n) => (n.type === "egress.blocked" ? n.payload.domain : ""));
    expect(new Set(domains).size).toBe(domains.length);
    expect(run.tools.tc1?.files).toHaveLength(MAX_ITEMS);
  });
});
