import { describe, expect, it, vi } from "vitest";
import { policyDecisionSchema, type ToolDescriptor } from "@kobe/protocol";
import {
  builtin,
  ENABLED_ALL,
  IDS,
  mcpTool,
  NOW,
  policyInput,
  rule,
  ruleSet,
} from "../testing/policy-fixtures.js";
import { createPolicyEngine, type ConnectorStateSource, type PolicyRuleSource } from "./engine.js";
import type { ConnectorPolicyState } from "./gates.js";
import { createToolRegistry, type McpToolCatalog } from "./registry.js";
import { EMPTY_RULE_SET, type PolicyRule } from "./rules.js";

function rulesOf(rules: readonly PolicyRule[]): PolicyRuleSource & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    load: (...args) => {
      calls.push(args);
      return Promise.resolve(ruleSet(rules));
    },
  };
}

const jiraCreate = mcpTool("mcp__jira__create_issue", "write");
const catalog: McpToolCatalog = {
  resolve: (_team, name) => Promise.resolve(name === jiraCreate.name ? jiraCreate : undefined),
};
const connectors = (state: ConnectorPolicyState | undefined): ConnectorStateSource => ({
  get: () => Promise.resolve(state),
});

describe("createPolicyEngine", () => {
  it("denies an unknown tool before anything else", async () => {
    const forged: ToolDescriptor = { ...builtin("read"), name: "rm_everything" };
    const decision = await createPolicyEngine({
      rules: rulesOf([rule("user", "allow", "*")]),
      now: () => NOW,
    }).decide(policyInput(forged));
    expect(decision).toMatchObject({ effect: "deny", risk: "destructive" });
    expect(decision.reasons.map((r) => r.code)).toEqual(["unknown_tool"]);
  });

  it("re-derives the descriptor from the registry, ignoring risk and scope in the input", async () => {
    // A caller claiming remember is a read-only sandbox tool still gets prompted.
    const lie: ToolDescriptor = { ...builtin("remember"), risk: "read", scope: "sandbox" };
    const decision = await createPolicyEngine({ rules: rulesOf([]), now: () => NOW }).decide(
      policyInput(lie),
    );
    expect(decision).toMatchObject({ effect: "require_approval", risk: "write" });
  });

  it("denies MCP tools until a pinned catalog resolves them (fail closed by default)", async () => {
    const decision = await createPolicyEngine({ rules: rulesOf([]), now: () => NOW }).decide(
      policyInput(jiraCreate),
    );
    expect(decision.reasons[0]?.code).toBe("unknown_tool");
  });

  it("decides MCP tools against the catalog and the team's connector state", async () => {
    const base = { rules: rulesOf([]), registry: createToolRegistry(catalog), now: () => NOW };
    const disabled = await createPolicyEngine({
      ...base,
      connectors: connectors(undefined),
    }).decide(policyInput(jiraCreate));
    expect(disabled.reasons[0]?.code).toBe("connector_not_enabled");
    const enabled = await createPolicyEngine({
      ...base,
      connectors: connectors(ENABLED_ALL),
    }).decide(policyInput(jiraCreate));
    expect(enabled.effect).toBe("require_approval");
  });

  it("denies invalid input without consulting rules", async () => {
    const source = rulesOf([rule("user", "allow", "*")]);
    const e = createPolicyEngine({ rules: source, now: () => NOW });
    const bad = [
      { ...policyInput(builtin("read")), input: { path: "a\u0000b" } },
      { ...policyInput(builtin("read")), input: JSON.parse('{"__proto__": {"x": 1}}') as object },
      { ...policyInput(builtin("read")), input: { n: 2 ** 60 } },
      { ...policyInput(builtin("read")), team_id: "not-a-uuid" },
      { ...policyInput(builtin("read")), extra: true },
      null,
      "bash",
    ];
    for (const raw of bad) {
      const decision = await e.decide(raw as never);
      expect(decision.effect).toBe("deny");
      expect(decision.reasons[0]?.code).toBe("invalid_input");
      expect(policyDecisionSchema.safeParse(decision).success).toBe(true);
    }
    expect(source.calls).toEqual([]);
  });

  it("requires connector exposure for MCP inputs (contract)", async () => {
    const input = policyInput(jiraCreate);
    const { connector_exposure: _drop, ...context } = input.context;
    const decision = await createPolicyEngine({
      rules: rulesOf([]),
      registry: createToolRegistry(catalog),
      connectors: connectors(ENABLED_ALL),
      now: () => NOW,
    }).decide({ ...input, context });
    expect(decision.reasons[0]?.code).toBe("invalid_input");
  });

  it("fails closed when loading rules throws", async () => {
    const onError = vi.fn();
    const e = createPolicyEngine({
      rules: { load: () => Promise.reject(new Error("db down")) },
      now: () => NOW,
      onError,
    });
    const decision = await e.decide(policyInput(builtin("read")));
    expect(decision.effect).toBe("deny");
    expect(decision.reasons[0]?.code).toBe("policy_error");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("fails closed when the registry, connectors or settings throw", async () => {
    const boom = () => Promise.reject(new Error("boom"));
    const cases = [
      { registry: { resolve: boom } },
      { registry: createToolRegistry(catalog), connectors: { get: boom } },
      { settings: { get: boom } },
    ];
    for (const extra of cases) {
      const decision = await createPolicyEngine({
        rules: rulesOf([]),
        now: () => NOW,
        ...extra,
      }).decide(policyInput(extra.connectors ? jiraCreate : builtin("read")));
      expect(decision.effect).toBe("deny");
    }
  });

  it("denies hostile input objects instead of throwing", async () => {
    const hostile = {
      ...policyInput(builtin("read")),
      get input(): never {
        throw new Error("gotcha");
      },
    };
    const decision = await createPolicyEngine({ rules: rulesOf([]), now: () => NOW }).decide(
      hostile as never,
    );
    expect(decision).toMatchObject({ effect: "deny", reasons: [{ code: "invalid_input" }] });
  });

  it("still denies when the error reporter throws", async () => {
    const decision = await createPolicyEngine({
      rules: { load: () => Promise.reject(new Error("db down")) },
      now: () => NOW,
      onError: () => {
        throw new Error("logger down");
      },
    }).decide(policyInput(builtin("read")));
    expect(decision.effect).toBe("deny");
  });

  it("loads rules for the input's team and acting user", async () => {
    const source = rulesOf([]);
    await createPolicyEngine({ rules: source, now: () => NOW }).decide(policyInput(builtin("ls")));
    expect(source.calls).toEqual([[IDS.team, IDS.user, NOW]]);
  });

  it("applies the settings source (prompt sandbox writes)", async () => {
    const decision = await createPolicyEngine({
      rules: rulesOf([]),
      settings: { get: () => Promise.resolve({ promptSandboxWrites: true }) },
      now: () => NOW,
    }).decide(policyInput(builtin("bash"), { command: "ls" }));
    expect(decision.effect).toBe("require_approval");
  });

  it("never returns require_approval in auto mode or for scheduled runs", async () => {
    const e = createPolicyEngine({ rules: rulesOf([rule("install", "ask", "*")]), now: () => NOW });
    for (const options of [{ mode: "auto" as const }, { kind: "schedule" as const }]) {
      const decision = await e.decide(policyInput(builtin("read"), {}, options));
      expect(decision.effect).toBe("deny");
    }
  });

  it("works with an empty rule set", async () => {
    const decision = await createPolicyEngine({
      rules: { load: () => Promise.resolve(EMPTY_RULE_SET) },
    }).decide(policyInput(builtin("grep"), { pattern: "TODO" }));
    expect(decision.effect).toBe("allow");
  });
});

describe("createToolRegistry", () => {
  it("resolves built-ins from the protocol table", async () => {
    await expect(createToolRegistry().resolve(IDS.team, "bash")).resolves.toMatchObject({
      risk: "destructive",
      scope: "sandbox",
    });
  });

  it("never resolves prototype names or unknown tools", async () => {
    const registry = createToolRegistry();
    for (const name of ["toString", "__proto__", "constructor", "BASH", "bash ", ""]) {
      await expect(registry.resolve(IDS.team, name)).resolves.toBeUndefined();
    }
  });

  it("ignores catalog entries that don't describe the requested MCP tool", async () => {
    const liar: McpToolCatalog = {
      resolve: (_t, name) =>
        Promise.resolve(
          name === "mcp__a__x"
            ? { ...jiraCreate, name: "mcp__a__other" }
            : name === "mcp__a__y"
              ? { ...jiraCreate, name: "mcp__a__y", source: "pi" as const }
              : { ...jiraCreate, name, connector_id: undefined as never },
        ),
    };
    const registry = createToolRegistry(liar);
    for (const name of ["mcp__a__x", "mcp__a__y", "mcp__a__z", "evil"]) {
      await expect(registry.resolve(IDS.team, name)).resolves.toBeUndefined();
    }
  });

  it("never lets the catalog shadow a built-in", async () => {
    const shadow: McpToolCatalog = {
      resolve: () => Promise.resolve({ ...jiraCreate, name: "bash", risk: "read" }),
    };
    await expect(createToolRegistry(shadow).resolve(IDS.team, "bash")).resolves.toMatchObject({
      source: "pi",
      risk: "destructive",
    });
  });
});
