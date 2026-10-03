import type { JsonObject, RiskClass, ToolDescriptor } from "@kobe/protocol";

/**
 * Install-level policy switches. Stored in `install_settings` (one row per key), so an install
 * Owner/Admin flips them through `PUT /v1/install/policy/settings` — no code change, no redeploy.
 */
export interface PolicySettings {
  /**
   * In `ask-on-write`, whether
   * sandbox-scoped write/destructive built-ins (bash, powershell, write, edit) are prompted for by
   * risk class. Default `false` — **user decision (Chris, 2026-10-03; KOBE-37 ledger): sandbox tools
   * ask for approval only when a policy rule says so; there is no default prompt for them** (D29:
   * "shell and file tools are bounded by the sandbox and egress policy"). An `ask` rule (install or
   * team) is how a team asks for them; `true` is an install admin's explicit opt-in to prompting
   * every sandbox write. Deny/ask rules and `ask-all` apply either way.
   */
  readonly promptSandboxWrites: boolean;
}

export const DEFAULT_POLICY_SETTINGS: PolicySettings = { promptSandboxWrites: false };

/** `install_settings.key` for {@link PolicySettings.promptSandboxWrites}. */
export const PROMPT_SANDBOX_WRITES_KEY = "policy.ask_on_write.prompt_sandbox_writes";

/**
 * Risk-class prompting in `ask-on-write` (D29), by where the tool's effects land and its risk.
 * `true` = prompt. `sandbox` rows follow {@link PolicySettings.promptSandboxWrites}. `kobe`-scoped
 * writes (artifacts, shared files, memory) prompt — D23/D24 make project writes approval-gated —
 * except personal `remember` (D24: "personal writes via remember need no approval"), recognised by
 * `scope: "personal"` in its input (KOBE-55/56 must define that field; anything else prompts).
 * Only interactive runs use this table; auto mode and scheduled runs don't (evaluate.ts).
 */
export function riskClassPrompts(
  tool: Pick<ToolDescriptor, "name" | "risk" | "scope" | "source">,
  input: JsonObject,
  settings: PolicySettings,
): boolean {
  if (tool.source === "kobe" && tool.name === "remember" && input.scope === "personal") {
    return false;
  }
  const table: Readonly<Record<ToolDescriptor["scope"], Readonly<Record<RiskClass, boolean>>>> = {
    sandbox: {
      read: false,
      write: settings.promptSandboxWrites,
      destructive: settings.promptSandboxWrites,
    },
    kobe: { read: false, write: true, destructive: true },
    external: { read: false, write: true, destructive: true },
  };
  return table[tool.scope][tool.risk];
}
