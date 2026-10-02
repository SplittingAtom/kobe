import type { KobeEventPayload, KobeEventType } from "../events.js";
import type { PolicyReason } from "../policy.js";
import { EXAMPLE_IDS } from "./ids.js";

const reason: PolicyReason = {
  code: "risk_write",
  stage: "risk_class",
  message: "Writes to Jira need your approval",
};

/** One valid payload per event type: contract documentation and fixtures for consumers' tests. */
export const EVENT_PAYLOAD_EXAMPLES: { readonly [T in KobeEventType]: KobeEventPayload<T> } = {
  "run.queued": {
    thread_id: EXAMPLE_IDS.thread,
    trigger: "user",
    queue_pos: 1,
    user_entry_id: "a1b2c3d4",
  },
  "run.started": {
    thread_id: EXAMPLE_IDS.thread,
    agent_id: EXAMPLE_IDS.agent,
    agent_version: 3,
    model: "smart",
  },
  "sandbox.waking": { reason: "hibernated" },
  "text.delta": { message_id: "msg_1", content_index: 0, delta: "Here is the chart" },
  "reasoning.delta": { message_id: "msg_1", content_index: 1, delta: "Thinking…" },
  "tool.call": {
    tool_call_id: "tc_9",
    tool: "mcp__jira__create_issue",
    input: { project: "OPS", summary: "Disk full" },
    risk: "write",
  },
  "tool.result": {
    tool_call_id: "tc_9",
    tool: "mcp__jira__create_issue",
    is_error: false,
    preview: "OPS-12",
    truncated: false,
  },
  "approval.requested": {
    approval_id: EXAMPLE_IDS.approval,
    tool_call_id: "tc_9",
    tool: "mcp__jira__create_issue",
    input: { project: "OPS", summary: "Disk full" },
    risk: "write",
    reasons: [reason],
    expires_at: "2026-10-01T22:15:00Z",
  },
  "approval.resolved": {
    approval_id: EXAMPLE_IDS.approval,
    tool_call_id: "tc_9",
    decision: "allowed",
    cause: "user",
    decided_by: EXAMPLE_IDS.user,
    remembered: false,
  },
  "policy.denied": {
    tool_call_id: "tc_10",
    tool: "bash",
    reasons: [{ ...reason, code: "team_deny_rule", stage: "team_deny" }],
  },
  "egress.blocked": { domain: "pypi.org", request_access: true },
  "steer.applied": { entry_id: "e5f6a7b8", content: "Use a bar chart instead" },
  "memory.updated": {
    scope: "user",
    memory_doc_id: EXAMPLE_IDS.memory,
    path: "MEMORY.md",
    version: 4,
    previous_version: 3,
  },
  "artifact.created": {
    artifact_id: EXAMPLE_IDS.artifact,
    tool_call_id: "tc_11",
    kind: "html",
    title: "Sales by month",
    version: 1,
  },
  "artifact.updated": { artifact_id: EXAMPLE_IDS.artifact, version: 2 },
  "file.shared": {
    file_id: EXAMPLE_IDS.file,
    name: "report.docx",
    size: 48_213,
    mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  "entry.committed": {
    entry_id: "b2c3d4e5",
    parent_id: "a1b2c3d4",
    entry_type: "message",
    message_id: "msg_1",
    payload: {
      type: "message",
      id: "b2c3d4e5",
      parentId: "a1b2c3d4",
      message: { role: "assistant" },
    },
  },
  "run.completed": {
    leaf_entry_id: "b2c3d4e5",
    usage: { input: 1200, output: 340, cache_read: 0, cache_write: 0, cost_usd: 0.0123 },
  },
  "run.failed": { error: { code: "provider_error", message: "Model provider returned 529" } },
  "run.interrupted": { reason: "sandbox_lost", last_entry_id: "b2c3d4e5", retryable: true },
  "run.budget_stopped": { scope: "team", message: "Team budget reached" },
};
