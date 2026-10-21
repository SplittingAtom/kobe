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

describe("context.omitted (KOBE-77)", () => {
  it("is a run notice, and replaying the stream from 0 rebuilds it once", () => {
    seq = 0;
    const events = [
      ev("run.started", { thread_id: THREAD, agent_id: null, agent_version: null }),
      ev("context.omitted", {
        items: [{ kind: "skill", name: "sql-helper", reason: "blocklisted" }],
      }),
    ];
    const first = applyRunEvents(newLiveRun(RUN), events).run;
    expect(first.notices.map((n) => n.type)).toEqual(["context.omitted"]);
    const replayed = applyRunEvents(first, events).run;
    expect(replayed.notices).toHaveLength(1);
    expect(applyRunEvents(newLiveRun(RUN), events).run.notices).toEqual(first.notices);
  });
});

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

describe("context tokens (KOBE-211)", () => {
  const committed = (id: string, message: Record<string, unknown>) =>
    ev("entry.committed", {
      entry_id: id,
      parent_id: null,
      entry_type: "message",
      payload: { type: "message", id, parentId: null, message } as never,
    });

  it("follow each assistant message's usage as it commits; the prompt and offloaded entries leave them", () => {
    seq = 0;
    const start = ev("run.started", { thread_id: THREAD, agent_id: null, agent_version: null });
    const first = apply(newLiveRun(RUN), [
      start,
      committed("u1", { role: "user", content: "hi" }),
    ]).run;
    expect(first.contextTokens).toBeUndefined();
    const second = apply(first, [
      committed("a1", { role: "assistant", content: [], usage: { input: 900, cacheRead: 99_100 } }),
    ]).run;
    expect(second.contextTokens).toBe(100_000);
    const third = apply(second, [
      ev("entry.committed", { entry_id: "a2", parent_id: "a1", entry_type: "message" }),
      committed("t1", { role: "toolResult", content: [] }),
    ]).run;
    expect(third.contextTokens).toBe(100_000);
    const fourth = apply(third, [
      committed("a3", {
        role: "assistant",
        content: [],
        usage: { input: 5_000, cacheRead: 100_000 },
      }),
    ]).run;
    expect(fourth.contextTokens).toBe(105_000);
  });

  it("count cache writes, and become unknown after a compaction until the next message", () => {
    seq = 0;
    const start = ev("run.started", { thread_id: THREAD, agent_id: null, agent_version: null });
    const written = apply(newLiveRun(RUN), [
      start,
      // Anthropic via Pi: the prompt written to the cache is neither input nor cache read.
      committed("a1", {
        role: "assistant",
        content: [],
        usage: { input: 3, cacheRead: 0, cacheWrite: 180_000 },
      }),
    ]).run;
    expect(written.contextTokens).toBe(180_003);
    const compacted = apply(written, [
      ev("entry.committed", {
        entry_id: "c1",
        parent_id: "a1",
        entry_type: "compaction",
        payload: { type: "compaction", id: "c1", summary: "…", tokensBefore: 180_003 } as never,
      }),
    ]).run;
    expect(compacted.contextTokens).toBeNull();
    const next = apply(compacted, [
      committed("a2", {
        role: "assistant",
        content: [],
        usage: { input: 20_000, cacheRead: 0, cacheWrite: 0 },
      }),
    ]).run;
    expect(next.contextTokens).toBe(20_000);
  });
});

describe("file.edit_proposed (KOBE-463)", () => {
  it("lands on its tool call, so the card can offer Review while the run streams", () => {
    seq = 0;
    const proposal = {
      tool_call_id: "call-9",
      path: "notes.md",
      base_sha256: "a".repeat(64),
      content: "new\n",
      summary: "Tidies the note",
    };
    const events = [
      ev("run.started", { thread_id: THREAD, agent_id: null, agent_version: null }),
      ev("tool.call", {
        tool_call_id: "call-9",
        tool: "propose_file_edit",
        input: {},
        risk: "read",
      }),
      ev("file.edit_proposed", proposal),
    ];
    const run = applyRunEvents(newLiveRun(RUN), events).run;
    expect(run.tools["call-9"]?.fileEdit).toEqual(proposal);
    expect(run.notices).toEqual([]);
  });
});

describe("notebook events (KOBE-464)", () => {
  it("are ignored by the chat stream until the notebook view (KOBE-465)", () => {
    seq = 0;
    const exec_id = "9b2f6a1e-3c4d-4e5f-8a6b-7c8d9e0f1a2b";
    const before = applyRunEvents(newLiveRun(RUN), [
      ev("run.started", { thread_id: THREAD, agent_id: null, agent_version: null }),
    ]).run;
    const after = applyRunEvents(before, [
      ev("notebook.started", { exec_id, origin: "user", path: "a.ipynb", cell_id: "c1" }),
      ev("notebook.output", {
        exec_id,
        index: 0,
        output: { output_type: "stream", name: "stdout", text: "2\n" },
      }),
      ev("notebook.finished", {
        exec_id,
        status: "ok",
        execution_count: 1,
        outputs: 1,
        truncated: false,
        saved: null,
      }),
    ]).run;
    expect(after.notices).toEqual(before.notices);
    expect(after.tools).toEqual(before.tools);
  });
});
