import { afterAll, describe, expect, it } from "vitest";
import type { PinnedTool } from "@kobe/db";
import type { TeamConnector } from "../mcp/catalog.js";
import type { PolicyRule, PolicyRuleSet } from "../policy/rules.js";
import { pinnedTool } from "../testing/mcp-fixtures.js";
import { appBridgeDecision, checkAppTool, validateArguments } from "./decide.js";
import { createValidatorPool } from "./validate-pool.js";

const pool = createValidatorPool();
afterAll(() => pool.close());

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date("2026-10-19T12:00:00Z");
const read = pinnedTool("cat", { name: "preview_table", readOnly: true });
const write = pinnedTool("cat", { name: "drop_table", destructive: false });
const drifted = pinnedTool("cat", { name: "describe", readOnly: true, status: "drifted" });
const modelOnly = pinnedTool("cat", { name: "sql", readOnly: true, ui: { visibility: ["model"] } });
const appOnly = pinnedTool("cat", { name: "list_ns", readOnly: true, ui: { visibility: ["app"] } });

const connector = (
  tools: PinnedTool[],
  exposure: TeamConnector["exposure"] = "all",
  enabledTools: string[] = [],
): TeamConnector => ({
  id: ID,
  name: "cat",
  url: "https://cat.example/mcp",
  authKind: "api_key",
  exposure,
  enabledTools,
  tools,
});

describe("checkAppTool (spec §6 rules 1-2)", () => {
  const all = connector([read, write, drifted, modelOnly, appOnly]);
  it("allows a pinned, read-only, app-visible, exposed tool", () => {
    expect(checkAppTool(all, "preview_table")).toEqual({ ok: true, tool: read });
    expect(checkAppTool(all, "list_ns")).toMatchObject({ ok: true });
  });
  it("refuses unknown, drifted, write and not app-visible tools", () => {
    expect(checkAppTool(all, "other")).toEqual({ ok: false, reason: "tool_not_in_app" });
    expect(checkAppTool(all, "describe")).toEqual({ ok: false, reason: "tool_drifted" });
    expect(checkAppTool(all, "drop_table")).toEqual({ ok: false, reason: "tool_not_read_only" });
    expect(checkAppTool(all, "sql")).toEqual({ ok: false, reason: "tool_not_app_visible" });
  });
  it("applies the team's exposure: custom needs the tool ticked", () => {
    const custom = connector([read, appOnly], "custom", [appOnly.pi_name]);
    expect(checkAppTool(custom, "preview_table")).toEqual({
      ok: false,
      reason: "connector_exposure",
    });
    expect(checkAppTool(custom, "list_ns")).toMatchObject({ ok: true });
  });
});

describe("validateArguments (rule 3)", () => {
  const tool = {
    ...read,
    input_schema: {
      type: "object",
      properties: { table: { type: "string" } },
      required: ["table"],
      additionalProperties: false,
    },
  };
  it("validates against the pinned JSON Schema", async () => {
    expect(await validateArguments(pool, tool, { table: "t" }, "u1")).toBe("valid");
    expect(await validateArguments(pool, tool, {}, "u1")).toBe("invalid");
    expect(await validateArguments(pool, tool, { table: 1 }, "u1")).toBe("invalid");
    expect(await validateArguments(pool, tool, { table: "t", x: 1 }, "u1")).toBe("invalid");
  });
  it("refuses more than 64 KiB of arguments", async () => {
    const open = { ...read, input_schema: { type: "object" } };
    expect(await validateArguments(pool, open, { x: "y".repeat(64 * 1024) }, "u1")).toBe("invalid");
  });
});

describe("appBridgeDecision (MA5)", () => {
  const rule = (over: Partial<PolicyRule>): PolicyRule =>
    ({
      id: "r1",
      scope: "team",
      effect: "deny",
      tool_glob: "mcp__cat__*",
      ...over,
    }) as PolicyRule;
  const rules = (r: Partial<PolicyRuleSet>): PolicyRuleSet => ({
    site: [],
    team: [],
    user: [],
    ...r,
  });
  const decide = (tool: PinnedTool, set: PolicyRuleSet) =>
    appBridgeDecision(ID, tool, { table: "t" }, set, NOW);

  it("allows a read tool with no rules", () => {
    expect(decide(read, rules({}))).toEqual({ allowed: true });
  });
  it("denies on a site or team deny rule, and on an ask rule (never prompts)", () => {
    expect(decide(read, rules({ site: [rule({ scope: "site" })] }))).toMatchObject({
      allowed: false,
      reason: "site_deny_rule",
    });
    expect(decide(read, rules({ team: [rule({})] }))).toMatchObject({
      allowed: false,
      reason: "team_deny_rule",
    });
    expect(decide(read, rules({ team: [rule({ effect: "ask" })] }))).toEqual({
      allowed: false,
      reason: "app_no_prompt",
    });
  });
  it("denies anything that is not read, and a user allow rule never widens (ac-4)", () => {
    const allowAll = rule({ scope: "user", effect: "allow", tool_glob: write.pi_name });
    expect(decide(write, rules({ user: [allowAll] }))).toEqual({
      allowed: false,
      reason: "app_read_only",
    });
    const teamAllow = rule({ effect: "allow", tool_glob: write.pi_name });
    expect(decide(write, rules({ team: [teamAllow] }))).toMatchObject({ allowed: false });
  });
});
