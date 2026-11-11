import { describe, expect, it } from "vitest";
import type { KobeEvent } from "@kobe/protocol";
import {
  KOBE_ADMIN_RESULT_HIDDEN,
  adminResultGate,
  redactEntry,
  redactEntryPayload,
  redactEvent,
} from "./admin-redaction.js";

const member = adminResultGate({ segments: ["kobe"], teamRole: "member", siteRole: null });
const teamAdmin = adminResultGate({ segments: ["kobe"], teamRole: "team_admin", siteRole: null });

const result = (toolName: string, text = "secret rows") => ({
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: "tc1",
    toolName,
    content: [{ type: "text", text }],
    details: { rows: 3 },
    isError: false,
  },
});

describe("shared-thread redaction of Kobe admin results (KOBE-623, KA6)", () => {
  it("hides an admin tool's output from a reader without its permission", () => {
    expect(member.hides("mcp__kobe__team_members_list")).toBe(true);
    expect(member.hides("mcp__kobe__team_members_set_role")).toBe(true);
  });

  it("shows it to a reader holding the tool's permission", () => {
    expect(teamAdmin.hides("mcp__kobe__team_members_list")).toBe(false);
  });

  it("never hides the docs tools, other connectors or built-in tools", () => {
    expect(member.hides("mcp__kobe__docs_index")).toBe(false);
    expect(member.hides("mcp__catalyst__team_members_list")).toBe(false);
    expect(member.hides("bash")).toBe(false);
  });

  it("hides a Kobe tool the catalog does not know (fail closed)", () => {
    expect(teamAdmin.hides("mcp__kobe__team_future_tool")).toBe(true);
  });

  it("follows the built-in's fallback name", () => {
    const gate = adminResultGate({
      segments: ["kobe_builtin"],
      teamRole: "member",
      siteRole: null,
    });
    expect(gate.hides("mcp__kobe_builtin__team_members_list")).toBe(true);
    // A registered connector that took the name `kobe` is not the built-in.
    expect(gate.hides("mcp__kobe__team_members_list")).toBe(false);
  });

  it("replaces content and details, keeping the call's identity", () => {
    const payload = redactEntryPayload(result("mcp__kobe__team_members_list"), member);
    expect(payload).toEqual({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "mcp__kobe__team_members_list",
        content: [{ type: "text", text: KOBE_ADMIN_RESULT_HIDDEN }],
        isError: false,
      },
    });
    expect(JSON.stringify(payload)).not.toContain("secret");
  });

  it("leaves the owner's view (no gate) and other entries alone", () => {
    expect(redactEntryPayload(result("mcp__kobe__team_members_list"), undefined)).toBeUndefined();
    expect(redactEntryPayload(result("bash"), member)).toBeUndefined();
    expect(redactEntryPayload({ type: "message", message: { role: "user" } }, member)).toBe(
      undefined,
    );
  });

  it("marks a served entry and drops its truncation flag", () => {
    const entry = {
      entry_id: "e1",
      payload: result("mcp__kobe__team_audit_list") as Record<string, unknown>,
      payload_truncated: true as const,
    };
    const out = redactEntry(entry, member) as Record<string, unknown>;
    expect(out.admin_result_hidden).toBe(true);
    expect(out.payload_truncated).toBeUndefined();
    expect(redactEntry(entry, teamAdmin)).toBe(entry);
  });

  it("hides a tool.result event's preview from a reader", () => {
    const event = {
      run_id: "r",
      seq: 4,
      ts: "2026-11-11T00:00:00.000Z",
      type: "tool.result",
      payload: {
        tool_call_id: "tc1",
        tool: "mcp__kobe__team_members_list",
        is_error: false,
        preview: "secret rows",
        blob_ref: "teams/x/blob",
        truncated: true,
      },
    } as KobeEvent;
    const out = redactEvent(event, member);
    expect(out.payload).toEqual({
      tool_call_id: "tc1",
      tool: "mcp__kobe__team_members_list",
      is_error: false,
      preview: KOBE_ADMIN_RESULT_HIDDEN,
      truncated: false,
    });
    expect(redactEvent(event, teamAdmin)).toBe(event);
    expect(redactEvent(event, undefined)).toBe(event);
  });
});
