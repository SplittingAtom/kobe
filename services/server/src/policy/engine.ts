import {
  policyDecisionSchema,
  policyInputSchema,
  riskClassSchema,
  type PolicyDecision,
  type PolicyEngine,
  type PolicyInput,
  type PolicyReason,
  type RiskClass,
  type ToolRegistry,
} from "@kobe/protocol";
import { evaluatePolicy } from "./evaluate.js";
import type { ConnectorPolicyState } from "./gates.js";
import { createToolRegistry } from "./registry.js";
import type { PolicyRuleSet } from "./rules.js";
import { DEFAULT_POLICY_SETTINGS, type PolicySettings } from "./settings.js";

/** Rules for one decision (rule-store.ts reads them from Postgres). */
export interface PolicyRuleSource {
  load(teamId: string, userId: string, now: Date): Promise<PolicyRuleSet>;
}

/** Team connector state (KOBE-58/59). `undefined` = not enabled in that team. */
export interface ConnectorStateSource {
  get(teamId: string, connectorId: string): Promise<ConnectorPolicyState | undefined>;
}

export interface PolicySettingsSource {
  get(): Promise<PolicySettings>;
}

/** Until KOBE-58 lands no connector is enabled anywhere. */
export const NO_CONNECTORS: ConnectorStateSource = { get: () => Promise.resolve(undefined) };

export interface PolicyEngineDeps {
  readonly rules: PolicyRuleSource;
  readonly registry?: ToolRegistry;
  readonly connectors?: ConnectorStateSource;
  readonly settings?: PolicySettingsSource;
  readonly now?: () => Date;
  /** Told about every fail-closed denial caused by an error (never about inputs or secrets). */
  readonly onError?: (error: unknown) => void;
}

function riskOf(raw: unknown): RiskClass {
  const risk = (raw as { tool?: { risk?: unknown } } | null)?.tool?.risk;
  const parsed = riskClassSchema.safeParse(risk);
  // Unknown risk counts as destructive (D29: unannotated = destructive).
  return parsed.success ? parsed.data : "destructive";
}

function deny(risk: RiskClass, reason: PolicyReason): PolicyDecision {
  return { effect: "deny", risk, reasons: [reason] };
}

const INTERNAL_ERROR: PolicyReason = {
  // Before the pipeline (or instead of it): reported at the first stage (protocol policy.ts).
  code: "policy_error",
  stage: "install_deny",
  message: "Policy could not be evaluated, so the call was denied. Try again.",
};

/**
 * The server-side policy engine (D29) implementing the protocol `PolicyEngine`.
 *
 * - Re-validates the input (`policyInputSchema`): anything malformed → deny `invalid_input`.
 * - Re-resolves the tool by name from the server registry and evaluates against **that**
 *   descriptor; the descriptor in the input is not trusted for risk, scope or source. A name the
 *   registry does not know → deny `unknown_tool`.
 * - Loads rules, connector state and settings, then runs the pure pipeline (`evaluatePolicy`).
 * - Fails closed: any error → deny. Never returns `require_approval` for `auto` mode or a
 *   scheduled run (asserted again on the way out).
 */
export function createPolicyEngine(deps: PolicyEngineDeps): PolicyEngine {
  const registry = deps.registry ?? createToolRegistry();
  const connectors = deps.connectors ?? NO_CONNECTORS;
  const settings = deps.settings ?? { get: () => Promise.resolve(DEFAULT_POLICY_SETTINGS) };
  const now = deps.now ?? (() => new Date());

  async function decideParsed(input: PolicyInput, at: Date): Promise<PolicyDecision> {
    const tool = await registry.resolve(input.team_id, input.tool.name);
    if (tool === undefined) {
      // Unknown tools count as destructive (D29: unannotated = destructive + open-world).
      return deny("destructive", {
        code: "unknown_tool",
        stage: "install_deny",
        message: `${input.tool.name.slice(0, 256)} is not a known tool.`,
      });
    }
    const [rules, connector, current] = await Promise.all([
      deps.rules.load(input.team_id, input.actor.user_id, at),
      tool.source === "mcp" && tool.connector_id !== undefined
        ? connectors.get(input.team_id, tool.connector_id)
        : Promise.resolve(undefined),
      settings.get(),
    ]);
    return evaluatePolicy({ input, tool, rules, connector, settings: current, now: at });
  }

  return {
    async decide(raw) {
      let parsed: ReturnType<typeof policyInputSchema.safeParse>;
      try {
        parsed = policyInputSchema.safeParse(raw);
      } catch {
        parsed = { success: false } as never; // hostile objects (throwing getters, proxies)
      }
      if (!parsed.success) {
        return deny(riskOf(raw), {
          code: "invalid_input",
          stage: "install_deny",
          message: "The tool call could not be checked (invalid input), so it was denied.",
        });
      }
      const input = parsed.data;
      try {
        const decision = await decideParsed(input, now());
        const neverPrompt = input.run.approval_mode === "auto" || input.actor.kind === "schedule";
        // Both unreachable by construction; kept as the contract's last line of defence.
        if (decision.effect === "require_approval" && neverPrompt) {
          return { effect: "deny", risk: decision.risk, reasons: decision.reasons };
        }
        if (!policyDecisionSchema.safeParse(decision).success) {
          throw new Error("policy decision failed the contract schema");
        }
        return decision;
      } catch (error) {
        try {
          deps.onError?.(error);
        } catch {
          // Reporting must never turn a denial into an exception.
        }
        return deny(input.tool.risk, INTERNAL_ERROR);
      }
    },
  };
}
